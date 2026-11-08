import type { ProviderConfig } from './provider.js';

/** 可以从环境变量读密钥的模型服务。密钥只在 Node 侧使用，浏览器经本地代理访问 */
export interface EnvProviderDef {
  id: string;
  label: string;
  envKey: string;
  baseUrl: string;
  /** 拉取 /models 失败时使用 */
  fallbackModels: string[];
  /** 过滤 /models 返回的列表（有的服务会返回几百个） */
  modelFilter?: (id: string) => boolean;
}

export const ENV_PROVIDERS: EnvProviderDef[] = [
  { id: 'aihubmix', label: 'aihubmix', envKey: 'AIHUBMIX_API_KEY', baseUrl: 'https://aihubmix.com/v1', fallbackModels: ['qwen3-vl-plus'] },
  { id: 'deepseek', label: 'DeepSeek', envKey: 'DEEPSEEK_API_KEY', baseUrl: 'https://api.deepseek.com/v1', fallbackModels: ['deepseek-chat'] },
  {
    id: 'openrouter', label: 'OpenRouter', envKey: 'OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api/v1',
    fallbackModels: ['deepseek/deepseek-chat', 'qwen/qwen-2.5-72b-instruct'],
    modelFilter: (id) => /^(deepseek|qwen|google\/gemini-2\.5-flash|openai\/gpt-4\.1-mini|anthropic\/claude-haiku)/.test(id)
      && !/(:batch|coder|-vl-|vision|thinking|-exp|r1|\d{4}$|\d{4}-\d{2}$)/.test(id),
  },
];

/** 列出本机环境变量里有密钥的服务（不含密钥本身） */
export function availableEnvProviders(env: Record<string, string | undefined>): EnvProviderDef[] {
  return ENV_PROVIDERS.filter((p) => Boolean(env[p.envKey]));
}

/** 向上游拉取这把密钥能用的模型 */
export async function discoverModels(def: EnvProviderDef, apiKey: string, signal?: AbortSignal): Promise<string[]> {
  try {
    const res = await fetch(`${def.baseUrl}/models`, { headers: { authorization: `Bearer ${apiKey}` }, signal });
    if (!res.ok) return def.fallbackModels;
    const data = await res.json() as { data?: Array<{ id?: string }> };
    let ids = (data.data ?? []).map((m) => m.id ?? '').filter(Boolean);
    if (def.modelFilter) ids = ids.filter(def.modelFilter);
    ids = ids.filter((id) => !/(embedding|tts|whisper|image|audio|realtime|moderation|rerank)/i.test(id));
    return ids.length ? ids.sort() : def.fallbackModels;
  } catch {
    return def.fallbackModels;
  }
}

/** Node 侧直连：带密钥的 ProviderConfig */
export function envProviderConfig(def: EnvProviderDef, env: Record<string, string | undefined>, models: string[]): ProviderConfig {
  return { id: def.id, label: `${def.label}（本机密钥）`, kind: 'openai-compatible', baseUrl: def.baseUrl, apiKey: env[def.envKey], models };
}
