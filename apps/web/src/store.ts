import { create } from 'zustand';
import type { BotSummary } from '@lifegame/core';
import { DEFAULT_PROVIDERS, type UsageRecord } from '@lifegame/llm';
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
const LS_WORLD = 'lifegame.world.v1';

function loadBrain(): BrainSettings {
  try {
    const raw = localStorage.getItem(LS_BRAIN);
    if (raw) {
      const b = JSON.parse(raw) as BrainSettings;
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
    get().restart();
  },

  send(m) { get().worker?.postMessage(m); },

  restart() {
    const { world, brain } = get();
    set({ branches: {}, activeBranch: 'main', compareBranch: undefined, playing: false, viewTick: undefined, selectedBot: undefined, pendingUser: undefined, thinking: {}, botDetail: undefined, compareDetail: undefined, usage: undefined, userControl: null });
    get().send({
      type: 'init',
      config: { seed: world.seed, eraId: 'china-modern', population: world.population, startYear: 1980, endYear: world.endYear, birthSpan: 10 },
      brain,
      heroCount: brain.level > 0 ? world.heroCount : 0,
    });
  },

  play() { get().send({ type: 'play' }); set({ viewTick: undefined }); },
  pause() { get().send({ type: 'pause' }); },
  setSpeed(s) { set({ speed: s }); get().send({ type: 'speed', ticksPerSecond: s }); },
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
        branches: { [m.branch.id]: { info: m.branch, events: [], bots, botOrder: m.bots.map((b) => b.id), finished: false, decided: {} } },
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
        const next: BranchData = { ...br, summary: m.summary, finished: m.finished };
        if (m.events.length) next.events = br.events.concat(m.events);
        if (m.bots) {
          const bots: Record<string, BotSummary> = {};
          for (const b of m.bots) bots[b.id] = b;
          next.bots = bots;
          next.botOrder = m.bots.map((b) => b.id);
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
        set({ pendingUser: { branchId: m.branchId, node: m.node }, playing: false });
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
        const events = parent ? parent.events.filter((e) => e.tick < snapTick) : [];
        const decided: Record<string, DecisionNode> = {};
        if (parent) for (const d of Object.values(parent.decided)) if (d.tick < snapTick) decided[d.id] = d;
        return {
          branches: { ...s.branches, [m.branch.id]: { info: m.branch, events, bots: parent?.bots ?? {}, botOrder: parent?.botOrder ?? [], finished: false, decided } },
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
    case 'usage': set({ usage: m.usage }); break;
    case 'playing': set({ playing: m.playing }); break;
    case 'error': set((s) => ({ errors: [...s.errors.slice(-4), m.message] })); break;
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
