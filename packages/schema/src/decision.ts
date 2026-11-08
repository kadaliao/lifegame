import { z } from 'zod';

export interface DecisionOption {
  id: string;
  label: string;
  /** 给模型/用户看的后果说明 */
  description: string;
  /** 规则模式下的基础权重 */
  weight?: number;
}

export type DecisionResolver = 'rules' | 'llm' | 'user';

export interface DecisionNode {
  id: string;
  kind: string;
  tick: number;
  botId: string;
  /** 处境叙述 */
  situation: string;
  options: DecisionOption[];
  chosen?: string;
  resolvedBy?: DecisionResolver;
  monologue?: string;
  model?: string;
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
