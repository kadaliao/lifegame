import {
  TICKS_PER_YEAR, ageAt, tickToYearMonth,
  type Bot, type DecisionNode, type DecisionResolver, type IntelligenceMode,
  type WorldConfig, type WorldEvent, type WorldStateShape, type WorldSummary, type LifeStage,
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
}
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
  private stepEvents: WorldEvent[] = [];
  private stepPending: DecisionNode[] = [];

  private constructor(era: EraPack, state: WorldStateShape) {
    this.era = era;
    this.state = state;
    this.rng = new Rng(state.rngState);
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
    state.openDecisionIds ??= [];
    const world = new World(era, state);
    world.scripted = scripted;
    world.snapshots.set(snapshot.tick, snapshot);
    // 快照时还没有答案的决策，若有脚本就填上
    for (const id of [...state.pendingDecisionIds]) {
      const s = scripted[id];
      const n = state.decisions[id];
      if (s && n && (s.botId ?? n.botId) === n.botId && (s.kind ?? n.kind) === n.kind) {
        world.resolveDecision(id, s.choice, s.by, s.monologue, s.model);
      }
    }
    return world;
  }

  static fromJSON(era: EraPack, json: string): World {
    const state = JSON.parse(json) as WorldStateShape;
    return new World(era, state);
  }

  toJSON(): string {
    this.state.rngState = this.rng.getState();
    return JSON.stringify(this.state);
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
      const lived = t - bot.birthTick;
      if (lived > 0 && lived % TICKS_PER_YEAR === 0) {
        const age = lived / TICKS_PER_YEAR;
        const stage = this.era.stageOf(age);
        if (stage !== bot.stage) {
          bot.stage = stage;
          this.log({ type: 'stage', botId: bot.id, importance: 4, text: `${bot.name}${age}岁，进入${stageName(stage)}。`, data: { stage, age } });
        }
        this.era.onBirthday(bot, age, this.ctx);
      }
      if (bot.deathTick !== undefined) continue;
      this.era.onTick(bot, this.ctx);
    }

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
    for (;;) {
      const due = this.state.openDecisionIds
        .map((id) => this.state.decisions[id])
        .filter((n) => n.dueTick <= t && n.chosen !== undefined)
        .sort((a, b) => seqOf(a.id) - seqOf(b.id));
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
  resolveDecision(id: string, choice: string, by: DecisionResolver, monologue?: string, model?: string): void {
    const node = this.state.decisions[id];
    if (!node) throw new Error(`未知决策 ${id}`);
    if (node.chosen !== undefined) return;
    const opt = node.options.find((o) => o.id === choice) ?? node.options[0];
    node.chosen = opt.id;
    node.resolvedBy = by;
    node.monologue = monologue;
    node.model = model;
    this.state.pendingDecisionIds = this.state.pendingDecisionIds.filter((p) => p !== id);
  }

  private applyDecision(node: DecisionNode): void {
    node.applied = true;
    this.state.openDecisionIds = this.state.openDecisionIds.filter((p) => p !== node.id);
    const bot = this.state.bots[node.botId];
    if (!bot || bot.deathTick !== undefined) return;
    const opt = node.options.find((o) => o.id === node.chosen) ?? node.options[0];
    this.log({
      type: 'decision', botId: bot.id, importance: 7, decisionId: node.id,
      text: `${node.situation}${bot.name}选择了「${opt.label}」。`,
      data: { kind: node.kind, choice: opt.id, by: node.resolvedBy },
    });
    this.era.decisions[node.kind]?.apply(bot, opt.id, this.ctx, node);
  }

  setIntelligence(botId: string, mode: IntelligenceMode, model?: string, lead = mode === 'llm'): void {
    const bot = this.state.bots[botId];
    if (!bot) return;
    bot.intelligence = mode;
    bot.model = model;
    bot.lead = mode === 'llm' && lead;
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
      if (d.botId === node.botId && seqOf(d.id) > seqOf(decisionId)) continue;
      scripted[d.id] = scriptOf(d);
    }
    scripted[decisionId] = { choice: altChoice, by: 'user', monologue: '（分叉：换一条路试试）', botId: node.botId, kind: node.kind };
    const child = World.restore(this.era, snap, this.state.log, scripted);
    for (const [t, sn] of this.snapshots) if (t < snapTick) child.snapshots.set(t, sn);
    child.state.branchId = branchId;
    child.state.parentBranchId = this.state.branchId;
    child.state.forkedAtTick = node.tick;
    child.copyIntelligenceFrom(this);
    // 重放到改选被提出的那个月，之后的世界开始分歧
    while (child.state.tick <= node.tick && !child.finished) {
      if (child.step().blocked.length) break;
    }
    child.scripted = {};
    return child;
  }

  /**
   * 回退到 toTick 所在年的年初重放，用于在画面之后改变某人的设定（赋予智能、由用户掌控）。
   * toTick 之前发生的决策原样照搬；之后的模型/用户答案尽量复用，exceptBot 之后的决策重新做。
   */
  rewind(toTick: number, exceptBot?: string): World {
    let snapTick = Math.floor(toTick / TICKS_PER_YEAR) * TICKS_PER_YEAR;
    while (snapTick > 0 && !this.snapshots.has(snapTick)) snapTick -= TICKS_PER_YEAR;
    const snap = this.snapshots.get(snapTick);
    if (!snap) throw new Error(`缺少 tick ${snapTick} 的快照`);
    const scripted: ScriptedChoices = {};
    for (const d of Object.values(this.state.decisions)) {
      if (d.chosen === undefined) continue;
      const history = d.tick < toTick;
      if (!history && (d.resolvedBy === 'rules' || d.botId === exceptBot)) continue;
      scripted[d.id] = scriptOf(d);
    }
    const w = World.restore(this.era, snap, this.state.log, scripted);
    for (const [t, sn] of this.snapshots) if (t < snapTick) w.snapshots.set(t, sn);
    w.state.branchId = this.state.branchId;
    w.state.parentBranchId = this.state.parentBranchId;
    w.state.forkedAtTick = this.state.forkedAtTick;
    w.copyIntelligenceFrom(this);
    return w;
  }

  /** 快照里存的是旧的智能设定，换成现在的 */
  private copyIntelligenceFrom(other: World): void {
    for (const id of this.state.botOrder) {
      const o = other.state.bots[id];
      const b = this.state.bots[id];
      if (o && b) { b.intelligence = o.intelligence; b.model = o.model; b.lead = o.lead; }
    }
  }

  /** 回退时第一个快照所在 tick（日志从这里开始会重新生成） */
  snapshotLogLength(tick: number): number {
    return this.snapshots.get(tick)?.logLength ?? 0;
  }

  // ---------- 内部 ----------

  private takeSnapshot(): void {
    this.state.rngState = this.rng.getState();
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
    const id = this.nextId('d');
    const t = this.state.tick;
    const delay = Math.max(0, req.deliberation ?? this.era.decisions[req.kind]?.deliberation ?? 1);
    const node: DecisionNode = {
      id, kind: req.kind, tick: t, dueTick: t + delay, botId: bot.id,
      situation: req.situation, options: req.options, data: req.data,
    };
    this.state.decisions[id] = node;
    const sc = this.scripted[id];
    const valid = sc && (sc.botId ?? bot.id) === bot.id && (sc.kind ?? req.kind) === req.kind ? sc : undefined;
    if ((valid && valid.by === 'rules') || (!valid && bot.intelligence === 'rules')) {
      // 规则决策当场落地；照搬时也要消耗同样的随机数，否则后面的世界会走样
      const opt = this.rng.weighted(req.options, (o) => o.weight ?? 1);
      node.dueTick = t;
      this.state.openDecisionIds.push(id);
      this.resolveDecision(id, valid ? valid.choice : opt.id, 'rules');
      this.applyDecision(node);
      return node;
    }
    this.state.openDecisionIds.push(id);
    this.state.pendingDecisionIds.push(id);
    if (valid) this.resolveDecision(id, valid.choice, valid.by, valid.monologue, valid.model);
    else this.stepPending.push(node);
    return node;
  }

  private nextId(prefix: string): string {
    return `${prefix}${this.state.nextId++}`;
  }

  private makeContext(): EraContext {
    const self = this;
    const ym = tickToYearMonth(this.state.tick, this.state.config.startYear);
    return {
      get world() { return self.state; },
      get rng() { return self.rng; },
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
        self.state.bots[bot.id] = bot;
        self.state.botOrder.push(bot.id);
        return bot;
      },
      nextId: (prefix) => self.nextId(prefix),
      kill: (bot, cause) => {
        if (bot.deathTick !== undefined) return;
        bot.deathTick = self.ctx.tick;
        bot.deathCause = cause;
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
  return { choice: d.chosen!, by: d.resolvedBy!, monologue: d.monologue, model: d.model, botId: d.botId, kind: d.kind };
}

function seqOf(id: string): number {
  return Number(id.replace(/^\D+/, ''));
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
