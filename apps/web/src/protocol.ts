import type { BotSummary } from '@lifegame/core';
import type { ProviderConfig, UsageRecord } from '@lifegame/llm';
import type { Bot, DecisionNode, WorldConfig, WorldEvent, WorldSummary } from '@lifegame/schema';

export type IntelligenceLevel = 0 | 1 | 2;

export interface BrainSettings {
  providers: ProviderConfig[];
  /** "providerId/model" */
  defaultModel: string;
  level: IntelligenceLevel;
}

export interface StatSample {
  tick: number;
  health: number;
  happiness: number;
  netWorth: number;
}

export type MainToWorker =
  | { type: 'init'; config: WorldConfig; brain: BrainSettings; heroCount: number }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'speed'; ticksPerSecond: number }
  | { type: 'setIntelligence'; botId: string; mode: 'rules' | 'llm'; model?: string }
  | { type: 'setUserControl'; botId: string | null }
  | { type: 'resolve'; branchId: string; decisionId: string; choice: string }
  | { type: 'askBrain'; branchId: string; decisionId: string }
  | { type: 'fork'; decisionId: string; choice: string }
  | { type: 'setBrain'; brain: BrainSettings }
  | { type: 'getBot'; branchId: string; botId: string }
  | { type: 'setActiveBranch'; branchId: string };

export interface BranchInfo {
  id: string;
  parentId?: string;
  forkedAtTick?: number;
  label: string;
}

export type WorkerToMain =
  | { type: 'ready'; branch: BranchInfo; config: WorldConfig; era: { id: string; name: string; description: string; theme: { accent: string; paper: string; ink: string; fontFamily: string } }; bots: BotSummary[] }
  | { type: 'tick'; branchId: string; summary: WorldSummary; events: WorldEvent[]; bots?: BotSummary[]; finished: boolean }
  | { type: 'pending'; branchId: string; node: DecisionNode; needsUser: boolean }
  | { type: 'decided'; branchId: string; node: DecisionNode }
  | { type: 'thinking'; branchId: string; botId: string; kind: string; on: boolean }
  | { type: 'reflection'; branchId: string; botId: string; stage: string; text: string }
  | { type: 'bot'; branchId: string; bot: Bot; samples: StatSample[]; decisions: DecisionNode[] }
  | { type: 'branch'; branch: BranchInfo }
  | { type: 'usage'; usage: UsageRecord }
  | { type: 'playing'; playing: boolean }
  | { type: 'error'; message: string };
