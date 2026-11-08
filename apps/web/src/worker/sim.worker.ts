/// <reference lib="webworker" />
/**
 * 模拟线程。调度逻辑在 @lifegame/llm 的 Director 里（命令行也用它），这里只管：
 * - 节奏：模拟最多领先画面 aheadTicks；
 * - 每个分支一个 Director；
 * - 采样、旁白（只用于展示）和与主线程的消息往来。
 */
import { World, summarize, type BotSummary } from '@lifegame/core';
import { getEra } from '@lifegame/eras';
import { Brain, Director, createProvider, type Provider } from '@lifegame/llm';
import type { WorldEvent } from '@lifegame/schema';
import type { BranchInfo, BrainSettings, MainToWorker, StatSample, WorkerToMain } from '../protocol.js';

interface Branch {
  info: BranchInfo;
  director: Director;
  samples: Map<string, StatSample[]>;
}

const post = (m: WorkerToMain) => (self as unknown as Worker).postMessage(m);

const branches = new Map<string, Branch>();
let activeId = 'main';
let loopRunning = false;
const displayAt = new Map<string, number>();
let aheadTicks = 120;
let brain: Brain | undefined;
let brainSettings: BrainSettings | undefined;
let userControl: string | null = null;
let shownUserWait: string | undefined;

// 主线程或模型答案到来时唤醒循环
let wakeUp: (() => void) | undefined;
function wake(): void {
  const w = wakeUp;
  wakeUp = undefined;
  w?.();
}
function idle(ms: number, extra?: Promise<void>): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(() => { wakeUp = undefined; r(); }, ms);
    wakeUp = () => { clearTimeout(t); r(); };
    extra?.then(() => { clearTimeout(t); wakeUp = undefined; r(); });
  });
}

self.onmessage = (e: MessageEvent<MainToWorker>) => {
  try {
    handle(e.data);
  } catch (err) {
    post({ type: 'error', message: String(err) });
  }
};

const world = (br: Branch) => br.director.world;

