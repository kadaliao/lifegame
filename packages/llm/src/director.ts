/**
 * 导演：在一个世界上调度模型。网页和命令行共用。
 *
 * - 决策一提出就准备好提示词并发请求，世界继续走；答案在犹豫期结束时生效。
 * - 到期了答案还没回来：
 *     缓冲充裕（模拟领先画面超过一半）→ 等，用户看不见；
 *     否则主角 → 先按最可能的选择推测着往下走（provisional），真答案回来再纠正；
 *         配角和反思 → 凭直觉/略过，不再等。
 * - 纠正 = 退回那一刻重放。别人的答案只在提示词指纹完全相同时才复用，
 *   所以最终的世界和一个个老实等出来的世界逐字相同。
 * - 画面最多播到 frontier：第一个未确认的推测之前，用户永远看不到会被撤回的内容。
 */
import { REFLECT_KIND, type World } from '@lifegame/core';
import type { DecisionNode, WorldEvent } from '@lifegame/schema';
import type { Brain, NodeAnswer, Prepared } from './brain.js';
import { LlmHttpError } from './provider.js';
import { isAbort } from './scheduler.js';

export interface DirectorHooks {
  /** 画面播到的 tick。批量运行没有画面时返回 -Infinity：永远等模型，从不推测 */
  display(): number;
  /** 模拟最多领先画面多少 tick */
  ahead(): number;
  /** 这个人是否由用户亲自掌控 */
  userControlled?(botId: string): boolean;
  onRewind?(info: { fromSeq: number; fromTick: number }): void;
  onThinking?(node: DecisionNode, on: boolean): void;
  onUserNeeded?(node: DecisionNode): void;
  onError?(message: string): void;
  /** 每推进一步都会调用（含纠正后的重放），用于采样 */
  onStep?(world: World, events: WorldEvent[]): void;
}

export interface DirectorStats {
  requests: number;
  reused: number;
  provisional: number;
  corrections: number;
  rewinds: number;
  fallbacks: number;
}

/** 画面追上第一个推测后，最多再等多久就把推测当真 */
export const LEAD_FALLBACK_MS = 30_000;
/** 有推测时，模拟最多跑到第一个推测之后多少 tick：只为提前发出后面几个人的请求，跑太远只会多做多错 */
export const SPECULATE_TICKS = 120;
/** 真答案回来后攒一会儿再纠正，同时回来的几个合并成一次回退 */
const CORRECT_DELAY_MS = 120;

const DEBUG = typeof process !== 'undefined' && !!process.env?.LIFEGAME_DEBUG;
const dbg = (s: string) => { if (DEBUG) process.stderr.write(`  · ${s}\n`); };

export class Director {
  readonly stats: DirectorStats = { requests: 0, reused: 0, provisional: 0, corrections: 0, rewinds: 0, fallbacks: 0 };
  /** 收到的真答案：决策编号 → 答案（含指纹） */
  private answers = new Map<string, NodeAnswer & { key: string }>();
  private preps = new Map<string, { world: World; prep: Prepared }>();
  private inflight = new Map<string, { key: string; ctl: AbortController }>();
  private userWaits = new Map<string, DecisionNode>();
  private forceBrain = new Set<string>();
  private stuckSince = new Map<string, number>();
  /** 纠正重放产生的事件，随下一次 step 交出 */
  private carried: WorldEvent[] = [];
  private waiters: Array<() => void> = [];
  /** 已知推测错了的最早生效点：模拟不再越过它 */
  private wrongDue = Infinity;
  private correctTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(public world: World, public brain: Brain, private hooks: DirectorHooks) {}

  /** 主角的推测（挡画面）；配角的推测不挡画面，画面一到就当真 */
  private isLead(n: DecisionNode): boolean {
    return n.kind !== REFLECT_KIND && !!this.world.bot(n.botId)?.lead;
  }

