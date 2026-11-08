/// <reference lib="webworker" />
import { World, summarize, type BotSummary } from '@lifegame/core';
import { getEra } from '@lifegame/eras';
import { Brain, createProvider, type Provider } from '@lifegame/llm';
import type { Bot, DecisionNode, LifeStage, WorldEvent } from '@lifegame/schema';
import type { BranchInfo, BrainSettings, MainToWorker, StatSample, WorkerToMain } from '../protocol.js';

interface Branch {
  info: BranchInfo;
  world: World;
  samples: Map<string, StatSample[]>;
}

const post = (m: WorkerToMain) => (self as unknown as Worker).postMessage(m);

const branches = new Map<string, Branch>();
let activeId = 'main';
let playing = false;
let loopRunning = false;
let ticksPerSecond = 24;
let brain: Brain | undefined;
let brainSettings: BrainSettings | undefined;
let userControl: string | null = null;
let waitingUser: { branchId: string; decisionId: string; resolve: (v: { choice: string; by: 'user' | 'llm'; monologue?: string; model?: string }) => void } | undefined;
let catchUpTarget: number | undefined;

const STAGE_ORDER: LifeStage[] = ['infant', 'child', 'teen', 'youth', 'adult', 'middle', 'senior'];

self.onmessage = (e: MessageEvent<MainToWorker>) => {
  const msg = e.data;
  try {
    handle(msg);
  } catch (err) {
    post({ type: 'error', message: String(err) });
  }
};

