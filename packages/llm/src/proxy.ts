/**
 * 模型代理，开发服务器（apps/web/llm-proxy.ts）和 Vercel 函数（api/llm.ts）共用：
 *
 *   GET  /api/llm/site                        站点提供的服务（部署方在环境变量里放的密钥）及可用模型
 *   POST /api/llm/site/<id>/chat/completions  用站点密钥调用，只放行列出的模型
 *   GET  /api/llm/<id>/models                 用访客自己的密钥（Authorization 头）转发
 *   POST /api/llm/<id>/chat/completions       同上，给不允许网页跨域的服务用
 *
 * 只转发到 presets.ts 里的预置地址，不是开放代理；只接受同源请求，别的网页借不走站点密钥。
 * 站点密钥默认放行 /models 拉到的全部模型；设置 <前缀>_MODELS（如 DEEPSEEK_MODELS=deepseek-flash）只放行这几个。
 */
import { PRESETS, fetchModels, presetById, type ProviderPreset } from './presets.js';

export interface SiteProvider {
  id: string;
  label: string;
  models: string[];
  concurrency?: number;
}

type Env = Record<string, string | undefined>;

/** 请求体上限，防止被拿来转发大文件 */
const MAX_BODY = 256 * 1024;

/** DEEPSEEK_API_KEY → DEEPSEEK_MODELS */
export function modelsEnvKey(envKey: string): string {
  return envKey.replace(/_API_KEY$|_KEY$/, '') + '_MODELS';
}

export function sitePresets(env: Env): ProviderPreset[] {
  return PRESETS.filter((p) => p.envKey && env[p.envKey]);
}

export function createLlmProxy(env: Env, fetchImpl: typeof fetch = fetch): (req: Request) => Promise<Response> {
  const site = sitePresets(env);
  let listing: Promise<SiteProvider[]> | undefined;
  const list = () => {
    listing ??= Promise.all(site.map(async (p): Promise<SiteProvider> => {
      const fixed = env[modelsEnvKey(p.envKey!)]?.split(',').map((s) => s.trim()).filter(Boolean);
      let models = fixed;
      if (!models?.length) {
        try { models = await fetchModels(p, env[p.envKey!], { signal: AbortSignal.timeout(8000) }); } catch { models = []; }
        if (!models.length) models = p.models;
      }
      return { id: p.id, label: p.label, models, concurrency: p.concurrency };
    })).then((ls) => ls.filter((l) => l.models.length));
    return listing;
  };

  return async (req) => {
    try {
      const url = new URL(req.url);
      // Vercel 经 rewrite 进来时路径可能在查询参数里
      const path = url.pathname.startsWith('/api/llm/') ? url.pathname.slice('/api/llm'.length) : `/${url.searchParams.get('path') ?? ''}`;
      const origin = req.headers.get('origin');
      const host = req.headers.get('host') ?? url.host;
      if (origin && safeHost(origin) !== host) return json(403, { error: 'cross-origin' });

      if (path === '/site') {
        if (req.method !== 'GET') return json(405, { error: 'method not allowed' });
        return json(200, { providers: await list() });
      }
      const m = path.match(/^\/(site\/)?([\w-]+)\/(chat\/completions|models)$/);
      const preset = m ? presetById(m[2]) : undefined;
      if (!m || !preset || !preset.baseUrl || preset.editableUrl) return json(404, { error: 'not found' });
      const op = m[3];
      if (req.method !== (op === 'models' ? 'GET' : 'POST')) return json(405, { error: 'method not allowed' });

      let key: string | undefined;
      let body: string | undefined;
      if (op !== 'models') {
        if (!String(req.headers.get('content-type') ?? '').includes('application/json')) return json(415, { error: 'json only' });
        body = await req.text();
        if (body.length > MAX_BODY) return json(413, { error: 'too large' });
      }
      if (m[1]) {
        // 站点密钥：只放行列出的模型
        key = preset.envKey ? env[preset.envKey] : undefined;
        const entry = key ? (await list()).find((s) => s.id === preset.id) : undefined;
        if (!key || !entry) return json(404, { error: 'not configured' });
        if (op === 'models') return json(200, { data: entry.models.map((id) => ({ id })) });
        let model = '';
        try { model = String((JSON.parse(body!) as { model?: unknown }).model ?? ''); } catch { return json(400, { error: 'bad json' }); }
        if (!entry.models.includes(model)) return json(403, { error: `本站没有开放模型 ${model}` });
      } else {
        key = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim() || undefined;
        if (!key && preset.key === 'required') return json(401, { error: '缺少密钥' });
      }

      const headers: Record<string, string> = { accept: 'application/json' };
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (key) Object.assign(headers, { authorization: `Bearer ${key}` }, preset.headers?.(key));
      const upstream = await fetchImpl(`${preset.baseUrl}/${op}`, { method: req.method, headers, body });
      const out = new Headers({ 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' });
      const ra = upstream.headers.get('retry-after');
      if (ra) out.set('retry-after', ra);
      return new Response(await upstream.arrayBuffer(), { status: upstream.status, headers: out });
    } catch (e) {
      return json(502, { error: String(e).slice(0, 300) });
    }
  };
}

function safeHost(origin: string): string | undefined {
  try { return new URL(origin).host; } catch { return undefined; }
}

function json(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
