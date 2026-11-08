export type Sex = 'male' | 'female';

/** 大五人格，0-100 */
export interface Personality {
  openness: number;
  conscientiousness: number;
  extraversion: number;
  agreeableness: number;
  neuroticism: number;
}

/** 天赋，0-100 */
export interface Talents {
  physique: number;
  intellect: number;
  charm: number;
  luck: number;
}

/** 价值取向，0-100。决定规则模式下的选择倾向，也写进模型的人格卡 */
export interface Values {
  ambition: number;   // 事业心
  family: number;     // 家庭观念
  security: number;   // 求稳
  adventure: number;  // 冒险
  tradition: number;  // 传统/服从
}

export type Region = 'rural' | 'town' | 'city' | 'metro';

export interface Origin {
  /** 家境阶层 1(赤贫)~5(富裕) */
  ses: number;
  region: Region;
  /** 出生地/籍贯名 */
  hometown: string;
  fatherJob: string;
  motherJob: string;
}

export type LifeStage = 'infant' | 'child' | 'teen' | 'youth' | 'adult' | 'middle' | 'senior';

export type EducationLevel =
  | 'none' | 'primary' | 'junior' | 'vocational' | 'senior'
  | 'college' | 'bachelor' | 'master' | 'phd';

export interface Skills {
  academic: number;
  social: number;
  craft: number;
  business: number;
}

export interface Job {
  id: string;
  title: string;
  sector: string;
  sinceTick: number;
  /** 月薪，元（名义） */
  salary: number;
  level: number;
}

export interface Relationship {
  botId: string;
  kind: 'parent' | 'child' | 'spouse' | 'ex' | 'friend' | 'rival' | 'mentor';
  /** -100~100 */
  affinity: number;
  sinceTick: number;
}

export interface BotState {
  health: number;      // 0-100
  happiness: number;   // 0-100
  wealth: number;      // 元，可为负（负债）
  education: EducationLevel;
  skills: Skills;
  job?: Job;
  location: Region;
  city: string;
  ownsHome: boolean;
  /** 自定义标签，由时代包使用，如 'gaokao:985'、'major:cs' */
  tags: string[];
  /** 数值变量，由时代包使用，如房贷余额、房产价值 */
  vars: Record<string, number>;
}

export type IntelligenceMode = 'rules' | 'llm';

export interface MemoryEntry {
  eventSeq: number;
  importance: number;
}

export interface Reflection {
  stage: LifeStage;
  tick: number;
  text: string;
}

/** 投胎：用户自己设计的人。没填的项由时代包按常理随机补上 */
export interface BirthSpec {
  name?: string;
  sex: Sex;
  region: Region;
  hometown?: string;
  /** 家境 1(赤贫)~5(富裕) */
  ses: number;
  fatherJob?: string;
  motherJob?: string;
  personality?: Partial<Personality>;
  talents?: Partial<Talents>;
  values?: Partial<Values>;
  /** 身世与自述，写进模型看到的人格卡 */
  bio?: string;
  intelligence: IntelligenceMode;
  model?: string;
  lead?: boolean;
}

export interface Bot {
  id: string;
  name: string;
  sex: Sex;
  /** 用户写的身世（投胎时填） */
  bio?: string;
  birthTick: number;
  deathTick?: number;
  deathCause?: string;
  familyId: string;
  parentIds: string[];
  spouseId?: string;
  childrenIds: string[];
  generation: number;
  origin: Origin;
  personality: Personality;
  talents: Talents;
  values: Values;
  state: BotState;
  stage: LifeStage;
  intelligence: IntelligenceMode;
  model?: string;
  /** 主角：由模型真正拍板，必要时世界停下来等他。配角（如继承了智能的子女）不让世界等 */
  lead?: boolean;
  /** 这个人自己的随机数流。各人独立，甲的变化不会扰动无关的乙 */
  rngState?: number[];
  /** 已提出的决策数，用来生成稳定的决策编号 */
  decisionCount?: number;
  memory: MemoryEntry[];
  reflections: Reflection[];
  goal?: string;
  relationships: Relationship[];
  /** 一句话自我画像，出生时由模型或规则生成 */
  portrait?: string;
}

export function isAlive(bot: Bot): boolean {
  return bot.deathTick === undefined;
}
