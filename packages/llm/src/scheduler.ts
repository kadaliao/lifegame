import { LlmHttpError } from './provider.js';

interface Job {
  priority: number;
  seq: number;
  run: () => void;
}

/**
 * 每个模型服务一个：限制同时在路上的请求数，按优先级（数字小的先）排队。
 * 决策用到期 tick 当优先级，反思和旁白排在后面。
 */
export class Limiter {
  private active = 0;
  private queue: Job[] = [];
  private seq = 0;

  constructor(public max: number) {}

  get depth(): number {
    return this.queue.length + this.active;
  }

  /** signal 取消时：还在排队就直接移出，已经出发的由 fn 自己处理 */
  schedule<T>(priority: number, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) { reject(abortError()); return; }
      const job: Job = {
        priority,
        seq: this.seq++,
        run: () => {
          signal?.removeEventListener('abort', onAbort);
          fn().then(resolve, reject).finally(() => {
            this.active--;
            this.pump();
          });
        },
      };
      const onAbort = () => {
        const i = this.queue.indexOf(job);
        if (i >= 0) { this.queue.splice(i, 1); reject(abortError()); }
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(job);
      this.queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      this.pump();
    });
  }

  private pump(): void {
    while (this.active < this.max && this.queue.length) {
      const job = this.queue.shift()!;
      this.active++;
      job.run();
    }
  }
}

export function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

export function isAbort(e: unknown): boolean {
  return (e as { name?: string } | undefined)?.name === 'AbortError';
}

/** 限流、服务端临时错误、网络错误值得重试；4xx 里只有 408/409/429 */
export function retryable(e: unknown): boolean {
  if (e instanceof LlmHttpError) return e.status === 408 || e.status === 409 || e.status === 429 || e.status >= 500;
  if (isAbort(e)) return false;
  return true;
}

export function backoffMs(attempt: number, e: unknown): number {
  if (e instanceof LlmHttpError && e.retryAfterMs) return Math.min(30_000, e.retryAfterMs);
  return Math.min(20_000, 800 * 2 ** attempt) * (0.7 + Math.random() * 0.6);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
