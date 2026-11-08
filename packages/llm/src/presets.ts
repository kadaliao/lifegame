/**
 * 预置的模型服务。都走 OpenAI 兼容接口（/chat/completions、/models）。
 *
 * - 允许跨域的服务由浏览器直连，密钥不经过任何服务器；
 * - 不允许跨域的经部署站点的 /api/llm/<id> 转发（只转发到这里列出的地址，不是开放代理）；
 * - 部署方可以用 envKey 指定的环境变量提供"站点密钥"，访客不填密钥也能用，见 proxy.ts。
 *
 * 推荐模型只是起点：填了密钥会向 /models 拉取这把密钥实际能用的列表。
 */

export type PresetGroup = '免费' | '国内' | '海外' | '本地' | '其他';

export interface ProviderPreset {
  id: string;
  label: string;
  group: PresetGroup;
  baseUrl: string;
  /** required：必须有密钥；optional：没有也能用，有了额度更高；none：不需要 */
  key: 'required' | 'optional' | 'none';
  /** 去哪儿申请密钥 */
  keyUrl?: string;
  /** 推荐模型，第一个是默认 */
  models: string[];
  /** 一句话说明：哪些免费、有什么限制 */
  note?: string;
  /** 服务端允许浏览器跨域调用 */
  cors: boolean;
  /** 部署方用这个环境变量提供站点密钥 */
  envKey?: string;
  /** 同时在路上的请求数上限 */
  concurrency?: number;
  /** 地址可以改（本地服务、自定义） */
  editableUrl?: boolean;
  /** 过滤 /models 返回的列表（有的服务会返回几百个） */
  modelFilter?: (id: string, raw: Record<string, unknown>) => boolean;
  /** 发给上游的额外请求头 */
  headers?: (apiKey: string) => Record<string, string>;
}

export const FREE_PRESET_ID = 'llm7';

