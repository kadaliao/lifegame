import { describe, expect, it } from 'vitest';
import { World } from '@lifegame/core';
import { chinaModern } from '../../eras/src/index.js';
import { Brain } from './brain.js';
import { PRESETS } from './presets.js';
import { LlmHttpError, isQuotaError, type Provider } from './provider.js';
import { retryable } from './scheduler.js';
import { createLlmProxy, modelsEnvKey } from './proxy.js';
import { migratePrefs, resolveBrain, type LlmPrefs } from './setup.js';

const prefs = (p: Partial<LlmPrefs> = {}): LlmPrefs => ({ level: 2, services: {}, ...p });
const site = [{ id: 'deepseek', label: 'DeepSeek', models: ['deepseek-flash'] }];

describe('选用哪个模型', () => {
  it('什么都没有：纯规则', () => {
    const r = resolveBrain(prefs(), [], false);
    expect(r.source).toBe('rules');
    expect(r.level).toBe(0);
    expect(r.defaultModel).toBe('');
  });

  it('没有密钥：用免费服务，并发 1', () => {
    const r = resolveBrain(prefs(), [], true);
    expect(r.source).toBe('free');
    expect(r.defaultModel).toBe('llm7/mistral-Nemo-Instruct-2407');
    expect(r.providers.find((p) => p.id === 'llm7')?.concurrency).toBe(1);
  });

  it('站点提供的优先于免费的，自己的密钥优先于站点的', () => {
    expect(resolveBrain(prefs(), site, true).defaultModel).toBe('deepseek/deepseek-flash');
    const own = resolveBrain(prefs({ services: { siliconflow: { apiKey: 'k' } } }), site, true);
    expect(own.source).toBe('own');
    expect(own.defaultModel).toBe('siliconflow/Qwen/Qwen3-8B');
  });

  it('自己填了站点也有的服务：用自己的密钥直连', () => {
    const r = resolveBrain(prefs({ services: { deepseek: { apiKey: 'mine', models: ['deepseek-v4-pro'] } } }), site, false);
    const p = r.providers.find((x) => x.id === 'deepseek')!;
    expect(p.env).toBeFalsy();
    expect(p.apiKey).toBe('mine');
    expect(p.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(r.defaultModel).toBe('deepseek/deepseek-v4-pro');
  });

  it('不允许跨域的服务经本站代理', () => {
    const r = resolveBrain(prefs({ services: { zhipu: { apiKey: 'k' } } }), [], false);
    expect(r.providers[0].baseUrl).toBe('/api/llm/zhipu');
    expect(resolveBrain(prefs(), site, false).providers[0].baseUrl).toBe('/api/llm/site/deepseek');
  });

  it('明确选的模型：本地服务不要密钥；站点只放行列出的模型', () => {
    const local = resolveBrain(prefs({ model: 'ollama/qwen3:8b', services: { ollama: { baseUrl: 'http://127.0.0.1:11434/v1/' } } }), [], false);
    expect(local.source).toBe('chosen');
    expect(local.providers[0].baseUrl).toBe('http://127.0.0.1:11434/v1');
    const typed = resolveBrain(prefs({ model: 'deepseek/whatever' }), site, false);
    expect(typed.defaultModel).toBe('deepseek/deepseek-flash');
    expect(typed.source).toBe('site');
  });

  it('选了要密钥却没填的服务：退回自动', () => {
    const r = resolveBrain(prefs({ model: 'openai/gpt-5.4-mini' }), [], true);
    expect(r.source).toBe('free');
  });

  it('选了免费服务但它连不上：纯规则', () => {
    expect(resolveBrain(prefs({ model: 'llm7/gpt-oss:20b' }), [], false).source).toBe('rules');
    expect(resolveBrain(prefs({ model: 'llm7/gpt-oss:20b' }), [], true).defaultModel).toBe('llm7/gpt-oss:20b');
  });

  it('旧版设置迁移：留下密钥，丢掉假模型和本机密钥服务', () => {
    const p = migratePrefs({
      level: 1, defaultModel: 'mock/mock',
      providers: [
        { id: 'aihubmix', kind: 'openai-compatible', models: [], env: true },
        { id: 'deepseek', kind: 'openai-compatible', models: [], apiKey: 'sk-1' },
        { id: 'ollama', kind: 'openai-compatible', models: [], apiKey: 'ollama' },
      ],
    });
    expect(p).toEqual({ level: 1, services: { deepseek: { apiKey: 'sk-1' } } });
  });

  it('预置服务的编号不重复，地址都是 https（本地的除外）', () => {
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length);
    for (const p of PRESETS) if (p.baseUrl && p.group !== '本地') expect(p.baseUrl).toMatch(/^https:\/\//);
  });
});

describe('模型代理', () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }, { id: 'text-embedding-x' }] }));
    return new Response('{"choices":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const env = { DEEPSEEK_API_KEY: 'site-key', [modelsEnvKey('DEEPSEEK_API_KEY')]: 'deepseek-flash' };
  const proxy = createLlmProxy(env, fakeFetch);
  const H = { host: 'lg.test', origin: 'https://lg.test', 'content-type': 'application/json' };
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    proxy(new Request(`https://lg.test${path}`, { method: 'POST', headers: { ...H, ...headers }, body: JSON.stringify(body) }));

  it('列出站点服务，不暴露密钥', async () => {
    const r = await proxy(new Request('https://lg.test/api/llm/site', { headers: { host: 'lg.test' } }));
    const text = await r.text();
    expect(JSON.parse(text).providers).toEqual([{ id: 'deepseek', label: 'DeepSeek', models: ['deepseek-flash'] }]);
    expect(text).not.toContain('site-key');
  });

  it('站点密钥只放行列出的模型', async () => {
    expect((await post('/api/llm/site/deepseek/chat/completions', { model: 'deepseek-v4-pro' })).status).toBe(403);
    calls.length = 0;
    expect((await post('/api/llm/site/deepseek/chat/completions', { model: 'deepseek-flash' })).status).toBe(200);
    expect(calls[0].url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer site-key');
  });

  it('访客自己的密钥原样转发到预置地址；没有密钥拒绝', async () => {
    calls.length = 0;
    expect((await post('/api/llm/zhipu/chat/completions', { model: 'glm-4.7-flash' }, { authorization: 'Bearer mine' })).status).toBe(200);
    expect(calls[0].url).toBe('https://open.bigmodel.cn/api/paas/v4/chat/completions');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer mine');
    expect((await post('/api/llm/zhipu/chat/completions', { model: 'glm-4.7-flash' })).status).toBe(401);
  });

  it('拒绝跨站请求、未知服务、本地和自定义地址', async () => {
    expect((await post('/api/llm/site/deepseek/chat/completions', { model: 'deepseek-flash' }, { origin: 'https://evil.test' })).status).toBe(403);
    expect((await post('/api/llm/nope/chat/completions', {}, { authorization: 'Bearer x' })).status).toBe(404);
    expect((await post('/api/llm/ollama/chat/completions', {}, { authorization: 'Bearer x' })).status).toBe(404);
    expect((await post('/api/llm/custom/chat/completions', {}, { authorization: 'Bearer x' })).status).toBe(404);
    expect((await post('/api/llm/zhipu/embeddings', {}, { authorization: 'Bearer x' })).status).toBe(404);
  });

  it('Vercel 改写后路径在查询参数里', async () => {
    const r = await proxy(new Request('https://lg.test/api/llm?path=site', { headers: { host: 'lg.test' } }));
    expect(r.status).toBe(200);
  });
});

