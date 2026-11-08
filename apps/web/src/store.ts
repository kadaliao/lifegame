import { create } from 'zustand';
import type { BotSummary } from '@lifegame/core';
import { DEFAULT_PROVIDERS, type ProviderConfig, type UsageRecord } from '@lifegame/llm';
import type { Bot, DecisionNode, WorldConfig, WorldEvent, WorldSummary } from '@lifegame/schema';
import type { BranchInfo, BrainSettings, MainToWorker, StatSample, WorkerToMain } from './protocol.js';

export interface EraInfo {
  id: string;
  name: string;
  description: string;
  theme: { accent: string; paper: string; ink: string; fontFamily: string };
}

export interface BranchData {
  info: BranchInfo;
  events: WorldEvent[];
  bots: Record<string, BotSummary>;
  botOrder: string[];
  summary?: WorldSummary;
  finished: boolean;
  decided: Record<string, DecisionNode>;
  /** 每年一帧：tick → botId → 净资产，供回看时还原众生相 */
  frames: Record<number, Record<string, number>>;
  /** 画面播到的 tick。模拟会领先画面几年，用来藏住模型的思考时间 */
  displayTick: number;
  /** 回退一次加一，视图据此重建缓存 */
  epoch: number;
  /** 画面最多能播到的 tick：不越过任何还没被真答案确认的推测 */
  frontier: number;
}

/** 只保留出现在事件里的决策卡片 */
function decidedIn(events: WorldEvent[], from: Record<string, DecisionNode>): Record<string, DecisionNode> {
  const out: Record<string, DecisionNode> = {};
  for (const e of events) if (e.decisionId && from[e.decisionId]) out[e.decisionId] = from[e.decisionId];
  return out;
}

/** 画面上的"现在"：不超过 frontier */
export function nowOf(br?: BranchData): number {
  return br ? Math.min(br.displayTick, br.frontier) : 0;
}

/** 画面是否追上了 frontier，正在等某个人想清楚 */
export function caughtUp(br?: BranchData): boolean {
  return !!br && br.displayTick >= br.frontier - 1 && !br.finished;
}

function frameOf(bots: BotSummary[], tick: number): Record<string, number> {
  const f: Record<string, number> = {};
  for (const b of bots) if (b.birthTick <= tick && (b.deathTick ?? Infinity) > tick) f[b.id] = b.wealth;
  return f;
}

export interface WorldSettings {
  seed: number;
  population: number;
  heroCount: number;
  endYear: number;
}

export interface BotDetail {
  branchId: string;
  bot: Bot;
  samples: StatSample[];
  decisions: DecisionNode[];
}

interface State {
  worker?: Worker;
  config?: WorldConfig;
  era?: EraInfo;
  branches: Record<string, BranchData>;
  activeBranch: string;
  compareBranch?: string;
  playing: boolean;
  speed: number;
  viewTick?: number;
  selectedBot?: string;
  userControl: string | null;
  pendingUser?: { branchId: string; node: DecisionNode };
  thinking: Record<string, string>;
  botDetail?: BotDetail;
  compareDetail?: BotDetail;
  usage?: UsageRecord;
  /** 排队和在路上的模型请求 */
  queue: number;
  errors: string[];
  brain: BrainSettings;
  world: WorldSettings;
  settingsOpen: boolean;

  boot(): void;
  send(m: MainToWorker): void;
  restart(): void;
  play(): void;
  pause(): void;
  setSpeed(s: number): void;
  setViewTick(t: number | undefined): void;
  selectBot(id: string | undefined): void;
  setUserControl(id: string | null): void;
  resolveUser(choice: string): void;
  askBrain(): void;
  fork(decisionId: string, choice: string): void;
  setActiveBranch(id: string): void;
  setCompareBranch(id: string | undefined): void;
  setBrain(b: BrainSettings): void;
  setWorld(w: WorldSettings): void;
  setSettingsOpen(v: boolean): void;
  dismissError(i: number): void;
  setIntelligence(botId: string, mode: 'rules' | 'llm', model?: string): void;
}

const LS_BRAIN = 'lifegame.brain.v1';
let brainSaved = false;
/** 画面时钟的小数部分 */
const displayFloat = new Map<string, number>();
const LS_WORLD = 'lifegame.world.v1';

