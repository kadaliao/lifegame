import type {
  Bot, DecisionNode, DecisionOption, LifeStage, WorldEvent, WorldStateShape, Sex,
} from '@lifegame/schema';
import type { Rng } from './rng.js';

export type LogInput = Omit<WorldEvent, 'seq' | 'tick'> & { tick?: number };

export interface DecisionRequest {
  kind: string;
  situation: string;
  options: DecisionOption[];
}

/** 时代包在每个钩子里拿到的上下文 */
export interface EraContext {
  world: WorldStateShape;
  rng: Rng;
  tick: number;
  year: number;
  month: number;
  age(bot: Bot): number;
  log(e: LogInput): WorldEvent;
  alive(): Bot[];
  bot(id: string): Bot | undefined;
  /** 请求一个决策。规则 bot 立即解决并返回已决节点；智能 bot 返回挂起节点 */
  requestDecision(bot: Bot, req: DecisionRequest): DecisionNode;
  /** 新生儿进入世界 */
  addBot(bot: Bot): Bot;
  nextId(prefix: string): string;
  kill(bot: Bot, cause: string): void;
}

export interface DecisionDef {
  kind: string;
  /** 把选项效果落到世界上 */
  apply(bot: Bot, optionId: string, ctx: EraContext): void;
}

export interface EraTheme {
  accent: string;
  paper: string;
  ink: string;
  fontFamily: string;
}

export interface EraPack {
  id: string;
  name: string;
  description: string;
  defaultStartYear: number;
  defaultEndYear: number;
  defaultBirthSpan: number;
  theme: EraTheme;
  initEraState(): Record<string, unknown>;
  stageOf(age: number): LifeStage;
  createInitialBot(ctx: EraContext, birthTick: number): Bot;
  createChildBot(ctx: EraContext, mother: Bot, father: Bot, birthTick: number, sex: Sex): Bot;
  /** 每年年初（1 月）世界级钩子：历史事件、物价 */
  onYear(ctx: EraContext): void;
  /** 每月每个活着的 bot */
  onTick(bot: Bot, ctx: EraContext): void;
  /** 每年生日 */
  onBirthday(bot: Bot, age: number, ctx: EraContext): void;
  decisions: Record<string, DecisionDef>;
  /** 给模型看的人格卡（不含当前处境） */
  personaCard(bot: Bot, ctx: EraContext): string;
  /** 给模型看的当前处境摘要 */
  situationCard(bot: Bot, ctx: EraContext): string;
  /** 世界历史背景一句话 */
  eraCard(ctx: EraContext): string;
}