describe('额度用完', () => {
  it('识别额度用完的 429/402，不重试', () => {
    expect(isQuotaError(429, '{"error":{"type":"insufficient_quota","message":"Daily token quota exceeded."}}')).toBe(true);
    expect(isQuotaError(402, '{"error":"Insufficient credits"}')).toBe(true);
    expect(isQuotaError(429, '{"error":{"message":"Too many concurrent requests for this client. Retry after 10 seconds."}}')).toBe(false);
    expect(retryable(new LlmHttpError('x', 429, 1000, true))).toBe(false);
    expect(retryable(new LlmHttpError('x', 429, 1000))).toBe(true);
  });

  it('只报一次，之后的请求不再联网，按性格决定', async () => {
    let hits = 0;
    const broke: Provider = { id: 'broke', complete: async () => { hits++; throw new LlmHttpError('LLM 429: quota', 429, 58_000, true); } };
    const spent: string[] = [];
    const brain = new Brain({ providers: { broke }, defaultModel: { providerId: 'broke', model: 'm' }, onExhausted: (id) => spent.push(id) });
    const w = World.create(chinaModern, { seed: 3, eraId: 'china-modern', population: 30, startYear: 1980, endYear: 2000, birthSpan: 10 });
    const bot = w.bot(w.state.botOrder[0])!;
    await expect(brain.portrait(w, bot)).rejects.toThrow(/quota/);
    await expect(brain.portrait(w, w.bot(w.state.botOrder[1])!)).rejects.toThrow(/quota/);
    expect(hits).toBe(1);
    expect(spent).toEqual(['broke']);
  });
});