export const PRESETS: ProviderPreset[] = [
  {
    id: 'llm7', label: 'LLM7', group: '免费', baseUrl: 'https://api.llm7.io/v1', key: 'optional', keyUrl: 'https://token.llm7.io',
    models: ['mistral-Nemo-Instruct-2407', 'gpt-oss:20b', 'codestral-latest'],
    note: '不注册、不填密钥就能用，每人同时只能发 1 个请求；到 token.llm7.io 领一个免费令牌，限额更高。',
    cors: true, concurrency: 1,
    // 只留免费档、支持 JSON 输出的对话模型
    modelFilter: (_id, raw) => raw.model_type === 'chat' && raw.tier !== 'pro' && raw.json_mode !== false,
  },
  {
    id: 'deepseek', label: 'DeepSeek', group: '国内', baseUrl: 'https://api.deepseek.com/v1', key: 'required',
    keyUrl: 'https://platform.deepseek.com/api_keys', models: ['deepseek-flash', 'deepseek-v4-pro'],
    note: '便宜，中文好。', cors: true, envKey: 'DEEPSEEK_API_KEY',
  },
  {
    id: 'siliconflow', label: '硅基流动', group: '国内', baseUrl: 'https://api.siliconflow.cn/v1', key: 'required',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak', models: ['Qwen/Qwen3-8B', 'THUDM/GLM-4-9B-0414', 'deepseek-ai/DeepSeek-V3'],
    note: '部分小模型免费（如 Qwen3-8B、GLM-4-9B），注册即可用。', cors: true, envKey: 'SILICONFLOW_API_KEY',
  },
  {
    id: 'zhipu', label: '智谱 GLM', group: '国内', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', key: 'required',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys', models: ['glm-4.7-flash', 'glm-4-flash-250414', 'glm-5.3-flash'],
    note: 'GLM Flash 系列免费。经本站转发（智谱不允许网页直连）。', cors: false, envKey: 'ZHIPU_API_KEY',
  },
  {
    id: 'dashscope', label: '阿里云百炼（通义千问）', group: '国内', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', key: 'required',
    keyUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key', models: ['qwen-flash', 'qwen-plus', 'qwen-max'],
    note: '新用户有免费额度。', cors: true, envKey: 'DASHSCOPE_API_KEY',
  },
  {
    id: 'moonshot', label: '月之暗面 Kimi', group: '国内', baseUrl: 'https://api.moonshot.cn/v1', key: 'required',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys', models: ['kimi-k3', 'kimi-k2.6', 'moonshot-v1-8k'],
    cors: true, envKey: 'MOONSHOT_API_KEY',
  },
  {
    id: 'ark', label: '火山方舟（豆包）', group: '国内', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', key: 'required',
    keyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey', models: [],
    note: '模型填方舟控制台里开通的模型名或接入点 ID。', cors: true,
  },
  {
    id: 'hunyuan', label: '腾讯混元', group: '国内', baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1', key: 'required',
    keyUrl: 'https://console.cloud.tencent.com/hunyuan/api-key', models: ['hunyuan-lite', 'hunyuan-turbos-latest'],
    note: 'hunyuan-lite 免费。经本站转发。', cors: false, envKey: 'HUNYUAN_API_KEY',
  },
  {
    id: 'qianfan', label: '百度千帆（文心）', group: '国内', baseUrl: 'https://qianfan.baidubce.com/v2', key: 'required',
    keyUrl: 'https://console.bce.baidu.com/iam/#/iam/apikey/list', models: ['ernie-speed-128k', 'ernie-lite-8k', 'ernie-4.5-turbo-128k'],
    note: 'ERNIE Speed、Lite 免费。', cors: true, envKey: 'QIANFAN_API_KEY',
  },
  {
    id: 'stepfun', label: '阶跃星辰', group: '国内', baseUrl: 'https://api.stepfun.com/v1', key: 'required',
    keyUrl: 'https://platform.stepfun.com/interface-key', models: ['step-3.5-flash', 'step-3.7-flash'],
    cors: true, envKey: 'STEPFUN_API_KEY',
    modelFilter: (id) => /^step-\d/.test(id) && !/(vision|gui|audio|tts|asr|router)/.test(id),
  },
  {
    id: 'minimax', label: 'MiniMax', group: '国内', baseUrl: 'https://api.minimaxi.com/v1', key: 'required',
    keyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key', models: ['MiniMax-M3', 'MiniMax-M2.7'],
    cors: true, envKey: 'MINIMAX_API_KEY',
  },
  {
    id: 'aihubmix', label: 'AIHubMix（聚合）', group: '国内', baseUrl: 'https://aihubmix.com/v1', key: 'required',
    keyUrl: 'https://aihubmix.com/token', models: ['gpt-5.4-mini', 'gemini-3.8-flash', 'deepseek-v4-flash'],
    note: '一把密钥用各家模型。', cors: true, envKey: 'AIHUBMIX_API_KEY',
  },
  {
    id: 'openrouter', label: 'OpenRouter（聚合）', group: '海外', baseUrl: 'https://openrouter.ai/api/v1', key: 'required',
    keyUrl: 'https://openrouter.ai/keys',
    models: ['deepseek/deepseek-v4.1-flash', 'qwen/qwen3.8-flash', 'google/gemini-3.8-flash', 'google/gemma-4-31b-it:free'],
    note: '带 :free 后缀的模型免费（每天有次数限制）。', cors: true, envKey: 'OPENROUTER_API_KEY',
    modelFilter: (id) => id.endsWith(':free')
      || (/^(deepseek|qwen|google|openai|anthropic|moonshotai|z-ai|x-ai|minimax|mistralai)\//.test(id)
        && !/(:batch|-pro\b|-pro-|code|image|vision|-vl|omni|audio|thinking|-exp|legal|multi-agent|\d{4}$|-\d{2}-\d{2}$)/.test(id)),
  },
  {
    id: 'openai', label: 'OpenAI', group: '海外', baseUrl: 'https://api.openai.com/v1', key: 'required',
    keyUrl: 'https://platform.openai.com/api-keys', models: ['gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-4.1-mini'],
    cors: true, envKey: 'OPENAI_API_KEY',
    modelFilter: (id) => /^(gpt|o\d|chatgpt)/.test(id) && !/(search|transcribe|codex|instruct|\d{4}-\d{2}-\d{2})/.test(id),
  },
  {
    id: 'gemini', label: 'Google Gemini', group: '海外', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', key: 'required',
    keyUrl: 'https://aistudio.google.com/apikey', models: ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash'],
    note: '在 AI Studio 申请，有免费额度。', cors: true, envKey: 'GEMINI_API_KEY',
    modelFilter: (id) => /gemini|gemma/.test(id) && !/(live|native|preview-tts|exp)/.test(id),
  },
  {
    id: 'anthropic', label: 'Anthropic Claude', group: '海外', baseUrl: 'https://api.anthropic.com/v1', key: 'required',
    keyUrl: 'https://console.anthropic.com/settings/keys', models: ['claude-haiku-5-5', 'claude-sonnet-5-5'],
    note: '经本站转发（Anthropic 不允许网页直连这个接口）。', cors: false, envKey: 'ANTHROPIC_API_KEY',
    headers: (k) => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01' }),
  },
  {
    id: 'groq', label: 'Groq', group: '海外', baseUrl: 'https://api.groq.com/openai/v1', key: 'required',
    keyUrl: 'https://console.groq.com/keys', models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.3-70b-versatile'],
    note: '有免费额度，很快。', cors: true, envKey: 'GROQ_API_KEY',
  },
  {
    id: 'cerebras', label: 'Cerebras', group: '海外', baseUrl: 'https://api.cerebras.ai/v1', key: 'required',
    keyUrl: 'https://cloud.cerebras.ai', models: ['gpt-oss-120b', 'qwen-3.8-27b'],
    note: '有免费额度，非常快。', cors: true, envKey: 'CEREBRAS_API_KEY',
  },
  {
    id: 'mistral', label: 'Mistral', group: '海外', baseUrl: 'https://api.mistral.ai/v1', key: 'required',
    keyUrl: 'https://console.mistral.ai/api-keys', models: ['mistral-small-latest', 'mistral-medium-latest'],
    note: '免费试用档可用。', cors: true, envKey: 'MISTRAL_API_KEY',
  },
  {
    id: 'xai', label: 'xAI Grok', group: '海外', baseUrl: 'https://api.x.ai/v1', key: 'required',
    keyUrl: 'https://console.x.ai', models: ['grok-4.7', 'grok-4.3'], cors: true, envKey: 'XAI_API_KEY',
  },
  {
    id: 'ollama', label: 'Ollama', group: '本地', baseUrl: 'http://localhost:11434/v1', key: 'none', models: ['qwen3:8b'],
    note: 'Ollama 要设置 OLLAMA_ORIGINS=* 网页才能访问；从线上页面访问本机，浏览器可能会请求本地网络权限。',
    cors: true, editableUrl: true, concurrency: 2,
  },
  {
    id: 'lmstudio', label: 'LM Studio', group: '本地', baseUrl: 'http://localhost:1234/v1', key: 'none', models: [],
    note: '在 LM Studio 的开发者页面打开服务并允许 CORS。', cors: true, editableUrl: true, concurrency: 2,
  },
  {
    id: 'custom', label: '自定义（OpenAI 兼容）', group: '其他', baseUrl: '', key: 'optional', models: [],
    note: '任何 OpenAI 兼容接口；需要它允许网页跨域访问。', cors: true, editableUrl: true,
  },
  {
    id: 'mock', label: '假模型（离线测试）', group: '其他', baseUrl: '', key: 'none', models: ['mock'],
    note: '不联网，按提示词随机选一项、写一句套话，用来试流程。', cors: true,
  },
];

