export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompleteRequest {
  model: string;
  messages: LlmMessage[];
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
}

export interface Usage {
  input: number;
  output: number;
}

export interface CompleteResult {
  text: string;
  usage: Usage;
  model: string;
}

/** 带 HTTP 状态的错误，调度器据此决定是否重试 */
export class LlmHttpError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterMs?: number) {
    super(message);
  }
}

export interface Provider {
  id: string;
  complete(req: CompleteRequest, signal?: AbortSignal): Promise<CompleteResult>;
}

/** 单次请求的超时；超时按临时错误处理，由调度器重试 */
export const REQUEST_TIMEOUT_MS = 45_000;

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const t = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, t]) : t;
}

export interface ProviderConfig {
  id: string;
  label?: string;
  kind: 'openai-compatible' | 'mock';
  baseUrl?: string;
  apiKey?: string;
  /** 可选模型列表，供界面下拉 */
  models: string[];
  /** 密钥来自开发服务器的环境变量，浏览器经本地代理访问 */
  env?: boolean;
}

/** OpenAI 兼容接口：aihubmix、OpenRouter、Ollama(/v1)、vLLM 等都能用 */
export class OpenAICompatibleProvider implements Provider {
  readonly id: string;
  private baseUrl: string;
  private apiKey?: string;

  constructor(cfg: ProviderConfig) {
    this.id = cfg.id;
    this.baseUrl = (cfg.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.apiKey = cfg.apiKey;
  }

  async complete(req: CompleteRequest, signal?: AbortSignal): Promise<CompleteResult> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      temperature: req.temperature ?? 0.8,
      max_tokens: req.maxTokens ?? 400,
    };
    if (req.json) body.response_format = { type: 'json_object' };
    let res = await fetch(`${this.baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal: withTimeout(signal, REQUEST_TIMEOUT_MS) });
    if (!res.ok && req.json && res.status === 400) {
      // 有些后端不支持 response_format，去掉重试
      delete body.response_format;
      res = await fetch(`${this.baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal: withTimeout(signal, REQUEST_TIMEOUT_MS) });
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      const ra = Number(res.headers.get('retry-after'));
      throw new LlmHttpError(`LLM ${res.status}: ${txt.slice(0, 300)}`, res.status, Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined);
    }
    // 有的服务会在 JSON 字符串里放裸换行，标准解析会失败；把控制字符换成空格再试
    const bodyText = await res.text();
    let parsed: unknown;
    try { parsed = JSON.parse(bodyText); } catch { parsed = JSON.parse(bodyText.replace(/[\u0000-\u001f]/g, ' ')); }
    const data = parsed as {
      choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      model?: string;
    };
    const raw = data.choices?.[0]?.message?.content;
    const text = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map((p) => p.text ?? '').join('') : '';
    return {
      text,
      usage: { input: data.usage?.prompt_tokens ?? 0, output: data.usage?.completion_tokens ?? 0 },
      model: data.model ?? req.model,
    };
  }
}

/** 零成本假模型：按 prompt 哈希确定性地选一项，写一句套话 */
export class MockProvider implements Provider {
  readonly id: string;
  constructor(id = 'mock') { this.id = id; }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const user = req.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    const h = hashString(user);
    const optionIds = [...user.matchAll(/^- \[([^\]]+)\]/gm)].map((m) => m[1]);
    let text: string;
    if (optionIds.length) {
      const choice = optionIds[h % optionIds.length];
      text = JSON.stringify({ choice, monologue: MOCK_LINES[h % MOCK_LINES.length] });
    } else if (/阶段/.test(user)) {
      text = JSON.stringify({ reflection: '这几年过得像一阵风，回头看，有些事做对了，有些事只能认了。' });
    } else {
      text = JSON.stringify({ portrait: '一个普普通通、却不甘心一直普通的人。' });
    }
    await new Promise((r) => setTimeout(r, 30));
    return { text, usage: { input: Math.ceil(user.length / 2), output: Math.ceil(text.length / 2) }, model: 'mock' };
  }
}

const MOCK_LINES = [
  '也没什么好犹豫的，走一步看一步吧。',
  '爸妈那边不好交代，但这是我自己的日子。',
  '心里没底，可机会就这一次。',
  '稳一点，先把眼前的日子过好。',
  '要是当年有人这样劝我就好了。',
];

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function createProvider(cfg: ProviderConfig): Provider {
  if (cfg.kind === 'mock') return new MockProvider(cfg.id);
  return new OpenAICompatibleProvider(cfg);
}

export const DEFAULT_PROVIDERS: ProviderConfig[] = [
  { id: 'mock', label: '假模型（免费测试）', kind: 'mock', models: ['mock'] },
  { id: 'aihubmix', label: 'aihubmix', kind: 'openai-compatible', baseUrl: 'https://aihubmix.com/v1', models: ['gpt-4o-mini', 'gpt-4o', 'claude-sonnet-4-5', 'gemini-2.5-flash', 'deepseek-v3'] },
  { id: 'ollama', label: 'Ollama 本地', kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', apiKey: 'ollama', models: ['qwen3:8b', 'qwen2.5:7b', 'llama3.1:8b'] },
  { id: 'openai', label: 'OpenAI', kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o-mini', 'gpt-4o'] },
  { id: 'deepseek', label: 'DeepSeek', kind: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat'] },
];
