/// <reference lib="webworker" />
/**
 * 模拟线程。要点：
 * - 模拟领先画面一段（ahead），模型的思考时间藏在这段缓冲里。
 * - 智能角色提出决策后立刻发请求，世界不停；答案在犹豫期结束时生效。
 *   只有到期了答案还没回来，世界才停下来等。所以很多人同时在想，等待是重叠的，不是累加的。
 * - 画面追上来、世界又为某个答案卡了太久，就按这个人最可能的选择先走下去。
 * - 在画面之后改变某人的设定（赋予智能、由你掌控），会把模拟退回画面所在年份重放。
 */
import { World, summarize, type BotSummary } from '@lifegame/core';
import { getEra } from '@lifegame/eras';
import { Brain, createProvider, type Provider } from '@lifegame/llm';
import type { DecisionNode, LifeStage, WorldEvent } from '@lifegame/schema';
import type { BranchInfo, BrainSettings, MainToWorker, StatSample, WorkerToMain } from '../protocol.js';

interface Branch {
  info: BranchInfo;
  world: World;
  samples: Map<string, StatSample[]>;
}

const post = (m: WorkerToMain) => (self as unknown as Worker).postMessage(m);

/** 画面追上模拟后，为一个答案最多等多久就兜底 */
const FALLBACK_MS = 30_000;
const STAGE_ORDER: LifeStage[] = ['infant', 'child', 'teen', 'youth', 'adult', 'middle', 'senior'];

const branches = new Map<string, Branch>();
let activeId = 'main';
let loopRunning = false;
const displayAt = new Map<string, number>();
let aheadTicks = 72;
let brain: Brain | undefined;
let brainSettings: BrainSettings | undefined;
let userControl: string | null = null;

/** 在路上的模型请求：key = 分支:决策 → 取消开关 */
const inflight = new Map<string, AbortController>();

/** 取消某个分支（或全部）在路上的请求：已经用不上的答案不必再花钱 */
function abortInflight(branchId?: string): void {
  for (const [k, c] of [...inflight]) {
    if (branchId && !k.startsWith(`${branchId}:`)) continue;
    c.abort();
    // 同步删掉：回退后的新世界会复用同样的决策编号
    inflight.delete(k);
  }
}
/** 等用户回答的决策 */
const userWaits = new Map<string, DecisionNode>();
let shownUserKey: string | undefined;
/** 用户点了"让 TA 自己决定"的决策 */
const forceBrain = new Set<string>();
/** 世界为某个答案停下的起始时间（只在画面追上来之后计） */
const blockedSince = new Map<string, number>();

// 有答案回来时立刻唤醒模拟循环
let wakeUp: (() => void) | undefined;
function wake(): void {
  const w = wakeUp;
  wakeUp = undefined;
  w?.();
}
function idle(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(() => { wakeUp = undefined; r(); }, ms);
    wakeUp = () => { clearTimeout(t); r(); };
  });
}

const keyOf = (br: Branch, id: string) => `${br.info.id}:${id}`;

self.onmessage = (e: MessageEvent<MainToWorker>) => {
  try {
    handle(e.data);
  } catch (err) {
    post({ type: 'error', message: String(err) });
  }
};

function handle(msg: MainToWorker): void {
  switch (msg.type) {
    case 'init': return init(msg.config, msg.brain, msg.heroCount);
    case 'display':
      displayAt.set(msg.branchId, msg.tick);
      aheadTicks = msg.ahead;
      wake();
      return;
    case 'setIntelligence': {
      for (const br of branches.values()) {
        rewindIfAhead(br, msg.botId);
        br.world.setIntelligence(msg.botId, msg.mode, msg.model);
      }
      const br = branches.get(activeId);
      if (br) flush(br, [], true);
      wake();
      return;
    }
    case 'setUserControl': {
      const prev = userControl;
      userControl = msg.botId;
      if (msg.botId) {
        const br = branches.get(activeId);
        if (br) rewindIfAhead(br, msg.botId);
      }
      // 不再掌控：把等着用户的决策交还给模型
      if (prev && prev !== msg.botId) {
        for (const [k, n] of userWaits) if (n.botId === prev) { userWaits.delete(k); if (shownUserKey === k) shownUserKey = undefined; }
      }
      wake();
      return;
    }
    case 'resolve': {
      const br = branches.get(msg.branchId);
      const k = br ? keyOf(br, msg.decisionId) : '';
      if (br && userWaits.has(k)) {
        userWaits.delete(k);
        shownUserKey = undefined;
        br.world.resolveDecision(msg.decisionId, msg.choice, 'user');
        postNextUserWait(br);
        wake();
      }
      return;
    }
    case 'askBrain': {
      const br = branches.get(msg.branchId);
      const k = br ? keyOf(br, msg.decisionId) : '';
      if (br && userWaits.has(k)) {
        userWaits.delete(k);
        shownUserKey = undefined;
        forceBrain.add(k);
        dispatch(br);
        postNextUserWait(br);
      }
      return;
    }
    case 'fork': return fork(msg.decisionId, msg.choice);
    case 'setBrain': return setBrain(msg.brain);
    case 'getBot': {
      const br = branches.get(msg.branchId);
      const bot = br?.world.bot(msg.botId);
      if (br && bot) {
        const decisions = Object.values(br.world.state.decisions).filter((d) => d.botId === bot.id && d.applied);
        post({ type: 'bot', branchId: br.info.id, bot, samples: br.samples.get(bot.id) ?? [], decisions });
      }
      return;
    }
    case 'setActiveBranch': {
      if (branches.has(msg.branchId)) {
        activeId = msg.branchId;
        flush(branches.get(activeId)!, [], true);
        wake();
      }
      return;
    }
  }
}