export function presetById(id: string): ProviderPreset | undefined {
  return PRESETS.find((p) => p.id === id);
}

/** 这些多半不是对话模型 */
const NON_CHAT = /(embedding|embed-|tts|whisper|image|dall-e|audio|realtime|moderation|rerank|asr|ocr|video|music|speech|transcribe|seedance|kling|imagen|veo)/i;

/**
 * 向 /models 拉取这把密钥能用的对话模型，推荐模型排在前面。
 * baseUrl 默认用预置地址；浏览器访问不允许跨域的服务时传本站代理地址。请求失败时抛错。
 */
export async function fetchModels(
  preset: ProviderPreset, apiKey: string | undefined,
  opts: { baseUrl?: string; signal?: AbortSignal } = {},
): Promise<string[]> {
  const base = (opts.baseUrl ?? preset.baseUrl).replace(/\/+$/, '');
  const headers: Record<string, string> = {};
  if (apiKey) Object.assign(headers, { authorization: `Bearer ${apiKey}` }, preset.headers?.(apiKey));
  const res = await fetch(`${base}/models`, { headers, signal: opts.signal });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = await res.json() as { data?: unknown[] } | unknown[];
  const raw = (Array.isArray(data) ? data : data.data ?? []) as Array<Record<string, unknown>>;
  const ids: string[] = [];
  for (const m of raw) {
    const id = String(m.id ?? m.name ?? '').replace(/^models\//, '');
    if (!id || NON_CHAT.test(id)) continue;
    if (preset.modelFilter && !preset.modelFilter(id, m)) continue;
    if (!ids.includes(id)) ids.push(id);
  }
  const rank = (id: string) => { const i = preset.models.indexOf(id); return i < 0 ? 1e3 : i; };
  return ids.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}
