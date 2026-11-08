import {
  TICKS_PER_YEAR, ageAt, tickToYearMonth,
  type Bot, type DecisionNode, type DecisionResolver, type IntelligenceMode,
  type BirthSpec, type CustomBirth, type IntelChange, type WorldConfig, type WorldEvent, type WorldFlags, type WorldStateShape, type WorldSummary, type LifeStage,
} from '@lifegame/schema';
import { Rng } from './rng.js';
import type { DecisionRequest, EraContext, EraPack, LogInput } from './era.js';

export interface ScriptedChoice {
  choice: string;
  by: DecisionResolver;
  /** 校验用：id 对上但主体或类型不同，说明分支已经分歧，不再照搬 */
  botId?: string;
  kind?: string;
  monologue?: string;
  model?: string;
  goal?: string;
  provisional?: boolean;
  key?: string;
}

export interface AnswerExtra {
  goal?: string;
  /** 推测答案：先按它往下走，真答案回来可能被纠正 */
  provisional?: boolean;
  /** 提示词指纹 */
  key?: string;
}

/** 引擎内建的决策类型：阶段反思。答案（monologue）是反思文字 */
export const REFLECT_KIND = '__reflect';
const STAGE_SEQ: LifeStage[] = ['infant', 'child', 'teen', 'youth', 'adult', 'middle', 'senior'];
export type ScriptedChoices = Record<string, ScriptedChoice>;

export interface StepResult {
  tick: number;
  events: WorldEvent[];
  /** 本次新提出、还没有答案的决策 */
  pending: DecisionNode[];
  /** 到期了却还没有答案的决策：世界没有前进，在等它们 */
  blocked: DecisionNode[];
  finished: boolean;
}

interface YearSnapshot {
  tick: number;
  logLength: number;
  json: string;
}

export interface CreateOptions {
  branchId?: string;
}

export class World {
  readonly era: EraPack;
  state: WorldStateShape;
  rng: Rng;
  /** 每年年初的快照（不含日志） */
  snapshots = new Map<number, YearSnapshot>();
  /** 回放时按 id 预置的选择 */
  scripted: ScriptedChoices = {};
  private ctx: EraContext;
  /** 每个人的随机数流（懒加载，存回 bot.rngState） */
  private rngs = new Map<string, Rng>();
  /** 当前上下文用的随机数流 */
  private curRng: Rng;
  private stepEvents: WorldEvent[] = [];
  private stepPending: DecisionNode[] = [];

  private constructor(era: EraPack, state: WorldStateShape) {
    this.era = era;
    this.state = state;
    this.rng = new Rng(state.rngState);
    this.curRng = this.rng;
    this.ctx = this.makeContext();
  }

  // ---------- 构造 ----------

  static create(era: EraPack, config: WorldConfig, opts: CreateOptions = {}): World {
    const state: WorldStateShape = {
      config,
      branchId: opts.branchId ?? 'main',
      tick: 0,
      rngState: new Rng(config.seed).getState(),
      bots: {},
      botOrder: [],
      log: [],
      decisions: {},
      pendingDecisionIds: [],
      openDecisionIds: [],
      provisionalIds: [],
      flags: { reflections: false, inherit: false },
      intelChanges: [],
      births: [],
      eraState: era.initEraState(),
      nextId: 1,
    };
    const world = new World(era, state);
    world.populate();
    world.takeSnapshot();
    return world;
  }

  static restore(era: EraPack, snapshot: YearSnapshot, log: WorldEvent[], scripted: ScriptedChoices = {}): World {
    const state = JSON.parse(snapshot.json) as WorldStateShape;
    state.log = log.slice(0, snapshot.logLength);
    normalize(state);
    const world = new World(era, state);
    world.scripted = scripted;
    world.snapshots.set(snapshot.tick, snapshot);
    // 快照里的决策若有脚本，以脚本为准（还没落地的才有意义）
    for (const id of [...state.openDecisionIds]) {
      const s = scripted[id];
      const n = state.decisions[id];
      if (!s || !n || (s.kind ?? n.kind) !== n.kind) continue;
      if (n.chosen === undefined) world.applyScript(n, s);
      else world.overrideAnswer(id, s.choice, s.by, s.monologue, s.model, { goal: s.goal, provisional: s.provisional, key: s.key });
    }
    return world;
  }

