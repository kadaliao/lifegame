import { z } from 'zod';

export interface DecisionOption {
  id: string;
  label: string;
  /** 给模型/用户看的后果说明 */
  description: string;
  /** 规则模式下的基础权重 */
  weight?: number;
}

/** auto：模型迟迟没回来，按这个人最可能的选择先走下去 */
export type DecisionResolver = 'rules' | 'llm' | 'user' | 'auto';

export interface DecisionNode {
  /** 稳定编号：人物编号:第几个决定。无关的人不会因别人的变化而改号 */
  id: string;
  /** 全局提出顺序，用于同一 tick 内按序落地 */
  seq: number;
  kind: string;
  /** 提出决策的 tick */
  tick: number;
  /** 犹豫期结束、选择生效的 tick。到期还没有答案，世界才会停下来等 */
  dueTick: number;
  botId: string;
  /** 处境叙述 */
  situation: string;
  options: DecisionOption[];
  /** 时代包附带的数据，如求婚对象、房价 */
  data?: Record<string, unknown>;
  /** 有了答案（可能还没生效） */
  chosen?: string;
  resolvedBy?: DecisionResolver;
  monologue?: string;
  model?: string;
  /** 已经落地 */
  applied?: boolean;
  /** 推测：模型还没答，先按最可能的选择往下走；真答案回来后可能被纠正 */
  provisional?: boolean;
  /** 随答案一起生效的新心愿 */
  goal?: string;
  /** 提出时发给模型的提示词指纹；重放时只有指纹相同才复用旧答案 */
  promptKey?: string;
  /** 提出那一步结束时的处境。提示词只读这一份，读档后晚几个月才生成提示词也不会变；落地后删掉 */
  asOf?: DecisionContext;
  /** 落地时日志已有几条：据此判断它在别的决定提出时是否已经生效 */
  appliedSeq?: number;
}

export interface DecisionContext {
  /** 当时日志有几条：只有这之前的事算"记得" */
  log: number;
  situation: string;
  era: string;
  persona: string;
  goal?: string;
}

/** 模型对决策的结构化回答 */
export const LlmDecisionOutput = z.object({
  choice: z.string(),
  monologue: z.string(),
  goal: z.string().optional(),
});
export type LlmDecisionOutput = z.infer<typeof LlmDecisionOutput>;

export const LlmReflectionOutput = z.object({
  reflection: z.string(),
  goal: z.string().optional(),
});
export type LlmReflectionOutput = z.infer<typeof LlmReflectionOutput>;

export const LlmPortraitOutput = z.object({
  portrait: z.string(),
});
export type LlmPortraitOutput = z.infer<typeof LlmPortraitOutput>;
