import { describe, expect, it } from 'vitest';
import { Limiter, retryable } from './scheduler.js';
import { LlmHttpError } from './provider.js';

describe('Limiter', () => {
  it('同时在路上的请求不超过上限，排队的按优先级出发', async () => {
    const l = new Limiter(2);
    let active = 0;
    let peak = 0;
    const started: number[] = [];
    const job = (p: number) => l.schedule(p, async () => {
      started.push(p);
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      return p;
    });
    const results = await Promise.all([job(50), job(40), job(30), job(10), job(20)]);
    expect(peak).toBe(2);
    expect(results).toEqual([50, 40, 30, 10, 20]);
    // 前两个立刻出发，其余按优先级
    expect(started).toEqual([50, 40, 10, 20, 30]);
  });

  it('取消排队中的请求：移出队列，不占名额', async () => {
    const l = new Limiter(1);
    const ran: string[] = [];
    const slow = l.schedule(0, async () => { ran.push('a'); await new Promise((r) => setTimeout(r, 20)); });
    const ctl = new AbortController();
    const dropped = l.schedule(1, async () => { ran.push('b'); }, ctl.signal);
    const kept = l.schedule(2, async () => { ran.push('c'); });
    ctl.abort();
    await expect(dropped).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.all([slow, kept]);
    expect(ran).toEqual(['a', 'c']);
  });

  it('只重试限流、超时和服务端错误', () => {
    expect(retryable(new LlmHttpError('x', 429))).toBe(true);
    expect(retryable(new LlmHttpError('x', 503))).toBe(true);
    expect(retryable(new LlmHttpError('x', 403))).toBe(false);
    expect(retryable(new LlmHttpError('x', 400))).toBe(false);
    expect(retryable(new TypeError('fetch failed'))).toBe(true);
  });
});