  static fromJSON(era: EraPack, json: string): World {
    const state = JSON.parse(json) as WorldStateShape;
    normalize(state);
    return new World(era, state);
  }

  toJSON(): string {
    this.syncRngs();
    return JSON.stringify(this.state);
  }

  setFlags(flags: Partial<WorldFlags>): void {
    this.state.flags = { ...this.state.flags, ...flags };
  }

  /** 这个人自己的随机数流 */
  rngOf(bot: Bot): Rng {
    let r = this.rngs.get(bot.id);
    if (!r) {
      r = new Rng(bot.rngState ?? this.seedFor(`bot:${bot.id}`));
      this.rngs.set(bot.id, r);
    }
    return r;
  }

  private seedFor(key: string): number {
    let h = 2166136261 ^ this.state.config.seed;
    for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
    return h >>> 0;
  }

  private syncRngs(): void {
    this.state.rngState = this.rng.getState();
    for (const [id, r] of this.rngs) {
      const b = this.state.bots[id];
      if (b) b.rngState = r.getState();
    }
  }

  private populate(): void {
    const { population, birthSpan } = this.state.config;
    for (let i = 0; i < population; i++) {
      // 初始人口在 [0, birthSpan) 年内出生；引擎从 tick 0 开始，出生在未来的 bot 暂不存在
      const birthTick = this.rng.int(0, birthSpan * TICKS_PER_YEAR - 1);
      const bot = this.era.createInitialBot(this.ctx, birthTick);
      this.state.bots[bot.id] = bot;
      this.state.botOrder.push(bot.id);
    }
    // 按出生顺序排列，方便时间长河按出生排 lane
    this.state.botOrder.sort((a, b) => this.state.bots[a].birthTick - this.state.bots[b].birthTick);
  }

  // ---------- 查询 ----------

  get tick(): number {
    return this.state.tick;
  }

  get pending(): DecisionNode[] {
    return this.state.pendingDecisionIds.map((id) => this.state.decisions[id]);
  }

  /** 已经按推测落地、还没被真答案确认的决策 */
  get provisional(): DecisionNode[] {
    return this.state.provisionalIds.map((id) => this.state.decisions[id]);
  }

  get finished(): boolean {
    const { startYear, endYear } = this.state.config;
    return this.state.tick >= (endYear - startYear) * TICKS_PER_YEAR;
  }

  summary(): WorldSummary {
    const { year, month } = tickToYearMonth(this.state.tick, this.state.config.startYear);
    let alive = 0;
    let dead = 0;
    for (const id of this.state.botOrder) {
      const b = this.state.bots[id];
      if (b.birthTick > this.state.tick) continue;
      if (b.deathTick === undefined) alive++;
      else dead++;
    }
    return { tick: this.state.tick, year, month, alive, dead, total: this.state.botOrder.length };
  }

  bot(id: string): Bot | undefined {
    return this.state.bots[id];
  }

  aliveBots(): Bot[] {
    const t = this.state.tick;
    const out: Bot[] = [];
    for (const id of this.state.botOrder) {
      const b = this.state.bots[id];
      if (b.deathTick === undefined && b.birthTick <= t) out.push(b);
    }
    return out;
  }

  // ---------- 推进 ----------