function setBrain(settings: BrainSettings): void {
  brainSettings = settings;
  const providers: Record<string, Provider> = {};
  for (const p of settings.providers) providers[p.id] = createProvider(p);
  const [providerId, ...rest] = settings.defaultModel.split('/');
  brain = new Brain({
    providers,
    defaultModel: { providerId, model: rest.join('/') || 'mock' },
    concurrency: 4,
    onUsage: (usage) => post({ type: 'usage', usage: { ...usage }, queue: brain?.queueDepth ?? 0 }),
  });
}

function init(config: Parameters<typeof World.create>[1], settings: BrainSettings, heroCount: number): void {
  abortInflight();
  branches.clear();
  displayAt.clear();
  inflight.clear();
  userWaits.clear();
  forceBrain.clear();
  blockedSince.clear();
  shownUserKey = undefined;
  const era = getEra(config.eraId);
  const world = World.create(era, config);
  setBrain(settings);
  // 主角：按出生顺序等距挑选，兼顾不同出身
  const order = world.state.botOrder;
  const heroes: string[] = [];
  if (settings.level > 0 && heroCount > 0) {
    const step = Math.max(1, Math.floor(order.length / heroCount));
    for (let i = 0; i < order.length && heroes.length < heroCount; i += step) heroes.push(order[i]);
    for (const id of heroes) world.setIntelligence(id, 'llm', settings.defaultModel);
  }
  const br: Branch = { info: { id: 'main', label: '主线' }, world, samples: new Map() };
  branches.set('main', br);
  activeId = 'main';
  displayAt.set('main', 0);
  post({
    type: 'ready', branch: br.info, config, bots: allSummaries(world),
    era: { id: era.id, name: era.name, description: era.description, theme: era.theme },
  });
  if (settings.level >= 2 && brain) {
    for (const id of heroes) {
      const bot = world.bot(id)!;
      brain.portrait(world, bot).then((p) => { bot.portrait = p; }).catch(() => undefined);
    }
  }
  void loop();
  wake();
}

function allSummaries(world: World): BotSummary[] {
  return world.state.botOrder
    .map((id) => world.state.bots[id])
    .map((b) => {
      const s = summarize(b);
      s.wealth = Math.round(b.state.wealth + (b.state.vars.assets ?? 0) - (b.state.vars.debt ?? 0));
      return s;
    });
}

// ---------- 模拟循环 ----------

async function loop(): Promise<void> {
  if (loopRunning) return;
  loopRunning = true;
  for (;;) {
    const br = branches.get(activeId);
    if (!br) { await idle(60); continue; }
    dispatch(br);
    const target = (displayAt.get(br.info.id) ?? 0) + aheadTicks;
    if (br.world.finished || br.world.tick >= target) { await idle(40); continue; }
    const t0 = performance.now();
    const events: WorldEvent[] = [];
    let sentBots = false;
    let blocked: DecisionNode[] = [];
    while (performance.now() - t0 < 12 && !br.world.finished && br.world.tick < target && branches.get(activeId) === br) {
      const res = br.world.step();
      events.push(...res.events);
      afterStep(br, res.events);
      if (res.pending.length) dispatch(br);
      if (res.blocked.length) { blocked = res.blocked; break; }
      if (br.world.tick % 12 === 0) {
        sampleAll(br);
        flush(br, events.splice(0), true);
        sentBots = true;
      }
    }
    if (events.length || blocked.length) flush(br, events, !sentBots);
    if (blocked.length) {
      fallbackIfStuck(br, blocked);
      await idle(50);
    } else {
      blockedSince.clear();
      await idle(0);
    }
  }
}

