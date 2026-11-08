/**
 * 开发服务器上的模型代理：/api/llm/* 交给 packages/llm/src/proxy.ts，和 Vercel 上的 api/llm.ts 是同一份逻辑。
 * 本机环境变量里的密钥（DEEPSEEK_API_KEY 等）作为"站点密钥"提供给页面，密钥不会进入前端代码。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Connect, Plugin } from 'vite';
import { createLlmProxy } from '../../packages/llm/src/proxy.js';

export function llmEnvProxy(): Plugin {
  const proxy = createLlmProxy(process.env);

  const handler: Connect.NextHandleFunction = (req, res, next) => {
    if (!req.url?.startsWith('/api/llm/')) return next();
    void handle(req, res).catch((e) => {
      res.statusCode = 502;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: String(e) }));
    });
  };

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const request = new Request(`http://${req.headers.host ?? 'localhost'}${req.url}`, {
      method: req.method, headers, body: hasBody ? new Uint8Array(await readBody(req)) : undefined,
    });
    const response = await proxy(request);
    res.statusCode = response.status;
    response.headers.forEach((v, k) => res.setHeader(k, v));
    res.end(Buffer.from(await response.arrayBuffer()));
  }

  return {
    name: 'lifegame-llm-proxy',
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