  step(): StepResult {
    if (this.finished) {
      return { tick: this.state.tick, events: this.takeEvents(), pending: [], blocked: [], finished: true };
    }
    const t = this.state.tick;
    // 到期了还没有答案：世界只能等
    const blocked = this.state.openDecisionIds
      .map((id) => this.state.decisions[id])
      .filter((n) => n.dueTick <= t && n.chosen === undefined);
    if (blocked.length) {
      return { tick: t, events: this.takeEvents(), pending: this.takePending(), blocked, finished: false };
    }
    const { year, month } = tickToYearMonth(t, this.state.config.startYear);
    this.ctx.tick = t;
    this.ctx.year = year;
    this.ctx.month = month;

    for (const b of this.state.births) if (b.tick === t && !this.state.bots[b.id]) this.createBorn(b);
    for (const c of this.state.intelChanges) if (c.tick === t) this.applyIntel(c);
    this.curRng = this.rng;
    if (month === 1) this.era.onYear(this.ctx);
    this.applyDue(t);

    // 出生在本 tick 的初始人口
    for (const id of this.state.botOrder) {
      const b = this.state.bots[id];
      if (b.birthTick === t && b.generation === 0) {
        this.log({ type: 'birth', botId: b.id, importance: 8, text: `${b.name}出生于${b.origin.hometown}，${describeOrigin(b)}。` });
      }
    }

    const order = [...this.state.botOrder];
    for (const id of order) {
      const bot = this.state.bots[id];
      if (bot.deathTick !== undefined || bot.birthTick > t) continue;
      // 处理谁就用谁的随机数流
      this.curRng = this.rngOf(bot);
      const lived = t - bot.birthTick;
      if (lived > 0 && lived % TICKS_PER_YEAR === 0) {
        const age = lived / TICKS_PER_YEAR;
        const stage = this.era.stageOf(age);
        if (stage !== bot.stage) {
          const ended = bot.stage;
          bot.stage = stage;
          this.log({ type: 'stage', botId: bot.id, importance: 4, text: `${bot.name}${age}岁，进入${stageName(stage)}。`, data: { stage, age } });
          if (STAGE_SEQ.indexOf(ended) >= 1) this.requestReflection(bot, ended);
        }
        this.era.onBirthday(bot, age, this.ctx);
      }
      if (bot.deathTick !== undefined) continue;
      this.era.onTick(bot, this.ctx);
    }
    this.curRng = this.rng;

    this.state.tick++;
    if (this.state.tick % TICKS_PER_YEAR === 0) this.takeSnapshot();
    return { tick: this.state.tick, events: this.takeEvents(), pending: this.takePending(), blocked: [], finished: this.finished };
  }

  private takeEvents(): WorldEvent[] {
    const e = this.stepEvents;
    this.stepEvents = [];
    return e;
  }

  private takePending(): DecisionNode[] {
    const p = this.stepPending.filter((n) => n.chosen === undefined);
    this.stepPending = [];
    return p;
  }

  /** 按提出顺序落地到期的决策；落地时可能连锁提出新的决策 */
  private applyDue(t: number): void {
    for (let guard = 0; ; guard++) {
      if (guard > 1000) throw new Error(`同一 tick 内落地的决策超过 1000 个，时代包可能有连锁死循环 @${t}`);
      const due = this.state.openDecisionIds
        .map((id) => this.state.decisions[id])
        .filter((n) => n.dueTick <= t && n.chosen !== undefined)
        .sort((a, b) => a.seq - b.seq);
      if (!due.length) return;
      for (const n of due) this.applyDecision(n);
    }
  }

  /** 连续推进直到被未答复的决策挡住、到达目标 tick 或结束 */
  run(untilTick?: number): StepResult[] {
    const out: StepResult[] = [];
    const target = untilTick ?? Infinity;
    while (!this.finished && this.state.tick < target) {
      const r = this.step();
      out.push(r);
      if (r.blocked.length) break;
    }
    return out;
  }

  // ---------- 决策 ----------