/** 给所有还没答案的决策发请求（或交给用户） */
function dispatch(br: Branch): void {
  const world = br.world;
  for (const node of world.pending) {
    const k = keyOf(br, node.id);
    if (inflight.has(k) || userWaits.has(k)) continue;
    if (userControl === node.botId && br.info.id === activeId && !forceBrain.has(k)) {
      userWaits.set(k, node);
      postNextUserWait(br);
      continue;
    }
    const bot = world.bot(node.botId);
    if (!brain || !bot) {
      world.resolveDecision(node.id, favorite(node), 'auto');
      continue;
    }
    const ctl = new AbortController();
    inflight.set(k, ctl);
    post({ type: 'thinking', branchId: br.info.id, botId: node.botId, kind: node.kind, on: true });
    brain.decide(world, node, ctl.signal)
      .then((r) => {
        if (br.world !== world) return; // 期间被回退或重开
        if (r.goal) bot.goal = r.goal;
        world.resolveDecision(node.id, r.choice, 'llm', r.monologue, r.model);
      })
      .catch((err) => {
        if (br.world !== world || ctl.signal.aborted) return;
        post({ type: 'error', message: `${bot.name}的模型请求失败，按性格先选了：${String(err).slice(0, 120)}` });
        world.resolveDecision(node.id, favorite(node), 'auto', '（来不及细想，凭直觉选了）');
      })
      .finally(() => {
        if (inflight.get(k) === ctl) inflight.delete(k);
        forceBrain.delete(k);
        post({ type: 'thinking', branchId: br.info.id, botId: node.botId, kind: node.kind, on: false });
        wake();
      });
  }
}

/** 这个人最可能的选择：规则权重最高的那项（不消耗随机数，保证可重放） */
function favorite(node: DecisionNode): string {
  return node.options.reduce((a, b) => ((b.weight ?? 1) > (a.weight ?? 1) ? b : a)).id;
}

/**
 * 配角：只在缓冲充裕（模拟领先画面超过一半缓冲）时等模型，否则立刻凭直觉，把缓冲留给主角。
 * 主角：画面追上之前的等待用户看不见；追上之后最多再等 FALLBACK_MS。
 */
function fallbackIfStuck(br: Branch, blocked: DecisionNode[]): void {
  const display = displayAt.get(br.info.id) ?? 0;
  const lead = br.world.tick - display;
  const now = performance.now();
  for (const n of blocked) {
    const k = keyOf(br, n.id);
    if (userWaits.has(k)) continue; // 等用户的不兜底
    const bot = br.world.bot(n.botId);
    if (!bot?.lead) {
      if (lead > aheadTicks / 2) continue;
      br.world.resolveDecision(n.id, favorite(n), 'auto', '（来不及细想，凭直觉选了）');
      inflight.get(k)?.abort();
      continue;
    }
    if (lead > 1) continue;
    const since = blockedSince.get(k) ?? now;
    blockedSince.set(k, since);
    if (now - since > FALLBACK_MS) {
      blockedSince.delete(k);
      br.world.resolveDecision(n.id, favorite(n), 'auto', '（想了太久，最后凭直觉选了）');
      inflight.get(k)?.abort();
      post({ type: 'error', message: `${bot.name}的模型答复超时，按性格先选了` });
    }
  }
}

function postNextUserWait(br: Branch): void {
  if (shownUserKey && userWaits.has(shownUserKey)) return;
  let next: [string, DecisionNode] | undefined;
  for (const e of userWaits) {
    if (!e[0].startsWith(`${br.info.id}:`)) continue;
    if (!next || e[1].dueTick < next[1].dueTick) next = e;
  }
  if (next) {
    shownUserKey = next[0];
    post({ type: 'pending', branchId: br.info.id, node: next[1], needsUser: true });
  }
}

function flush(br: Branch, events: WorldEvent[], withBots: boolean): void {
  post({ type: 'tick', branchId: br.info.id, summary: br.world.summary(), events, bots: withBots ? allSummaries(br.world) : undefined, finished: br.world.finished });
  for (const e of events) {
    if (e.type === 'decision' && e.decisionId) post({ type: 'decided', branchId: br.info.id, node: br.world.state.decisions[e.decisionId] });
  }
}

