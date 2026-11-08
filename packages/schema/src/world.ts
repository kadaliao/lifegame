import type { Bot } from './bot.js';
import type { WorldEvent } from './event.js';
import type { DecisionNode } from './decision.js';

export const TICKS_PER_YEAR = 12;

export interface WorldConfig {
  seed: number;
  eraId: string;
  population: number;
  startYear: number;
  endYear: number;
  /** 初始人口出生年份跨度 */
  birthSpan: number;
}

export interface IntelChange {
  tick: number;
  botId: string;
  intelligence: 'rules' | 'llm';
  model?: string;
  lead?: boolean;
}

export interface WorldFlags {
  /** 智能人格在人生阶段结束时写反思（经由引擎节点生效，保证可重放） */
  reflections: boolean;
  /** 智能人格的子女继承智能（作为配角） */
  inherit: boolean;
}

export interface WorldSummary {
  tick: number;
  year: number;
  month: number;
  alive: number;
  dead: number;
  total: number;
}

export interface Snapshot {
  tick: number;
  /** JSON 序列化的 World */
  data: string;
}

export interface WorldStateShape {
  config: WorldConfig;
  branchId: string;
  parentBranchId?: string;
  forkedAtTick?: number;
  tick: number;
  rngState: number[];
  bots: Record<string, Bot>;
  botOrder: string[];
  log: WorldEvent[];
  decisions: Record<string, DecisionNode>;
  /** 还没有答案的决策 */
  pendingDecisionIds: string[];
  /** 还没落地的决策（含没有答案的） */
  openDecisionIds: string[];
  /** 已经按推测落地、等真答案确认的决策 */
  provisionalIds: string[];
  flags: WorldFlags;
  /** 智能设定的时间线：谁在哪个月起由模型/规则驱动。重放时按原来的时刻生效 */
  intelChanges: IntelChange[];
  /** 时代包的可变全局状态 */
  eraState: Record<string, unknown>;
  nextId: number;
}

export function tickToYearMonth(tick: number, startYear: number): { year: number; month: number } {
  return { year: startYear + Math.floor(tick / TICKS_PER_YEAR), month: (tick % TICKS_PER_YEAR) + 1 };
}

export function ageAt(birthTick: number, tick: number): number {
  return Math.floor((tick - birthTick) / TICKS_PER_YEAR);
}