function handle(msg: MainToWorker): void {
  switch (msg.type) {
    case 'init': return init(msg.config, msg.brain, msg.heroCount);
    case 'display':
      displayAt.set(msg.branchId, msg.tick);
      aheadTicks = msg.ahead;
      wake();
      return;
    case 'setIntelligence': {
      for (const br of branches.values()) br.director.change((w) => w.setIntelligence(msg.botId, msg.mode, msg.model));
      const br = branches.get(activeId);
      if (br) flush(br, [], true);
      wake();
      return;
    }
    case 'setUserControl': {
      userControl = msg.botId;
      shownUserWait = undefined;
      const br = branches.get(activeId);
      // 掌控开始：退回画面所在位置，让他此后的决定都停下来等你
      if (br) br.director.change(() => undefined);
      wake();
      return;
    }
    case 'resolve': {
      const br = branches.get(msg.branchId);
      if (br) {
        br.director.answerByUser(msg.decisionId, msg.choice);
        shownUserWait = undefined;
        postNextUserWait(br);
        wake();
      }
      return;
    }
    case 'askBrain': {
      const br = branches.get(msg.branchId);
      if (br) {
        br.director.askBrain(msg.decisionId);
        shownUserWait = undefined;
        postNextUserWait(br);
        wake();
      }
      return;
    }
    case 'fork': return fork(msg.decisionId, msg.choice);
    case 'setBrain': {
      setBrain(msg.brain);
      for (const br of branches.values()) br.director.brain = brain!;
      return;
    }
    case 'getBot': {
      const br = branches.get(msg.branchId);
      const bot = br ? world(br).bot(msg.botId) : undefined;
      if (br && bot) {
        const decisions = Object.values(world(br).state.decisions).filter((d) => d.botId === bot.id && d.applied && d.kind !== '__reflect');
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

function makeBranch(info: BranchInfo, w: World, samples = new Map<string, StatSample[]>()): Branch {
  const br = { info, samples } as Branch;
  br.director = new Director(w, brain!, {
    display: () => displayAt.get(info.id) ?? 0,
    ahead: () => aheadTicks,
    userControlled: (botId) => userControl === botId && activeId === info.id,
    onRewind: ({ fromSeq, fromTick }) => {
      for (const [id, arr] of br.samples) br.samples.set(id, arr.filter((s) => s.tick <= fromTick));
      shownUserWait = undefined;
      post({ type: 'rewind', branchId: info.id, fromSeq, fromTick });
    },
    onThinking: (node, on) => post({ type: 'thinking', branchId: info.id, botId: node.botId, kind: node.kind, on }),
    onUserNeeded: () => postNextUserWait(br),
    onError: (message) => post({ type: 'error', message }),
    onStep: (w, events) => {
      if (w.tick % 12 === 0) sampleAll(br, w);
      // 继承了智能的新生儿：写一句命运旁白（只用于展示）
      if ((brainSettings?.level ?? 0) >= 2 && brain) {
        for (const e of events) {
          if (e.type !== 'child' || !e.relatedIds?.[1]) continue;
          const child = w.bot(e.relatedIds[1]);
          if (child?.intelligence === 'llm' && !child.portrait) brain.portrait(w, child).then((p) => { child.portrait = p; }).catch(() => undefined);
        }
      }
    },
  });
  return br;
}

function init(config: Parameters<typeof World.create>[1], settings: BrainSettings, heroCount: number): void {
  for (const br of branches.values()) br.director.abortAll();
  branches.clear();
  displayAt.clear();
  shownUserWait = undefined;
  const era = getEra(config.eraId);
  const w = World.create(era, config);
  w.setFlags({ reflections: settings.level >= 2, inherit: settings.level > 0 });
  setBrain(settings);
  // 主角：按出生顺序等距挑选，兼顾不同出身
  const order = w.state.botOrder;
  const heroes: string[] = [];
  if (settings.level > 0 && heroCount > 0) {
    const step = Math.max(1, Math.floor(order.length / heroCount));
    for (let i = 0; i < order.length && heroes.length < heroCount; i += step) heroes.push(order[i]);
    for (const id of heroes) w.setIntelligence(id, 'llm', settings.defaultModel, true);
  }
  const br = makeBranch({ id: 'main', label: '主线' }, w);
  branches.set('main', br);
  activeId = 'main';
  displayAt.set('main', 0);
  post({
    type: 'ready', branch: br.info, config, bots: allSummaries(w),
    era: { id: era.id, name: era.name, description: era.description, theme: era.theme },
  });
  if (settings.level >= 2 && brain) {
    for (const id of heroes) {
      const bot = w.bot(id)!;
      brain.portrait(w, bot).then((p) => { bot.portrait = p; }).catch(() => undefined);
    }
  }
  void loop();
  wake();
}

function allSummaries(w: World): BotSummary[] {
  return w.state.botOrder
    .map((id) => w.state.bots[id])
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
    const d = br.director;
    d.maintain();
    const target = d.target;
    if (d.world.finished || d.world.tick >= target) {
      // 跑到头或领先够了：仍可能有真答案回来触发纠正
      await idle(40, d.unsettled ? d.whenAnswer(40) : undefined);
      flushIfChanged(br);
      continue;
    }
    const t0 = performance.now();
    const events: WorldEvent[] = [];
    let sentBots = false;
    let blocked = false;
    while (performance.now() - t0 < 12 && !d.world.finished && d.world.tick < target && branches.get(activeId) === br) {
      const r = d.step();
      events.push(...r.events);
      if (!r.advanced) { blocked = true; break; }
      if (d.world.tick % 12 === 0) {
        flush(br, events.splice(0), true);
        sentBots = true;
      }
    }
    if (events.length || blocked) flush(br, events, !sentBots);
    await (blocked ? idle(50, d.whenAnswer(50)) : idle(0));
  }
}

let lastFlushKey = '';
/** 世界停在原地时，纠正可能带来重放事件、改变 frontier：有变化才发 */
function flushIfChanged(br: Branch): void {
  const d = br.director;
  const w = d.world;
  const key = `${br.info.id}|${w.tick}|${d.frontier}|${w.provisional.length}|${w.state.log.length}`;
  if (key === lastFlushKey) return;
  lastFlushKey = key;
  flush(br, d.drain(), true);
}

function postNextUserWait(br: Branch): void {
  const next = br.director.nextUserWait();
  if (!next || next.id === shownUserWait) return;
  shownUserWait = next.id;
  post({ type: 'pending', branchId: br.info.id, node: next, needsUser: true });
}

function flush(br: Branch, events: WorldEvent[], withBots: boolean): void {
  const d = br.director;
  const w = d.world;
  const settled = w.finished && w.provisional.length === 0;
  post({ type: 'tick', branchId: br.info.id, summary: w.summary(), frontier: d.frontier, events, bots: withBots ? allSummaries(w) : undefined, finished: settled });
  for (const e of events) {
    if (e.type === 'decision' && e.decisionId) post({ type: 'decided', branchId: br.info.id, node: w.state.decisions[e.decisionId] });
  }
}

function sampleAll(br: Branch, w: World): void {
  const t = w.tick;
  for (const b of w.aliveBots()) {
    let arr = br.samples.get(b.id);
    if (!arr) { arr = []; br.samples.set(b.id, arr); }
    if (arr.length && arr[arr.length - 1].tick >= t) continue;
    arr.push({ tick: t, health: Math.round(b.state.health), happiness: Math.round(b.state.happiness), netWorth: Math.round(b.state.wealth + (b.state.vars.assets ?? 0) - (b.state.vars.debt ?? 0)) });
  }
}

// ---------- 分叉 ----------

function fork(decisionId: string, choice: string): void {
  const parent = branches.get(activeId);
  if (!parent) return;
  const pw = world(parent);
  const node = pw.state.decisions[decisionId];
  if (!node) return;
  const id = `fork-${branches.size}`;
  const alt = node.options.find((o) => o.id === choice);
  const snapTick = Math.floor(node.tick / 12) * 12;
  const fromSeq = pw.snapshotLogLength(snapTick);
  const child = pw.fork(decisionId, choice, id);
  const samples = new Map<string, StatSample[]>();
  for (const [k, v] of parent.samples) samples.set(k, v.filter((s) => s.tick <= snapTick));
  const info: BranchInfo = { id, parentId: parent.info.id, forkedAtTick: node.tick, label: `分叉：${alt?.label ?? choice}` };
  const br = makeBranch(info, child, samples);
  branches.set(id, br);
  activeId = id;
  displayAt.set(id, displayAt.get(parent.info.id) ?? pw.tick);
  post({ type: 'branch', branch: info, fromSeq });
  flush(br, child.state.log.slice(fromSeq), true);
  wake();
}

export {};
