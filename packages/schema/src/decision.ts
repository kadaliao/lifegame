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
  id: string;
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