  /** 给决策一个答案。它在犹豫期结束（dueTick）时才落地 */
  resolveDecision(id: string, choice: string, by: DecisionResolver, monologue?: string, model?: string, extra: AnswerExtra = {}): void {
    const node = this.state.decisions[id];
    if (!node) throw new Error(`未知决策 ${id}`);
    if (node.chosen !== undefined) return;
    this.setAnswer(node, choice, by, monologue, model, extra);
    this.state.pendingDecisionIds = this.state.pendingDecisionIds.filter((p) => p !== id);
  }

  /** 换掉一个还没落地的答案（推测答案到期前真答案回来了） */
  overrideAnswer(id: string, choice: string, by: DecisionResolver, monologue?: string, model?: string, extra: AnswerExtra = {}): void {
    const node = this.state.decisions[id];
    if (!node || node.applied) return;
    this.setAnswer(node, choice, by, monologue, model, extra);
    this.state.pendingDecisionIds = this.state.pendingDecisionIds.filter((p) => p !== id);
  }

  /** 推测答案就此算数（等太久了） */
  finalize(id: string): void {
    const node = this.state.decisions[id];
    if (!node) return;
    node.provisional = false;
    this.state.provisionalIds = this.state.provisionalIds.filter((p) => p !== id);
  }

  private setAnswer(node: DecisionNode, choice: string, by: DecisionResolver, monologue: string | undefined, model: string | undefined, extra: AnswerExtra): void {
    const opt = node.options.find((o) => o.id === choice) ?? node.options[0];
    node.chosen = opt.id;
    node.resolvedBy = by;
    node.monologue = monologue;
    node.model = model;
    node.goal = extra.goal;
    node.provisional = extra.provisional || undefined;
    if (extra.key !== undefined) node.promptKey = extra.key;
  }

  private applyScript(node: DecisionNode, sc: ScriptedChoice): void {
    this.resolveDecision(node.id, sc.choice, sc.by, sc.monologue, sc.model, { goal: sc.goal, provisional: sc.provisional, key: sc.key });
  }

  private applyDecision(node: DecisionNode): void {
    node.applied = true;
    this.state.openDecisionIds = this.state.openDecisionIds.filter((p) => p !== node.id);
    if (node.provisional) this.state.provisionalIds.push(node.id);
    const bot = this.state.bots[node.botId];
    if (!bot || bot.deathTick !== undefined) return;
    const prev = this.curRng;
    this.curRng = this.rngOf(bot);
    try {
      if (node.kind === REFLECT_KIND) {
        const stage = node.data?.stage as LifeStage;
        if (node.monologue) {
          bot.reflections.push({ stage, tick: this.ctx.tick, text: node.monologue });
          this.log({ type: 'reflection', botId: bot.id, importance: 5, decisionId: node.id, text: `${bot.name}回顾${stageName(stage)}：${node.monologue}`, data: { stage } });
        }
        if (node.goal) bot.goal = node.goal;
        return;
      }
      const opt = node.options.find((o) => o.id === node.chosen) ?? node.options[0];
      this.log({
        type: 'decision', botId: bot.id, importance: 7, decisionId: node.id,
        text: `${node.situation}${bot.name}选择了「${opt.label}」。`,
        data: { kind: node.kind, choice: opt.id, by: node.resolvedBy },
      });
      if (node.goal) bot.goal = node.goal;
      this.era.decisions[node.kind]?.apply(bot, opt.id, this.ctx, node);
    } finally {
      this.curRng = prev;
    }
  }

  /** 从现在（这个月）起改变某人的智能设定，记入时间线，重放时在同一个月生效 */
  setIntelligence(botId: string, mode: IntelligenceMode, model?: string, lead = mode === 'llm'): void {
    if (!this.state.bots[botId]) return;
    const c: IntelChange = { tick: this.state.tick, botId, intelligence: mode, model, lead: mode === 'llm' && lead };
    this.state.intelChanges.push(c);
    this.applyIntel(c);
  }

