/**
 * Vercel 函数：模型代理，逻辑见 packages/llm/src/proxy.ts（开发服务器用的也是它）。
 * vercel.json 把 /api/llm/* 都改写到这里。
 * 在 Vercel 项目的环境变量里放 DEEPSEEK_API_KEY 之类的密钥，访客不填密钥也能用；不放就只做转发。
 */
import { createLlmProxy } from '../packages/llm/src/proxy.js';

const proxy = createLlmProxy(process.env);

export function GET(request: Request): Promise<Response> {
  return proxy(request);
}

export function POST(request: Request): Promise<Response> {
  return proxy(request);
}
