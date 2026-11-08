import type {
  Bot, DecisionNode, DecisionOption, LifeStage, WorldEvent, WorldStateShape, Sex, BirthSpec, Region,
} from '@lifegame/schema';
import type { Rng } from './rng.js';

export type LogInput = Omit<WorldEvent, 'seq' | 'tick'> & { tick?: number };

export interface DecisionRequest {
  kind: string;
  situation: string;
  options: DecisionOption[];
  /** 附带数据，落地时原样交给 apply */
  data?: Record<string, unknown>;
  /** 覆盖默认的犹豫期（月） */
  deliberation?: number;
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
  /** 请求一个决策。规则 bot 立即落地；智能 bot 进入犹豫期，到期生效 */
  requestDecision(bot: Bot, req: DecisionRequest): DecisionNode;
  /** 这个人是否有还没落地的决策（可限定类型） */
  openDecision(botId: string, kind?: string): boolean;
  /** 新生儿进入世界 */
  addBot(bot: Bot): Bot;
  /** 初始人口的编号 */
  nextId(prefix: string): string;
  /** 孩子的稳定编号：母亲编号.第几个孩子 */
  childId(mother: Bot): string;
  /** 由键派生的一次性随机数，不消耗任何人的随机数流（用于结果取决于别人状态的抽签） */
  keyedRng(key: string): Rng;
  kill(bot: Bot, cause: string): void;
}

export interface DecisionDef {
  kind: string;
  /** 智能角色的犹豫期（月）：请求发出后世界继续运转，到期才生效。默认 1 */
  deliberation?: number;
  /** 把选项效果落到世界上 */
  apply(bot: Bot, optionId: string, ctx: EraContext, node: DecisionNode): void;
}

export interface BirthOptions {
  regions: Array<{ id: Region; label: string }>;
  places: Array<{ name: string; region: Region }>;
  parentJobs: Record<Region, string[]>;
  sesLabels: string[];
}

export interface EraTheme {
  accent: string;
  paper: string;
  ink: string;
  fontFamily: string;
}

export interface EraPack {
  id: string;
  /** 规则版本：改了会影响世界走向的规则就加一，旧存档重放时据此提示 */
  rulesVersion?: number;
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
  /** 投胎：按用户的设计造一个人。只能用 ctx.keyedRng，不能动任何人的随机数流 */
  createCustomBot?(ctx: EraContext, spec: BirthSpec, birthTick: number, id: string): Bot;
  /** 投胎界面的选项 */
  birthOptions?(): BirthOptions;
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
  /** 名义工资指数，用于把不同年份的钱折算到同一水平 */
  wageIndex?(year: number): number;
}