  /**
   * 投胎：在 birthTick 那个月把一个自己设计的人放进世界（birthTick 不早于现在）。
   * 记入 births 与智能时间线，重放、分叉、存档都会带着他。
   */
  addBirth(spec: BirthSpec, birthTick: number): string {
    if (!this.era.createCustomBot) throw new Error(`${this.era.name}还不支持投胎`);
    if (birthTick < this.state.tick) throw new Error('出生时间不能早于世界当前的时间');
    const id = `u${this.state.births.length + 1}`;
    this.state.births.push({ tick: birthTick, id, spec });
    this.state.intelChanges.push({ tick: birthTick, botId: id, intelligence: spec.intelligence, model: spec.model, lead: spec.intelligence === 'llm' && spec.lead !== false });
    return id;
  }

  private createBorn(b: CustomBirth): void {
    const bot = this.era.createCustomBot!(this.ctx, b.spec, b.tick, b.id);
    this.state.bots[bot.id] = bot;
    this.state.botOrder.push(bot.id);
  }

  /**
   * 投胎到一条新分支：世界退回 branchPoint（不晚于出生），重放到那一刻，再放进这个人。
   * 退回点之前提出的已确认答案照搬；还没答复或只是推测的，留给新分支重新问。
   */
  withBirth(spec: BirthSpec, birthTick: number, branchPoint: number, branchId: string): { world: World; botId: string; fromSeq: number } {
    const at = Math.max(0, Math.min(branchPoint, birthTick));
    let snapTick = Math.floor(at / TICKS_PER_YEAR) * TICKS_PER_YEAR;
    while (snapTick > 0 && !this.snapshots.has(snapTick)) snapTick -= TICKS_PER_YEAR;
    const snap = this.snapshots.get(snapTick);
    if (!snap) throw new Error(`缺少 tick ${snapTick} 的快照`);
    const scripted: ScriptedChoices = {};
    for (const d of Object.values(this.state.decisions)) {
      if (d.chosen !== undefined && !d.provisional && d.tick < at) scripted[d.id] = scriptOf(d);
    }
    const w = World.restore(this.era, snap, this.state.log, scripted);
    const fromSeq = w.state.log.length;
    for (const [t, sn] of this.snapshots) if (t < snapTick) w.snapshots.set(t, sn);
    w.state.branchId = branchId;
    w.state.parentBranchId = this.state.branchId;
    w.state.forkedAtTick = at;
    w.state.flags = { ...this.state.flags };
    w.state.intelChanges = this.state.intelChanges.map((c) => ({ ...c }));
    w.state.births = this.state.births.map((b) => ({ ...b }));
    while (w.tick < at && !w.finished) {
      if (w.step().blocked.length) break;
    }
    w.scripted = {};
    const botId = w.addBirth(spec, Math.max(birthTick, w.tick));
    return { world: w, botId, fromSeq };
  }

  private applyIntel(c: IntelChange): void {
    const bot = this.state.bots[c.botId];
    if (!bot) return;
    bot.intelligence = c.intelligence;
    bot.model = c.model;
    bot.lead = c.intelligence === 'llm' && !!c.lead;
  }

  /**
   * 存档用：能让世界一直重放到 untilTick 的全部非规则答案。
   * 只收提出时间不晚于 untilTick 的（之后的问题可能建立在未确认的推测上）；
   * 主角未确认的推测不收，读档后重新问；已在画面里生效的配角推测当真。
   */
  exportAnswers(untilTick: number): ScriptedChoices {
    const out: ScriptedChoices = {};
    for (const d of Object.values(this.state.decisions)) {
      if (d.chosen === undefined || d.resolvedBy === 'rules' || d.tick > untilTick) continue;
      if (d.provisional && d.dueTick > untilTick) continue;
      out[d.id] = { ...scriptOf(d), provisional: undefined };
    }
    return out;
  }