function handle(msg: MainToWorker): void {
  switch (msg.type) {
    case 'init': return init(msg.config, msg.brain, msg.heroCount);
    case 'play': playing = true; post({ type: 'playing', playing: true }); void loop(); return;
    case 'pause': playing = false; post({ type: 'playing', playing: false }); return;
    case 'speed': ticksPerSecond = msg.ticksPerSecond; return;
    case 'setIntelligence': {
      for (const b of branches.values()) b.world.setIntelligence(msg.botId, msg.mode, msg.model);
      const br = branches.get(activeId);
      if (br) post({ type: 'tick', branchId: br.info.id, summary: br.world.summary(), events: [], bots: allSummaries(br.world), finished: br.world.finished });
      return;
    }
    case 'setUserControl': userControl = msg.botId; return;
    case 'resolve': {
      if (waitingUser && waitingUser.decisionId === msg.decisionId) {
        const w = waitingUser; waitingUser = undefined;
        w.resolve({ choice: msg.choice, by: 'user' });
      }
      return;
    }
    case 'askBrain': {
      if (waitingUser && waitingUser.decisionId === msg.decisionId) {
        const br = branches.get(msg.branchId);
        const node = br?.world.state.decisions[msg.decisionId];
        if (br && node && brain) {
          const w = waitingUser; waitingUser = undefined;
          post({ type: 'thinking', branchId: br.info.id, botId: node.botId, kind: node.kind, on: true });
          brain.decide(br.world, node)
            .then((r) => w.resolve({ choice: r.choice, by: 'llm', monologue: r.monologue, model: r.model }))
            .catch((err) => { post({ type: 'error', message: `模型调用失败：${String(err)}` }); w.resolve({ choice: node.options[0].id, by: 'user' }); })
            .finally(() => post({ type: 'thinking', branchId: br.info.id, botId: node.botId, kind: node.kind, on: false }));
        }
      }
      return;
    }
    case 'fork': return fork(msg.decisionId, msg.choice);
    case 'setBrain': return setBrain(msg.brain);
    case 'getBot': {
      const br = branches.get(msg.branchId);
      const bot = br?.world.bot(msg.botId);
      if (br && bot) {
        const decisions = Object.values(br.world.state.decisions).filter((d) => d.botId === bot.id);
        post({ type: 'bot', branchId: br.info.id, bot, samples: br.samples.get(bot.id) ?? [], decisions });
      }
      return;
    }
    case 'setActiveBranch': {
      if (branches.has(msg.branchId)) {
        activeId = msg.branchId;
        const br = branches.get(activeId)!;
        post({ type: 'tick', branchId: br.info.id, summary: br.world.summary(), events: [], bots: allSummaries(br.world), finished: br.world.finished });
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
    onUsage: (usage) => post({ type: 'usage', usage: { ...usage } }),
  });
}

function init(config: Parameters<typeof World.create>[1], settings: BrainSettings, heroCount: number): void {
  playing = false;
  branches.clear();
  waitingUser = undefined;
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
  post({
    type: 'ready', branch: br.info, config, bots: allSummaries(world),
    era: { id: era.id, name: era.name, description: era.description, theme: era.theme },
  });
  // 主角的命运旁白
  if (settings.level >= 2 && brain) {
    for (const id of heroes) {
      const bot = world.bot(id)!;
      brain.portrait(world, bot).then((p) => { bot.portrait = p; }).catch(() => undefined);
    }
  }
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

async function loop(): Promise<void> {
  if (loopRunning) return;
  loopRunning = true;
  try {
    while (playing) {
      const br = branches.get(activeId);
      if (!br) break;
      const frameMs = 1000 / 30;
      const perFrame = Number.isFinite(ticksPerSecond) ? Math.max(1, Math.round(ticksPerSecond / 30)) : 10_000;
      const t0 = performance.now();
      let count = 0;
      const events: WorldEvent[] = [];
      let sentBots = false;
      while (playing && count < perFrame && performance.now() - t0 < 14) {
        if (br.world.finished) { playing = false; post({ type: 'playing', playing: false }); break; }
        if (catchUpTarget !== undefined && br.world.tick >= catchUpTarget) {
          catchUpTarget = undefined;
          playing = false;
          post({ type: 'playing', playing: false });
          break;
        }
        const res = br.world.step();
        count++;
        events.push(...res.events);
        afterStep(br, res.events);
        if (br.world.tick % 12 === 0) {
          sampleAll(br);
          flush(br, events.splice(0), true);
          sentBots = true;
        }
        if (res.pending.length) {
          flush(br, events.splice(0), !sentBots);
          await handlePending(br);
        }
      }
      if (events.length) flush(br, events, !sentBots);
      if (!Number.isFinite(ticksPerSecond)) await sleep(0);
      else {
        const elapsed = performance.now() - t0;
        await sleep(Math.max(0, frameMs - elapsed));
      }
    }
  } finally {
    loopRunning = false;
  }
}

function flush(br: Branch, events: WorldEvent[], withBots: boolean): void {
  post({ type: 'tick', branchId: br.info.id, summary: br.world.summary(), events, bots: withBots ? allSummaries(br.world) : undefined, finished: br.world.finished });
}

function sampleAll(br: Branch): void {
  const t = br.world.tick;
  for (const b of br.world.aliveBots()) {
    let arr = br.samples.get(b.id);
    if (!arr) { arr = []; br.samples.set(b.id, arr); }
    arr.push({ tick: t, health: Math.round(b.state.health), happiness: Math.round(b.state.happiness), netWorth: Math.round(b.state.wealth + (b.state.vars.assets ?? 0) - (b.state.vars.debt ?? 0)) });
  }
}

/** 阶段反思、主角子女继承智能 */
function afterStep(br: Branch, events: WorldEvent[]): void {
  const level = brainSettings?.level ?? 0;
  for (const e of events) {
    if (e.type === 'child' && e.relatedIds && level > 0) {
      const parent = br.world.bot(e.botId!);
      const child = br.world.bot(e.relatedIds[1]);
      if (parent?.intelligence === 'llm' && child && child.intelligence !== 'llm') {
        child.intelligence = 'llm';
        child.model = parent.model;
        if (level >= 2 && brain) brain.portrait(br.world, child).then((p) => { child.portrait = p; }).catch(() => undefined);
      }
    }
    if (e.type === 'stage' && level >= 2 && brain) {
      const bot = br.world.bot(e.botId!);
      if (!bot || bot.intelligence !== 'llm') continue;
      const newStage = (e.data?.stage as LifeStage) ?? bot.stage;
      const idx = STAGE_ORDER.indexOf(newStage);
      if (idx <= 1) continue; // 婴儿→童年不反思
      const ended = STAGE_ORDER[idx - 1];
      const world = br.world;
      const tick = e.tick;
      brain.reflect(world, bot, ended).then((r) => {
        bot.reflections.push({ stage: ended, tick, text: r.reflection });
        if (r.goal) bot.goal = r.goal;
        post({ type: 'reflection', branchId: br.info.id, botId: bot.id, stage: ended, text: r.reflection });
      }).catch((err) => post({ type: 'error', message: `反思失败：${String(err)}` }));
    }
  }
}

async function handlePending(br: Branch): Promise<void> {
  const pending = [...br.world.pending];
  const results: Array<{ node: DecisionNode; choice: string; by: 'user' | 'llm' | 'rules'; monologue?: string; model?: string }> = [];
  // 非用户控制的并行问模型，用户控制的逐个等待
  const auto = pending.filter((n) => !(userControl === n.botId && br.info.id === activeId));
  const manual = pending.filter((n) => userControl === n.botId && br.info.id === activeId);
  for (const n of auto) post({ type: 'pending', branchId: br.info.id, node: n, needsUser: false });
  for (const n of auto) post({ type: 'thinking', branchId: br.info.id, botId: n.botId, kind: n.kind, on: true });
  const autoResults = await Promise.all(auto.map(async (node) => {
    try {
      if (!brain) throw new Error('未配置模型');
      const r = await brain.decide(br.world, node);
      return { node, choice: r.choice, by: 'llm' as const, monologue: r.monologue, model: r.model, goal: r.goal };
    } catch (err) {
      post({ type: 'error', message: `模型决策失败，已按规则选择：${String(err)}` });
      const opt = node.options.reduce((a, b) => ((b.weight ?? 1) > (a.weight ?? 1) ? b : a));
      return { node, choice: opt.id, by: 'rules' as const, monologue: undefined, model: undefined, goal: undefined };
    } finally {
      post({ type: 'thinking', branchId: br.info.id, botId: node.botId, kind: node.kind, on: false });
    }
  }));
  for (const r of autoResults) {
    if (r.goal) { const b = br.world.bot(r.node.botId); if (b) b.goal = r.goal; }
    results.push(r);
  }
  for (const node of manual) {
    post({ type: 'pending', branchId: br.info.id, node, needsUser: true });
    const r = await new Promise<{ choice: string; by: 'user' | 'llm'; monologue?: string; model?: string }>((resolve) => {
      waitingUser = { branchId: br.info.id, decisionId: node.id, resolve };
    });
    results.push({ node, ...r });
  }
  // 严格按挂起顺序落地，保证分叉回放一致
  for (const node of pending) {
    const r = results.find((x) => x.node.id === node.id)!;
    br.world.resolveDecision(node.id, r.choice, r.by, r.monologue, r.model);
    post({ type: 'decided', branchId: br.info.id, node: br.world.state.decisions[node.id] });
  }
  // 决策可能引发新的挂起决策（如高考→选专业）
  if (br.world.pending.length) await handlePending(br);
}

function fork(decisionId: string, choice: string): void {
  const parent = branches.get(activeId);
  if (!parent) return;
  const id = `fork-${branches.size}`;
  const node = parent.world.state.decisions[decisionId];
  const alt = node?.options.find((o) => o.id === choice);
  const child = parent.world.fork(decisionId, choice, id);
  const samples = new Map<string, StatSample[]>();
  for (const [k, v] of parent.samples) samples.set(k, v.filter((s) => s.tick <= child.tick));
  const info: BranchInfo = { id, parentId: parent.info.id, forkedAtTick: node.tick, label: `分叉：${alt?.label ?? choice}` };
  const br: Branch = { info, world: child, samples };
  branches.set(id, br);
  post({ type: 'branch', branch: info });
  // 补齐分叉点之前的事件（主线程已有相同前缀，这里只发分叉点所在年的新事件）
  const snapTick = Math.floor(node.tick / 12) * 12;
  const prefix = child.state.log.filter((e) => e.tick >= snapTick);
  activeId = id;
  post({ type: 'tick', branchId: id, summary: child.summary(), events: prefix, bots: allSummaries(child), finished: child.finished });
  catchUpTarget = parent.world.tick;
  playing = true;
  post({ type: 'playing', playing: true });
  void (async () => {
    if (child.pending.length) await handlePending(br);
    void loop();
  })();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export {};
