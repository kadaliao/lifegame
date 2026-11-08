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
  pendingDecisionIds: string[];
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