  /** 读档：从头按原来的配置、智能时间线和答案重放到 untilTick（含） */
  static replay(era: EraPack, save: { config: WorldConfig; flags: WorldFlags; intelChanges: IntelChange[]; births?: CustomBirth[]; answers: ScriptedChoices }, untilTick: number, onStep?: (w: World, events: WorldEvent[]) => void): World {
    const w = World.create(era, save.config);
    w.state.flags = { ...save.flags };
    w.state.intelChanges = save.intelChanges.map((c) => ({ ...c }));
    w.state.births = (save.births ?? []).map((b) => ({ ...b }));
    w.scripted = save.answers;
    while (!w.finished && w.tick <= untilTick) {
      const r = w.step();
      onStep?.(w, r.events);
      if (r.blocked.length) break;
    }
    w.scripted = {};
    return w;
  }

  // ---------- 分叉 ----------

  /**
   * 在某个决策处改选另一项，回放出一条新分支。
   * 从该决策所在年的快照出发，重放到该决策为止，期间非规则决策按原记录照搬。
   */
  fork(decisionId: string, altChoice: string, branchId: string): World {
    const node = this.state.decisions[decisionId];
    if (!node) throw new Error(`未知决策 ${decisionId}`);
    const snapTick = Math.floor(node.tick / TICKS_PER_YEAR) * TICKS_PER_YEAR;
    const snap = this.snapshots.get(snapTick);
    if (!snap) throw new Error(`缺少 tick ${snapTick} 的快照`);
    const scripted: ScriptedChoices = {};
    for (const d of Object.values(this.state.decisions)) {
      if (d.chosen === undefined || d.resolvedBy === 'rules') continue;
      if (d.tick > node.tick || d.id === decisionId) continue;
      // 目标 bot 在改选之后的连锁决策属于旧分支的后果，不照搬
      if (d.botId === node.botId && botSeq(d.id) > botSeq(decisionId)) continue;
      scripted[d.id] = scriptOf(d);
    }
    scripted[decisionId] = { choice: altChoice, by: 'user', monologue: '（分叉：换一条路试试）', botId: node.botId, kind: node.kind };
    const child = World.restore(this.era, snap, this.state.log, scripted);
    for (const [t, sn] of this.snapshots) if (t < snapTick) child.snapshots.set(t, sn);
    child.state.branchId = branchId;
    child.state.parentBranchId = this.state.branchId;
    child.state.forkedAtTick = node.tick;
    child.state.flags = { ...this.state.flags };
    child.state.intelChanges = this.state.intelChanges.map((c) => ({ ...c }));
    child.state.births = this.state.births.map((b) => ({ ...b }));
    // 重放到改选被提出的那个月，之后的世界开始分歧
    while (child.state.tick <= node.tick && !child.finished) {
      if (child.step().blocked.length) break;
    }
    child.scripted = {};
    return child;
  }

  /**
   * 回退到 toTick 所在年的年初重放。toTick 之前提出的决策原样照搬（含规则决策与推测答案），
   * 之后的由驱动层重新答复（能复用的答案由驱动层按提示词指纹复用）。
   * 用于：推测被真答案纠正；在画面之后改变某人的设定。
   */
  rewind(toTick: number): World {
    let snapTick = Math.floor(toTick / TICKS_PER_YEAR) * TICKS_PER_YEAR;
    while (snapTick > 0 && !this.snapshots.has(snapTick)) snapTick -= TICKS_PER_YEAR;
    const snap = this.snapshots.get(snapTick);
    if (!snap) throw new Error(`缺少 tick ${snapTick} 的快照`);
    const scripted: ScriptedChoices = {};
    for (const d of Object.values(this.state.decisions)) {
      if (d.chosen !== undefined && d.tick < toTick) scripted[d.id] = scriptOf(d);
    }
    const w = World.restore(this.era, snap, this.state.log, scripted);
    for (const [t, sn] of this.snapshots) if (t < snapTick) w.snapshots.set(t, sn);
    w.state.branchId = this.state.branchId;
    w.state.parentBranchId = this.state.parentBranchId;
    w.state.forkedAtTick = this.state.forkedAtTick;
    w.state.flags = { ...this.state.flags };
    // 快照之后的设定变化在重放中按原来的时刻生效
    w.state.intelChanges = this.state.intelChanges.map((c) => ({ ...c }));
    w.state.births = this.state.births.map((b) => ({ ...b }));
    return w;
  }