function sampleAll(br: Branch): void {
  const t = br.world.tick;
  for (const b of br.world.aliveBots()) {
    let arr = br.samples.get(b.id);
    if (!arr) { arr = []; br.samples.set(b.id, arr); }
    arr.push({ tick: t, health: Math.round(b.state.health), happiness: Math.round(b.state.happiness), netWorth: Math.round(b.state.wealth + (b.state.vars.assets ?? 0) - (b.state.vars.debt ?? 0)) });
  }
}

/** 阶段反思、主角子女继承智能。反思不挡世界，排在决策后面 */
function afterStep(br: Branch, events: WorldEvent[]): void {
  const level = brainSettings?.level ?? 0;
  const world = br.world;
  for (const e of events) {
    if (e.type === 'child' && e.relatedIds && level > 0) {
      const parent = world.bot(e.botId!);
      const child = world.bot(e.relatedIds[1]);
      if (parent?.intelligence === 'llm' && child && child.intelligence !== 'llm') {
        // 继承来的是配角：问模型，但不让世界为他停下
        world.setIntelligence(child.id, 'llm', parent.model, false);
        if (level >= 2 && brain) brain.portrait(world, child).then((p) => { child.portrait = p; }).catch(() => undefined);
      }
    }
    if (e.type === 'stage' && level >= 2 && brain) {
      const bot = world.bot(e.botId!);
      if (!bot || bot.intelligence !== 'llm') continue;
      const newStage = (e.data?.stage as LifeStage) ?? bot.stage;
      const idx = STAGE_ORDER.indexOf(newStage);
      if (idx <= 1) continue;
      const ended = STAGE_ORDER[idx - 1];
      const tick = e.tick;
      brain.reflect(world, bot, ended).then((r) => {
        if (br.world !== world) return;
        bot.reflections.push({ stage: ended, tick, text: r.reflection });
        if (r.goal) bot.goal = r.goal;
        post({ type: 'reflection', branchId: br.info.id, botId: bot.id, stage: ended, text: r.reflection });
      }).catch((err) => post({ type: 'error', message: `反思失败：${String(err).slice(0, 120)}` }));
    }
  }
}

// ---------- 回退与分叉 ----------

/** 模拟领先画面时，退回画面所在年份重放，让 botId 之后的决定按新设定重新做 */
function rewindIfAhead(br: Branch, botId: string): void {
  const display = displayAt.get(br.info.id) ?? 0;
  if (br.world.tick <= display + 1) return;
  const old = br.world;
  const w = old.rewind(display, botId);
  // 旧世界里还没回来的请求作废；新世界会按需重新发（能复用的答案已经照搬）
  abortInflight(br.info.id);
  // 旁白和反思不在快照里的，从旧世界补回来
  for (const id of w.state.botOrder) {
    const o = old.bot(id);
    const b = w.bot(id);
    if (o && b && !b.portrait && o.portrait) b.portrait = o.portrait;
  }
  br.world = w;
  const fromTick = w.tick;
  for (const [id, arr] of br.samples) br.samples.set(id, arr.filter((s) => s.tick <= fromTick));
  for (const k of [...userWaits.keys()]) if (k.startsWith(`${br.info.id}:`)) userWaits.delete(k);
  shownUserKey = undefined;
  blockedSince.clear();
  post({ type: 'rewind', branchId: br.info.id, fromSeq: w.state.log.length, fromTick });
  flush(br, [], true);
}

function fork(decisionId: string, choice: string): void {
  const parent = branches.get(activeId);
  if (!parent) return;
  const node = parent.world.state.decisions[decisionId];
  if (!node) return;
  const id = `fork-${branches.size}`;
  const alt = node.options.find((o) => o.id === choice);
  const snapTick = Math.floor(node.tick / 12) * 12;
  const fromSeq = parent.world.snapshotLogLength(snapTick);
  const child = parent.world.fork(decisionId, choice, id);
  const samples = new Map<string, StatSample[]>();
  for (const [k, v] of parent.samples) samples.set(k, v.filter((s) => s.tick <= snapTick));
  const info: BranchInfo = { id, parentId: parent.info.id, forkedAtTick: node.tick, label: `分叉：${alt?.label ?? choice}` };
  const br: Branch = { info, world: child, samples };
  branches.set(id, br);
  activeId = id;
  displayAt.set(id, displayAt.get(parent.info.id) ?? parent.world.tick);
  post({ type: 'branch', branch: info, fromSeq });
  flush(br, child.state.log.slice(fromSeq), true);
  wake();
}

export {};
