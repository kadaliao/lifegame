/**
 * 开发服务器上的模型代理：浏览器请求 /llm/<服务>/chat/completions，
 * 这里在 Node 侧带上环境变量里的密钥转发给上游。密钥不会进入前端代码。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Connect, Plugin } from 'vite';
import { availableEnvProviders, discoverModels } from '../../packages/llm/src/env.js';

interface Listing { id: string; label: string; baseUrl: string; models: string[] }

export function llmEnvProxy(): Plugin {
  const defs = availableEnvProviders(process.env);
  let listing: Promise<Listing[]> | undefined;
  const list = () => {
    listing ??= Promise.all(defs.map(async (d) => ({
      id: d.id,
      label: `${d.label}（本机密钥）`,
      baseUrl: `/llm/${d.id}`,
      models: await discoverModels(d, process.env[d.envKey]!),
    })));
    return listing;
  };

  const handler: Connect.NextHandleFunction = (req, res, next) => {
    if (!req.url?.startsWith('/llm/')) return next();
    void handle(req, res).catch((e) => send(res, 502, { error: String(e) }));
  };

  async function handle(req: IncomingMessage, res: ServerResponse) {
    // 只接受同源请求，防止别的网页借本机密钥调用
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'cross-origin' });
    if (req.url === '/llm/env' && req.method === 'GET') return send(res, 200, { providers: await list() });
    const m = req.url!.match(/^\/llm\/([\w-]+)\/chat\/completions$/);
    const def = m ? defs.find((d) => d.id === m[1]) : undefined;
    if (!def || req.method !== 'POST') return send(res, 404, { error: 'not found' });
    if (!String(req.headers['content-type'] ?? '').includes('application/json')) return send(res, 415, { error: 'json only' });
    const body = await readBody(req);
    const upstream = await fetch(`${def.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env[def.envKey]}` },
      body,
    });
    res.statusCode = upstream.status;
    res.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/json');
    res.end(Buffer.from(await upstream.arrayBuffer()));
  }

  return {
    name: 'lifegame-llm-env-proxy',
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}

function send(res: ServerResponse, status: number, data: unknown) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