  /** 某人在 atTick 时的样子：取不晚于 atTick 的那个年初快照（模拟领先画面时用，避免剧透） */
  botAt(botId: string, atTick: number): Bot | undefined {
    if (atTick >= this.state.tick - 1) return this.state.bots[botId];
    let key = Math.floor(atTick / TICKS_PER_YEAR) * TICKS_PER_YEAR;
    while (key > 0 && !this.snapshots.has(key)) key -= TICKS_PER_YEAR;
    const snap = this.snapshots.get(key);
    if (!snap) return this.state.bots[botId];
    if (this.snapCache?.json !== snap.json) {
      this.snapCache = { json: snap.json, bots: (JSON.parse(snap.json) as WorldStateShape).bots };
    }
    return this.snapCache.bots[botId];
  }

  private snapCache?: { json: string; bots: Record<string, Bot> };

  /** 回退时第一个快照所在 tick（日志从这里开始会重新生成） */
  snapshotLogLength(tick: number): number {
    return this.snapshots.get(tick)?.logLength ?? 0;
  }

  // ---------- 内部 ----------

  private takeSnapshot(): void {
    this.syncRngs();
    const { log, ...rest } = this.state;
    const json = JSON.stringify({ ...rest, log: [] });
    this.snapshots.set(this.state.tick, { tick: this.state.tick, logLength: log.length, json });
  }

  private log(e: LogInput): WorldEvent {
    const ev: WorldEvent = { ...e, seq: this.state.log.length, tick: e.tick ?? this.state.tick };
    this.state.log.push(ev);
    this.stepEvents.push(ev);
    if (ev.botId && ev.importance >= 3) {
      const b = this.state.bots[ev.botId];
      if (b) b.memory.push({ eventSeq: ev.seq, importance: ev.importance });
    }
    return ev;
  }

  private requestDecision(bot: Bot, req: DecisionRequest): DecisionNode {
    const n = (bot.decisionCount ?? 0) + 1;
    bot.decisionCount = n;
    const id = `${bot.id}:${n}`;
    const t = this.state.tick;
    const delay = Math.max(0, req.deliberation ?? this.era.decisions[req.kind]?.deliberation ?? 1);
    const node: DecisionNode = {
      id, seq: this.state.nextId++, kind: req.kind, tick: t, dueTick: t + delay, botId: bot.id,
      situation: req.situation, options: req.options, data: req.data,
    };
    this.state.decisions[id] = node;
    const sc = this.scripted[id];
    const valid = sc && (sc.kind ?? req.kind) === req.kind ? sc : undefined;
    if ((valid && valid.by === 'rules') || (!valid && bot.intelligence === 'rules')) {
      // 规则决策当场落地；照搬时也要消耗同样的随机数，否则这个人后面的人生会走样
      const opt = this.rngOf(bot).weighted(req.options, (o) => o.weight ?? 1);
      node.dueTick = t;
      this.state.openDecisionIds.push(id);
      this.resolveDecision(id, valid ? valid.choice : opt.id, 'rules');
      this.applyDecision(node);
      return node;
    }
    this.state.openDecisionIds.push(id);
    this.state.pendingDecisionIds.push(id);
    if (valid) this.applyScript(node, valid);
    else this.stepPending.push(node);
    return node;
  }

  /** 智能人格的人生阶段结束：请模型写一段反思，半年内生效 */
  private requestReflection(bot: Bot, ended: LifeStage): void {
    if (!this.state.flags.reflections || bot.intelligence !== 'llm') return;
    this.requestDecision(bot, {
      kind: REFLECT_KIND,
      situation: `${stageName(ended)}结束了。`,
      options: [{ id: 'done', label: '回顾', description: '' }],
      data: { stage: ended },
      deliberation: 6,
    });
  }