function loadBrain(): BrainSettings {
  try {
    const raw = localStorage.getItem(LS_BRAIN);
    if (raw) {
      brainSaved = true;
      const b = JSON.parse(raw) as BrainSettings;
      // 本机密钥的服务每次启动重新从开发服务器获取
      b.providers = b.providers.filter((p) => !p.env);
      // 合并新增的默认 provider
      const ids = new Set(b.providers.map((p) => p.id));
      for (const p of DEFAULT_PROVIDERS) if (!ids.has(p.id)) b.providers.push(p);
      return b;
    }
  } catch { /* ignore */ }
  return { providers: DEFAULT_PROVIDERS.map((p) => ({ ...p })), defaultModel: 'mock/mock', level: 2 };
}

function loadWorld(): WorldSettings {
  try {
    const raw = localStorage.getItem(LS_WORLD);
    if (raw) return JSON.parse(raw) as WorldSettings;
  } catch { /* ignore */ }
  return { seed: 42, population: 200, heroCount: 3, endYear: 2060 };
}

export const useStore = create<State>((set, get) => ({
  branches: {},
  activeBranch: 'main',
  playing: false,
  speed: 24,
  userControl: null,
  thinking: {},
  queue: 0,
  errors: [],
  brain: loadBrain(),
  world: loadWorld(),
  settingsOpen: false,

  boot() {
    if (get().worker) return;
    const worker = new Worker(new URL('./worker/sim.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<WorkerToMain>) => onWorkerMessage(e.data, set, get);
    worker.onerror = (e) => set((s) => ({ errors: [...s.errors, `Worker 错误：${e.message}`] }));
    set({ worker });
    startClock(set, get);
    // 先问开发服务器本机有哪些模型密钥，再开世界
    loadEnvProviders().then((env) => {
      if (env.length) {
        const brain = get().brain;
        const ids = new Set(env.map((p) => p.id));
        const providers = [...env, ...brain.providers.filter((p) => !ids.has(p.id) && !p.env)];
        const stillValid = providers.some((p) => p.models.some((m) => `${p.id}/${m}` === brain.defaultModel));
        // 没存过设置、存的模型已失效、或者还停在假模型上，都改用本机真模型
        const defaultModel = !brainSaved || !stillValid || brain.defaultModel.startsWith('mock/') ? `${env[0].id}/${env[0].models[0]}` : brain.defaultModel;
        set({ brain: { ...brain, providers, defaultModel } });
      }
      get().restart();
    });
  },

  send(m) { get().worker?.postMessage(m); },

  restart() {
    const { world, brain } = get();
    displayFloat.clear();
    set({ branches: {}, activeBranch: 'main', compareBranch: undefined, playing: false, viewTick: undefined, selectedBot: undefined, pendingUser: undefined, thinking: {}, botDetail: undefined, compareDetail: undefined, usage: undefined, userControl: null });
    get().send({
      type: 'init',
      config: { seed: world.seed, eraId: 'china-modern', population: world.population, startYear: 1980, endYear: world.endYear, birthSpan: 10 },
      brain,
      heroCount: brain.level > 0 ? world.heroCount : 0,
    });
  },

  play() { set({ playing: true, viewTick: undefined }); },
  pause() { set({ playing: false }); },
  setSpeed(s) { set({ speed: s }); },
  setViewTick(t) { set({ viewTick: t }); },

  selectBot(id) {
    set({ selectedBot: id, botDetail: undefined, compareDetail: undefined });
    if (id) {
      const { activeBranch, compareBranch } = get();
      get().send({ type: 'getBot', branchId: activeBranch, botId: id });
      if (compareBranch) get().send({ type: 'getBot', branchId: compareBranch, botId: id });
    }
  },

  setUserControl(id) { set({ userControl: id }); get().send({ type: 'setUserControl', botId: id }); },

  resolveUser(choice) {
    const p = get().pendingUser;
    if (!p) return;
    get().send({ type: 'resolve', branchId: p.branchId, decisionId: p.node.id, choice });
    set({ pendingUser: undefined });
  },

  askBrain() {
    const p = get().pendingUser;
    if (!p) return;
    get().send({ type: 'askBrain', branchId: p.branchId, decisionId: p.node.id });
    set({ pendingUser: undefined });
  },

  fork(decisionId, choice) {
    get().send({ type: 'fork', decisionId, choice });
  },

  setActiveBranch(id) {
    set({ activeBranch: id, viewTick: undefined });
    get().send({ type: 'setActiveBranch', branchId: id });
    const sel = get().selectedBot;
    if (sel) get().send({ type: 'getBot', branchId: id, botId: sel });
  },

  setCompareBranch(id) {
    set({ compareBranch: id, compareDetail: undefined });
    const sel = get().selectedBot;
    if (id && sel) get().send({ type: 'getBot', branchId: id, botId: sel });
  },

  setBrain(b) {
    brainSaved = true;
    localStorage.setItem(LS_BRAIN, JSON.stringify(b));
    set({ brain: b });
    get().send({ type: 'setBrain', brain: b });
  },

  setWorld(w) {
    localStorage.setItem(LS_WORLD, JSON.stringify(w));
    set({ world: w });
  },

  setSettingsOpen(v) { set({ settingsOpen: v }); },
  dismissError(i) { set((s) => ({ errors: s.errors.filter((_, j) => j !== i) })); },
  setIntelligence(botId, mode, model) { get().send({ type: 'setIntelligence', botId, mode, model }); },
}));

type Set = (fn: Partial<State> | ((s: State) => Partial<State>)) => void;
type Get = () => State;

function onWorkerMessage(m: WorkerToMain, set: Set, get: Get): void {
  switch (m.type) {
    case 'ready': {
      const bots: Record<string, BotSummary> = {};
      for (const b of m.bots) bots[b.id] = b;
      set({
        config: m.config, era: m.era,
        branches: { [m.branch.id]: { info: m.branch, events: [], bots, botOrder: m.bots.map((b) => b.id), finished: false, decided: {}, frames: { 0: frameOf(m.bots, 0) }, displayTick: 0, epoch: 0, frontier: 0 } },
        activeBranch: m.branch.id,
      });
      const hero = m.bots.find((b) => b.intelligence === 'llm') ?? m.bots[0];
      if (hero) get().selectBot(hero.id);
      break;
    }
    case 'tick': {
      set((s) => {
        const br = s.branches[m.branchId];
        if (!br) return {};
        const next: BranchData = { ...br, summary: m.summary, finished: m.finished, frontier: m.frontier };
        if (m.events.length) next.events = br.events.concat(m.events);
        if (m.bots) {
          const bots: Record<string, BotSummary> = {};
          for (const b of m.bots) bots[b.id] = b;
          next.bots = bots;
          next.botOrder = m.bots.map((b) => b.id);
          next.frames = { ...br.frames, [m.summary.tick]: frameOf(m.bots, m.summary.tick) };
        }
        return { branches: { ...s.branches, [m.branchId]: next } };
      });
      // 选中的人每年刷新一次详情
      if (m.bots && get().selectedBot) {
        const sel = get().selectedBot!;
        if (m.branchId === get().activeBranch || m.branchId === get().compareBranch) {
          get().send({ type: 'getBot', branchId: m.branchId, botId: sel });
        }
      }
      break;
    }
    case 'pending': {
      if (m.needsUser) {
        set({ pendingUser: { branchId: m.branchId, node: m.node } });
        if (get().selectedBot !== m.node.botId) get().selectBot(m.node.botId);
      }
      break;
    }
    case 'decided': {
      set((s) => {
        const br = s.branches[m.branchId];
        if (!br) return {};
        return { branches: { ...s.branches, [m.branchId]: { ...br, decided: { ...br.decided, [m.node.id]: m.node } } } };
      });
      if (get().selectedBot === m.node.botId) get().send({ type: 'getBot', branchId: m.branchId, botId: m.node.botId });
      break;
    }
    case 'thinking': {
      set((s) => {
        const t = { ...s.thinking };
        if (m.on) t[m.botId] = m.kind; else delete t[m.botId];
        return { thinking: t };
      });
      break;
    }
    case 'reflection': {
      if (get().selectedBot === m.botId) get().send({ type: 'getBot', branchId: m.branchId, botId: m.botId });
      break;
    }
    case 'bot': {
      const detail: BotDetail = { branchId: m.branchId, bot: m.bot, samples: m.samples, decisions: m.decisions };
      if (m.branchId === get().activeBranch) set({ botDetail: detail });
      else if (m.branchId === get().compareBranch) set({ compareDetail: detail });
      break;
    }
    case 'branch': {
      set((s) => {
        const parent = m.branch.parentId ? s.branches[m.branch.parentId] : undefined;
        const snapTick = Math.floor((m.branch.forkedAtTick ?? 0) / 12) * 12;
        const events = parent ? parent.events.filter((e) => e.seq < m.fromSeq) : [];
        const decided = parent ? decidedIn(events, parent.decided) : {};
        const frames: Record<number, Record<string, number>> = {};
        if (parent) for (const [k, f] of Object.entries(parent.frames)) if (Number(k) <= snapTick) frames[Number(k)] = f;
        return {
          branches: { ...s.branches, [m.branch.id]: { info: m.branch, events, bots: parent?.bots ?? {}, botOrder: parent?.botOrder ?? [], finished: false, decided, frames, displayTick: parent?.displayTick ?? 0, epoch: 0, frontier: 0 } },
          activeBranch: m.branch.id,
          compareBranch: m.branch.parentId,
          viewTick: undefined,
        };
      });
      {
        const sel = get().selectedBot;
        if (sel) {
          get().send({ type: 'getBot', branchId: m.branch.id, botId: sel });
          if (m.branch.parentId) get().send({ type: 'getBot', branchId: m.branch.parentId, botId: sel });
        }
      }
      break;
    }
    case 'rewind': {
      set((s) => {
        const br = s.branches[m.branchId];
        if (!br) return {};
        const events = br.events.filter((e) => e.seq < m.fromSeq);
        const frames: Record<number, Record<string, number>> = {};
        for (const [k, f] of Object.entries(br.frames)) if (Number(k) <= m.fromTick) frames[Number(k)] = f;
        const pendingUser = s.pendingUser?.branchId === m.branchId ? undefined : s.pendingUser;
        return { pendingUser, branches: { ...s.branches, [m.branchId]: { ...br, events, decided: decidedIn(events, br.decided), frames, epoch: br.epoch + 1 } } };
      });
      break;
    }
    case 'usage': set({ usage: m.usage, queue: m.queue }); break;
    case 'error': set((s) => ({ errors: [...s.errors.slice(-4), m.message] })); break;
  }
}

/** 画面时钟：按播放速度推进 displayTick，不超过模拟；并把位置告诉 Worker，好让模拟保持领先 */
function startClock(set: Set, get: Get): void {
  let last = performance.now();
  let lastPost = 0;
  const frame = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const s = get();
    const br = s.branches[s.activeBranch];
    if (br) {
      const sim = br.frontier;
      let cur = displayFloat.get(br.info.id) ?? br.displayTick;
      if (s.playing) {
        cur = Number.isFinite(s.speed) ? Math.min(sim, cur + s.speed * dt) : sim;
        displayFloat.set(br.info.id, cur);
        const ti = Math.floor(cur);
        if (ti !== br.displayTick) {
          set((st) => ({ branches: { ...st.branches, [br.info.id]: { ...st.branches[br.info.id], displayTick: ti } } }));
        }
        if (br.finished && ti >= sim) set({ playing: false });
      }
      if (now - lastPost > 120) {
        lastPost = now;
        // 领先量约等于 12 秒的播放，够藏住主角连着三四次的思考。
        // 中途改设定会触发回退重放，所以领先多一些没有副作用
        const ahead = Number.isFinite(s.speed) ? Math.max(60, Math.min(600, Math.round(s.speed * 12))) : 240;
        s.send({ type: 'display', branchId: br.info.id, tick: Math.floor(cur), ahead });
      }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

async function loadEnvProviders(): Promise<ProviderConfig[]> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    const res = await fetch('/llm/env', { signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) return [];
    const data = await res.json() as { providers: Array<{ id: string; label: string; baseUrl: string; models: string[] }> };
    return data.providers.filter((p) => p.models.length).map((p) => ({ id: p.id, label: p.label, kind: 'openai-compatible' as const, baseUrl: p.baseUrl, models: p.models, env: true }));
  } catch {
    return [];
  }
}

export function useBranch(id?: string): BranchData | undefined {
  return useStore((s) => s.branches[id ?? s.activeBranch]);
}

export function yearOf(tick: number, startYear: number): number {
  return startYear + Math.floor(tick / 12);
}

export function fmtMoney(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e8) return `${(n / 1e8).toFixed(1)}亿`;
  if (a >= 1e4) return `${(n / 1e4).toFixed(1)}万`;
  return `${Math.round(n)}`;
}

// 开发时便于在控制台检查状态
if (import.meta.env.DEV) (globalThis as unknown as { __lifegame: typeof useStore }).__lifegame = useStore;
