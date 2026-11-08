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
  constructor(message: string, readonly status: number, readonly retryAfterMs?: number, readonly quota = false) {
    super(message);
  }
}

/** 额度或余额用完：重试没用，要等到明天或者充值 */
export function isQuotaError(status: number, body: string): boolean {
  return status === 402 || (status === 429 && /insufficient_quota|quota_exceeded|quota exceeded|daily .*quota|余额|额度/i.test(body));
}

export interface Provider {
  id: string;
  complete(req: CompleteRequest, signal?: AbortSignal): Promise<CompleteResult>;
}

/** 单次请求的超时；超时按临时错误处理，由调度器重试 */
export const REQUEST_TIMEOUT_MS = 45_000;

/**
 * 等一个请求，但取消或超时只是"不再等它"，不去中断底层连接。
 * Node 自带的 fetch 走 HTTP/2 时，中断在途的流会让 submitRstStream 陷入死循环、把进程卡死；
 * 已经发出的请求让它自然完成，结果丢掉即可。
 */
function giveUpOn<T>(p: Promise<T>, signal: AbortSignal | undefined, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) { reject(abortErr()); return; }
    const onAbort = () => { cleanup(); reject(abortErr()); };
    const timer = setTimeout(() => { cleanup(); reject(new LlmHttpError(`LLM 请求超过 ${ms / 1000} 秒没有回应`, 408)); }, ms);
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    signal?.addEventListener('abort', onAbort, { once: true });
    p.then((v) => { cleanup(); resolve(v); }, (e) => { cleanup(); reject(e); });
  });
}

function abortErr(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

export interface ProviderConfig {
  id: string;
  label?: string;
  kind: 'openai-compatible' | 'mock';
  baseUrl?: string;
  apiKey?: string;
  /** 可选模型列表，供界面下拉 */
  models: string[];
  /** 站点提供的服务：密钥在服务器的环境变量里，浏览器经 /api/llm/site/<id> 访问 */
  env?: boolean;
  /** 同时在路上的请求数上限，默认 4 */
  concurrency?: number;
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
    const post = () => giveUpOn(
      fetch(`${this.baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) }).then(async (r) => ({ r, text: await r.text() })),
      signal, REQUEST_TIMEOUT_MS,
    );
    let { r: res, text: bodyText } = await post();
    if (!res.ok && req.json && res.status === 400) {
      // 有些后端不支持 response_format，去掉重试
      delete body.response_format;
      ({ r: res, text: bodyText } = await post());
    }
    if (!res.ok) {
      const ra = Number(res.headers.get('retry-after'));
      throw new LlmHttpError(`LLM ${res.status}: ${bodyText.slice(0, 300)}`, res.status, Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined, isQuotaError(res.status, bodyText));
    }
    // 有的服务会在 JSON 字符串里放裸换行，标准解析会失败；把控制字符换成空格再试
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