  private nextId(prefix: string): string {
    return `${prefix}${this.state.nextId++}`;
  }

  private makeContext(): EraContext {
    const self = this;
    const ym = tickToYearMonth(this.state.tick, this.state.config.startYear);
    return {
      get world() { return self.state; },
      get rng() { return self.curRng; },
      keyedRng: (key) => new Rng(self.seedFor(`key:${key}`)),
      childId: (mother) => `${mother.id}.${mother.childrenIds.length + 1}`,
      tick: this.state.tick,
      year: ym.year,
      month: ym.month,
      age: (bot) => ageAt(bot.birthTick, self.ctx.tick),
      log: (e) => self.log(e),
      alive: () => self.aliveBots(),
      bot: (id) => self.state.bots[id],
      requestDecision: (bot, req) => self.requestDecision(bot, req),
      openDecision: (botId, kind) => self.state.openDecisionIds.some((id) => {
        const n = self.state.decisions[id];
        return n.botId === botId && (!kind || n.kind === kind);
      }),
      addBot: (bot) => {
        // 智能人格的子女继承智能，作为配角
        if (self.state.flags.inherit) {
          const parent = bot.parentIds.map((p) => self.state.bots[p]).find((p) => p?.intelligence === 'llm');
          if (parent) { bot.intelligence = 'llm'; bot.model = parent.model; bot.lead = false; }
        }
        self.state.bots[bot.id] = bot;
        self.state.botOrder.push(bot.id);
        return bot;
      },
      nextId: (prefix) => self.nextId(prefix),
      kill: (bot, cause) => {
        if (bot.deathTick !== undefined) return;
        bot.deathTick = self.ctx.tick;
        bot.deathCause = cause;
        // 还没答复的决定随人而去，免得世界为他等答案
        for (const id of [...self.state.pendingDecisionIds]) {
          const n = self.state.decisions[id];
          if (n.botId === bot.id) self.resolveDecision(id, n.options[0].id, 'auto');
        }
        const age = ageAt(bot.birthTick, self.ctx.tick);
        self.log({ type: 'death', botId: bot.id, importance: 10, text: `${bot.name}${cause}，终年${age}岁。`, data: { cause, age } });
        if (bot.spouseId) {
          const sp = self.state.bots[bot.spouseId];
          if (sp && sp.deathTick === undefined) {
            sp.spouseId = undefined;
            self.log({ type: 'marriage', botId: sp.id, relatedIds: [bot.id], importance: 8, text: `${sp.name}的伴侣${bot.name}去世了。` });
            sp.state.happiness = Math.max(0, sp.state.happiness - 25);
          }
        }
      },
    };
  }
}

function scriptOf(d: DecisionNode): ScriptedChoice {
  return {
    choice: d.chosen!, by: d.resolvedBy!, monologue: d.monologue, model: d.model, botId: d.botId, kind: d.kind,
    goal: d.goal, provisional: d.provisional, key: d.promptKey,
  };
}

/** 决策编号里"第几个决定"的部分 */
function botSeq(id: string): number {
  return Number(id.slice(id.lastIndexOf(':') + 1));
}

function normalize(state: WorldStateShape): void {
  state.openDecisionIds ??= [];
  state.provisionalIds ??= [];
  state.flags ??= { reflections: false, inherit: false };
  state.intelChanges ??= [];
  state.births ??= [];
}

export function stageName(stage: LifeStage): string {
  return {
    infant: '婴幼儿期', child: '童年', teen: '少年', youth: '青年', adult: '成年', middle: '中年', senior: '老年',
  }[stage];
}

function describeOrigin(b: Bot): string {
  const ses = ['赤贫', '贫寒', '普通', '小康', '富裕'][Math.max(0, Math.min(4, b.origin.ses - 1))];
  const region = { rural: '农村', town: '县城', city: '城市', metro: '大城市' }[b.origin.region];
  return `${region}${ses}之家`;
}
