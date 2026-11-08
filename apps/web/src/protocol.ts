import type { BotSummary } from '@lifegame/core';
import type { ProviderConfig, UsageRecord } from '@lifegame/llm';
import type { ScriptedChoices } from '@lifegame/core';
import type { BirthSpec, Bot, CustomBirth, DecisionNode, IntelChange, WorldConfig, WorldEvent, WorldFlags, WorldSummary } from '@lifegame/schema';

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
  | { type: 'display'; branchId: string; tick: number; ahead: number }
  | { type: 'setIntelligence'; botId: string; mode: 'rules' | 'llm'; model?: string }
  | { type: 'setUserControl'; botId: string | null }
  | { type: 'resolve'; branchId: string; decisionId: string; choice: string }
  | { type: 'askBrain'; branchId: string; decisionId: string }
  | { type: 'fork'; decisionId: string; choice: string }
  | { type: 'setBrain'; brain: BrainSettings }
  | { type: 'getBot'; branchId: string; botId: string; atTick?: number }
  | { type: 'setActiveBranch'; branchId: string }
  | { type: 'save'; requestId: string }
  | { type: 'reborn'; spec: BirthSpec; birthTick: number; label: string }
  | { type: 'load'; file: SaveFile; brain: BrainSettings };

export interface BranchInfo {
  id: string;
  parentId?: string;
  forkedAtTick?: number;
  label: string;
}

/** 一个分支的存档：从头重放所需的全部信息。答案只收画面所在位置之前提出的 */
export interface SavedBranch {
  info: BranchInfo;
  display: number;
  intelChanges: IntelChange[];
  births?: CustomBirth[];
  answers: ScriptedChoices;
  /** 命运旁白只用于展示，单独保存 */
  portraits: Record<string, string>;
}

export interface SaveFile {
  format: 'lifegame-save';
  version: 1;
  savedAt: string;
  config: WorldConfig;
  flags: WorldFlags;
  active: string;
  compare?: string;
  branches: SavedBranch[];
  meta: { year: number; heroes: string[]; branches: number; eraName: string };
  /** 存档时的时代规则版本 */
  rules?: number;
}

export type WorkerToMain =
  | { type: 'ready'; branch: BranchInfo; config: WorldConfig; era: { id: string; name: string; description: string; theme: { accent: string; paper: string; ink: string; fontFamily: string } }; bots: BotSummary[]; display?: number }
  | { type: 'tick'; branchId: string; summary: WorldSummary; frontier: number; events: WorldEvent[]; bots?: BotSummary[]; finished: boolean }
  | { type: 'pending'; branchId: string; node: DecisionNode; needsUser: boolean }
  | { type: 'decided'; branchId: string; node: DecisionNode }
  | { type: 'thinking'; branchId: string; botId: string; kind: string; on: boolean }
  | { type: 'reflection'; branchId: string; botId: string; stage: string; text: string }
  | { type: 'bot'; branchId: string; bot: Bot; samples: StatSample[]; decisions: DecisionNode[] }
  | { type: 'branch'; branch: BranchInfo; fromSeq: number; display?: number }
  | { type: 'frames'; branchId: string; frames: Record<number, Record<string, number>> }
  | { type: 'yearBots'; branchId: string; years: Record<number, BotSummary[]> }
  | { type: 'saved'; requestId: string; file: SaveFile }
  | { type: 'loaded'; active: string; compare?: string; year: number; staleRules: boolean }
  | { type: 'reborn'; branchId: string; botId: string; birthTick: number }
  | { type: 'rewind'; branchId: string; fromSeq: number; fromTick: number }
  | { type: 'usage'; usage: UsageRecord; queue: number }
  | { type: 'error'; message: string };