  /** 画面最多能播到的 tick：不越过任何还没确认的主角推测 */
  get frontier(): number {
    let f = this.world.tick;
    for (const n of this.world.provisional) if (this.isLead(n)) f = Math.min(f, n.dueTick - 1);
    return f;
  }

  /**
   * 模拟这次最多推进到哪个 tick（不含）：
   * 领先画面不超过 ahead；有推测时不超过第一个推测之后 SPECULATE_TICKS；已知推测错了就停在那里等纠正。
   */
  get target(): number {
    const display = this.hooks.display();
    let t = Number.isFinite(display) ? display + this.hooks.ahead() : Infinity;
    const prov = this.world.provisional.filter((n) => this.isLead(n));
    if (prov.length) t = Math.min(t, Math.min(...prov.map((n) => n.dueTick)) + SPECULATE_TICKS);
    return Math.min(t, this.wrongDue);
  }

  /** 还有没尘埃落定的事：推测未确认、请求在路上、问题没有答案 */
  get unsettled(): boolean {
    return this.world.provisional.length > 0 || this.inflight.size > 0 || this.world.pending.length > 0 || this.correctTimer !== undefined;
  }

  get inflightCount(): number {
    return this.inflight.size;
  }

  /** 等到有答案回来（或超时） */
  whenAnswer(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(t); resolve(); };
      const t = setTimeout(() => { this.waiters = this.waiters.filter((w) => w !== done); resolve(); }, ms);
      this.waiters.push(done);
    });
  }

  private wake(): void {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w();
  }

  /** 推进一步。advanced=false 表示被挡住了（在等答案） */
  step(): { events: WorldEvent[]; advanced: boolean } {
    this.dispatch();
    const res = this.world.step();
    const events = this.carried.length ? this.carried.concat(res.events) : res.events;
    this.carried = [];
    this.hooks.onStep?.(this.world, res.events);
    if (res.pending.length) this.dispatch();
    if (res.blocked.length) {
      this.handleBlocked(res.blocked);
      return { events, advanced: false };
    }
    return { events, advanced: true };
  }

  /** 取出纠正重放攒下的事件，不推进世界 */
  drain(): WorldEvent[] {
    const e = this.carried;
    this.carried = [];
    return e;
  }

  /** 定期调用：画面追上推测太久，就把推测当真 */
  maintain(now = Date.now()): void {
    const display = this.hooks.display();
    let changed = false;
    for (const n of this.world.provisional) {
      if (display < n.dueTick - 1) { this.stuckSince.delete(n.id); continue; }
      if (!this.isLead(n)) {
        // 配角：画面已经到了，凭直觉的选择就此算数，还在排队的请求撤掉
        this.world.finalize(n.id);
        this.inflight.get(n.id)?.ctl.abort();
        this.stats.fallbacks++;
        changed = true;
        continue;
      }
      const since = this.stuckSince.get(n.id) ?? now;
      this.stuckSince.set(n.id, since);
      if (now - since > LEAD_FALLBACK_MS) {
        this.world.finalize(n.id);
        this.inflight.get(n.id)?.ctl.abort();
        this.stuckSince.delete(n.id);
        this.stats.fallbacks++;
        this.hooks.onError?.(`${this.world.bot(n.botId)?.name ?? ''}的模型答复超时，按性格先选了`);
        changed = true;
      }
    }
    if (changed) this.wake();
  }

  // ---------- 用户 ----------

  answerByUser(id: string, choice: string): void {
    if (!this.userWaits.delete(id)) return;
    this.world.resolveDecision(id, choice, 'user', undefined, undefined, { key: this.world.state.decisions[id]?.promptKey });
    this.wake();
  }

  askBrain(id: string): void {
    if (!this.userWaits.delete(id)) return;
    this.forceBrain.add(id);
    this.dispatch();
  }

  /** 最早到期的、等用户回答的决策 */
  nextUserWait(): DecisionNode | undefined {
    let next: DecisionNode | undefined;
    for (const n of this.userWaits.values()) if (!next || n.dueTick < next.dueTick) next = n;
    return next;
  }

  /** 在画面之后改变某人的设定：退回画面所在位置重放，让此后的决定按新设定重新做 */
  change(apply: (w: World) => void): void {
    const display = this.hooks.display();
    if (Number.isFinite(display) && this.world.tick > display + 1) this.rewind(Math.max(0, display + 1));
    apply(this.world);
    this.userWaits.clear();
    this.wake();
  }

  abortAll(): void {
    for (const { ctl } of this.inflight.values()) ctl.abort();
    this.inflight.clear();
    if (this.correctTimer) clearTimeout(this.correctTimer);
    this.correctTimer = undefined;
  }

  // ---------- 内部 ----------

  private dispatch(): void {
    const world = this.world;
    for (const node of world.pending) {
      if (this.userWaits.has(node.id)) continue;
      // 指纹在第一次见到时确定：这就是"提出那一刻"的提示词
      let entry = this.preps.get(node.id);
      if (!entry || entry.world !== world || node.promptKey === undefined) {
        const prep = this.brain.prepare(world, node);
        if (node.promptKey === undefined) node.promptKey = prep.key;
        entry = { world, prep };
        this.preps.set(node.id, entry);
      }
      const key = node.promptKey;
      if (this.hooks.userControlled?.(node.botId) && node.kind !== REFLECT_KIND && !this.forceBrain.has(node.id)) {
        this.userWaits.set(node.id, node);
        this.hooks.onUserNeeded?.(node);
        continue;
      }
      const cached = this.answers.get(node.id);
      if (cached && cached.key === key) {
        this.apply(node, cached);
        this.stats.reused++;
        continue;
      }
      const inf = this.inflight.get(node.id);
      if (inf && inf.key === key) continue;
      inf?.ctl.abort();
      this.request(node, entry.prep, key);
    }
  }

  private request(node: DecisionNode, prep: Prepared, key: string): void {
    const ctl = new AbortController();
    this.inflight.set(node.id, { key, ctl });
    this.stats.requests++;
    this.hooks.onThinking?.(node, true);
    prep.run(ctl.signal)
      .then((a) => {
        this.answers.set(node.id, { ...a, key });
        this.receive(node.id);
      })
      .catch((err) => {
        if (ctl.signal.aborted || isAbort(err)) return;
        const cur = this.world.state.decisions[node.id];
        const name = this.world.bot(node.botId)?.name ?? '';
        // 额度用完由 Brain 统一报一次，这里不再逐条提示
        if (!(err instanceof LlmHttpError && err.quota)) this.hooks.onError?.(`${name}的模型请求失败，按性格先选了：${String(err).slice(0, 120)}`);
        if (cur && cur.promptKey === key && cur.chosen === undefined) {
          this.world.resolveDecision(node.id, favorite(cur), 'auto', undefined, undefined, { key });
        } else if (cur && cur.promptKey === key && cur.provisional) {
          // 已经按最可能的选择推测着走了：就此定下，别让画面停在这里干等到超时
          this.world.finalize(node.id);
          this.stuckSince.delete(node.id);
          this.stats.fallbacks++;
        }
      })
      .finally(() => {
        if (this.inflight.get(node.id)?.ctl === ctl) this.inflight.delete(node.id);
        this.forceBrain.delete(node.id);
        this.hooks.onThinking?.(node, false);
        this.wake();
      });
  }

  private apply(node: DecisionNode, a: NodeAnswer & { key: string }): void {
    this.world.resolveDecision(node.id, a.choice, 'llm', a.monologue, a.model, { goal: a.goal, key: a.key });
  }

  /** 真答案到了 */
  private receive(id: string): void {
    const a = this.answers.get(id)!;
    const node = this.world.state.decisions[id];
    // 当前世界里没有这个问题，或问法变了：留在缓存里，重放到这里时再看
    if (!node || node.promptKey !== a.key) return;
    if (node.chosen === undefined) { this.apply(node, a); return; }
    if (!node.provisional) return; // 已经凭直觉定下了
    if (!node.applied) {
      this.world.overrideAnswer(id, a.choice, 'llm', a.monologue, a.model, { goal: a.goal, key: a.key });
      return;
    }
    // 推测已经落地而且是错的：模拟停在这里，攒一会儿一起纠正
    this.wrongDue = Math.min(this.wrongDue, node.dueTick);
    this.correctTimer ??= setTimeout(() => {
      this.correctTimer = undefined;
      this.wrongDue = Infinity;
      this.correct();
      this.wake();
    }, CORRECT_DELAY_MS);
  }

  /** 把所有已收到真答案的推测一起纠正：退回最早那个生效的时刻重放 */
  private correct(): void {
    const fixes = this.world.provisional.filter((n) => this.answers.get(n.id)?.key === n.promptKey);
    if (!fixes.length) return;
    for (const n of fixes) {
      const a = this.answers.get(n.id)!;
      n.chosen = n.options.find((o) => o.id === a.choice)?.id ?? n.chosen;
      n.resolvedBy = 'llm';
      n.monologue = a.monologue;
      n.model = a.model;
      n.goal = a.goal;
      n.provisional = undefined;
    }
    this.stats.corrections += fixes.length;
    this.rewind(Math.min(...fixes.map((n) => n.dueTick)));
  }

  private rewind(toTick: number): void {
    const t0 = Date.now();
    dbg(`rewind 开始 to=${toTick} 世界=${this.world.tick} 画面=${this.hooks.display()}`);
    const old = this.world;
    const w = old.rewind(toTick);
    // 命运旁白只用于展示，不在快照里的从旧世界补回
    for (const id of w.state.botOrder) {
      const o = old.state.bots[id];
      const b = w.state.bots[id];
      if (o && b && !b.portrait && o.portrait) b.portrait = o.portrait;
    }
    this.world = w;
    // 准备好的提示词引用着旧世界，不清掉的话旧世界（连同几十 MB 快照）永远释放不了
    this.preps.clear();
    this.userWaits.clear();
    this.stuckSince.clear();
    this.stats.rewinds++;
    this.hooks.onRewind?.({ fromSeq: w.state.log.length, fromTick: w.tick });
    // 重放到画面所在位置（这段历史全部照搬，不会被挡住），避免画面闪回
    const display = Math.min(this.hooks.display(), toTick - 1);
    const acc: WorldEvent[] = [];
    while (w.tick <= display && !w.finished && this.world === w) {
      const r = this.step();
      acc.push(...r.events);
      if (!r.advanced) break;
    }
    this.carried = acc.concat(this.carried);
    dbg(`rewind 结束 世界=${this.world.tick} 用时 ${Date.now() - t0}ms`);
    this.wake();
  }

  private handleBlocked(blocked: DecisionNode[]): void {
    const display = this.hooks.display();
    // 没有画面（批量运行），或缓冲充裕：继续等，用户看不见
    if (!Number.isFinite(display) || this.world.tick - display > this.hooks.ahead() / 2) return;
    for (const n of blocked) {
      if (this.userWaits.has(n.id) || n.chosen !== undefined) continue;
      // 先按最可能的选择往下走。主角的推测挡画面，真答案回来再纠正；
      // 配角和反思的推测不挡画面，答案赶在画面到达之前回来就纠正，赶不上就作罢
      const mono = n.kind === REFLECT_KIND || this.isLead(n) ? undefined : '（来不及细想，凭直觉选了）';
      this.world.resolveDecision(n.id, favorite(n), 'auto', mono, undefined, { provisional: true, key: n.promptKey });
      this.stats.provisional++;
    }
  }
}

/** 这个人最可能的选择：规则权重最高的那项（不消耗随机数） */
export function favorite(node: DecisionNode): string {
  return node.options.reduce((a, b) => ((b.weight ?? 1) > (a.weight ?? 1) ? b : a)).id;
}
