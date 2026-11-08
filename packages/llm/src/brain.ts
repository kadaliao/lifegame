import { REFLECT_KIND, type World } from '@lifegame/core';
import {
  LlmDecisionOutput, LlmPortraitOutput, LlmReflectionOutput,
  type Bot, type DecisionNode, type LifeStage,
} from '@lifegame/schema';
import type { z } from 'zod';
import { decisionMessages, portraitMessages, reflectionMessages } from './prompts.js';
import { LlmHttpError, hashString, type CompleteResult, type LlmMessage, type Provider } from './provider.js';
import { Limiter, backoffMs, isAbort, retryable, sleep } from './scheduler.js';

export interface UsageRecord {
  calls: number;
  input: number;
  output: number;
  cacheHits: number;
  errors: number;
  byModel: Record<string, { calls: number; input: number; output: number }>;
}

export function emptyUsage(): UsageRecord {
  return { calls: 0, input: 0, output: 0, cacheHits: 0, errors: 0, byModel: {} };
}

export interface ModelRef {
  providerId: string;
  model: string;
}

/** "aihubmix/gpt-4o-mini" → {providerId, model} */
export function parseModelRef(s: string | undefined, fallback: ModelRef): ModelRef {
  if (!s) return fallback;
  const i = s.indexOf('/');
  if (i < 0) return { providerId: fallback.providerId, model: s };
  return { providerId: s.slice(0, i), model: s.slice(i + 1) };
}

/** 模型对一个节点（决策或反思）的答案 */
export interface NodeAnswer {
  choice: string;
  monologue?: string;
  goal?: string;
  model: string;
}

/** 在决策提出那一刻准备好的请求：提示词已定，指纹已算 */
export interface Prepared {
  key: string;
  priority: number;
  run(signal?: AbortSignal): Promise<NodeAnswer>;
}

export interface BrainOptions {
  providers: Record<string, Provider>;
  defaultModel: ModelRef;
  /** 每个服务同时在路上的请求数，默认 4 */
  concurrency?: number | Record<string, number>;
  cache?: Map<string, CompleteResult>;
  onUsage?: (usage: UsageRecord, last: { model: string; usage: CompleteResult['usage'] }) => void;
  onTrace?: (trace: { kind: string; botId: string; messages: LlmMessage[]; result: string; ms: number }) => void;
  /** 以前的默认模型："服务/模型"。记着这些模型的人跟着现在的默认模型走（在设置里换了模型，不用重开世界） */
  followDefault?: string[];
  /** 某个服务的额度用完了（每个服务只报一次）；之后发给它的请求直接失败，不再联网 */
  onExhausted?: (providerId: string, error: LlmHttpError) => void;
}

/** 负责把世界状态变成提示词、调用模型、解析结果 */
export class Brain {
  readonly usage = emptyUsage();
  private cache: Map<string, CompleteResult>;
  private limiters = new Map<string, Limiter>();
  /** 额度用完的服务 */
  private exhausted = new Map<string, LlmHttpError>();
  /** 同一指纹的请求在路上时，后来者共享它 */
  private sharing = new Map<string, Promise<CompleteResult>>();

  constructor(private opts: BrainOptions) {
    this.cache = opts.cache ?? new Map();
  }

  /** 排队中和在路上的请求总数 */
  get queueDepth(): number {
    let n = 0;
    for (const l of this.limiters.values()) n += l.depth;
    return n;
  }

  /** 这个人用的模型。跟着以前的默认模型的、记录的服务不在了（读别处的存档）或额度用完的，用现在的默认模型 */
  private refOf(bot: Bot): ModelRef {
    if (bot.model && this.opts.followDefault?.includes(bot.model)) return this.opts.defaultModel;
    const ref = parseModelRef(bot.model, this.opts.defaultModel);
    if (!this.opts.providers[ref.providerId] || this.exhausted.has(ref.providerId)) return this.opts.defaultModel;
    return ref;
  }

  private limiter(providerId: string): Limiter {
    let l = this.limiters.get(providerId);
    if (!l) {
      const c = this.opts.concurrency;
      const max = typeof c === 'number' ? c : c?.[providerId] ?? 4;
      l = new Limiter(Math.max(1, max));
      this.limiters.set(providerId, l);
    }
    return l;
  }

  /**
   * 现在就生成提示词（世界会继续往前走），返回指纹和稍后执行的请求。
   * 指纹相同 = 发给模型的内容完全相同，重放时可以放心复用答案。
   */
  prepare(world: World, node: DecisionNode): Prepared {
    const bot = world.bot(node.botId)!;
    const ref = this.refOf(bot);
    const model = `${ref.providerId}/${ref.model}`;
    if (node.kind === REFLECT_KIND) {
      const messages = reflectionMessages(world, bot, node.data?.stage as LifeStage);
      const priority = 1e6 + node.dueTick;
      return {
        key: `${model}:${hashString(JSON.stringify(messages))}`,
        priority,
        run: async (signal) => {
          const out = await this.call('reflect', bot.id, ref, messages, LlmReflectionOutput, priority, signal);
          return { choice: 'done', monologue: out.reflection, goal: out.goal, model };
        },
      };
    }
    const messages = decisionMessages(world, bot, node);
    // 主角的请求永远排在配角前面，同级按到期先后
    const priority = (bot.lead ? -1e6 : 0) + node.dueTick;
    return {
      key: `${model}:${hashString(JSON.stringify(messages))}`,
      priority,
      run: async (signal) => {
        const out = await this.call('decide', bot.id, ref, messages, LlmDecisionOutput, priority, signal, (raw) => fixChoice(node, raw));
        return { choice: out.choice, monologue: out.monologue, goal: out.goal, model };
      },
    };
  }

  /** 提示词在调用时立刻生成（世界会继续往前走），请求按到期先后排队 */
  async decide(world: World, node: DecisionNode, signal?: AbortSignal): Promise<LlmDecisionOutput & { model: string }> {
    const bot = world.bot(node.botId)!;
    // 主角的请求永远排在配角前面，同级按到期先后
    const priority = (bot.lead ? -1e6 : 0) + node.dueTick;
    const ref = this.refOf(bot);
    const messages = decisionMessages(world, bot, node);
    const out = await this.call('decide', bot.id, ref, messages, LlmDecisionOutput, priority, signal, (raw) => fixChoice(node, raw));
    return { ...out, model: `${ref.providerId}/${ref.model}` };
  }

  async reflect(world: World, bot: Bot, endedStage: LifeStage): Promise<LlmReflectionOutput> {
    const ref = this.refOf(bot);
    return this.call('reflect', bot.id, ref, reflectionMessages(world, bot, endedStage), LlmReflectionOutput, 1e6 + world.tick, undefined);
  }

  async portrait(world: World, bot: Bot): Promise<string> {
    const ref = this.refOf(bot);
    const out = await this.call('portrait', bot.id, ref, portraitMessages(world, bot), LlmPortraitOutput, 1e6 + world.tick, undefined);
    return out.portrait;
  }

  private async call<T>(
    kind: string, botId: string, ref: ModelRef, messages: LlmMessage[], schema: z.ZodType<T>,
    priority: number, signal: AbortSignal | undefined, fix?: (raw: T) => T,
  ): Promise<T> {
    const provider = this.opts.providers[ref.providerId];
    if (!provider) throw new Error(Object.keys(this.opts.providers).length ? `未配置模型服务 ${ref.providerId}` : '没有可用的模型，可以在设置里填一个密钥');
    const key = `${ref.providerId}/${ref.model}:${hashString(JSON.stringify(messages))}`;
    const t0 = Date.now();
    let res = this.cache.get(key);
    if (res) {
      this.usage.cacheHits++;
    } else {
      const spent = this.exhausted.get(ref.providerId);
      if (spent) throw spent;
      let lastErr: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const msgs = attempt === 0 ? messages : [...messages, { role: 'user' as const, content: '上一次输出不是合法 JSON。请只输出一个 JSON 对象。' }];
          res = attempt === 0 ? await this.shared(key, () => this.completeWithRetry(provider, ref, msgs, priority, signal)) : await this.completeWithRetry(provider, ref, msgs, priority, signal);
          const parsed = this.parse(res.text, schema);
          if (parsed.ok) {
            this.record(ref, res);
            this.cache.set(key, res);
            this.opts.onTrace?.({ kind, botId, messages, result: res.text, ms: Date.now() - t0 });
            return fix ? fix(parsed.value) : parsed.value;
          }
          lastErr = parsed.error;
        } catch (e) {
          // 网络层已经重试过，这里直接放弃；取消不算错误
          if (!isAbort(e)) this.usage.errors++;
          throw e;
        }
      }
      throw new Error(`模型输出无法解析：${String(lastErr)}`);
    }
    const parsed = this.parse(res.text, schema);
    if (!parsed.ok) throw new Error(`缓存内容无法解析`);
    this.opts.onTrace?.({ kind, botId, messages, result: res.text, ms: Date.now() - t0 });
    return fix ? fix(parsed.value) : parsed.value;
  }

  /** 同一指纹已有请求在路上就共享它；那个请求被取消了，自己再发 */
  private async shared(key: string, fn: () => Promise<CompleteResult>): Promise<CompleteResult> {
    const existing = this.sharing.get(key);
    if (existing) {
      try { return await existing; } catch (e) { if (!isAbort(e)) throw e; }
    }
    const p = fn();
    this.sharing.set(key, p);
    try { return await p; } finally { if (this.sharing.get(key) === p) this.sharing.delete(key); }
  }

  /** 占一个并发名额发请求；限流或临时错误时让出名额、退避后重排 */
  private async completeWithRetry(provider: Provider, ref: ModelRef, messages: LlmMessage[], priority: number, signal?: AbortSignal): Promise<CompleteResult> {
    const limiter = this.limiter(ref.providerId);
    for (let attempt = 0; ; attempt++) {
      try {
        // 排队期间额度可能已经用完，轮到时再看一眼
        return await limiter.schedule(priority, () => {
          const spent = this.exhausted.get(ref.providerId);
          return spent ? Promise.reject(spent) : provider.complete({ model: ref.model, messages, json: true }, signal);
        }, signal);
      } catch (e) {
        if (isAbort(e)) throw e;
        if (e instanceof LlmHttpError && e.quota && !this.exhausted.has(ref.providerId)) {
          this.exhausted.set(ref.providerId, e);
          this.opts.onExhausted?.(ref.providerId, e);
        }
        if (attempt >= 4 || !retryable(e)) throw e;
        this.usage.errors++;
        await sleep(backoffMs(attempt, e));
      }
    }
  }

  private parse<T>(text: string, schema: z.ZodType<T>): { ok: true; value: T } | { ok: false; error: string } {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return { ok: false, error: '没有 JSON' };
    try {
      const obj = JSON.parse(m[0]);
      const r = schema.safeParse(obj);
      if (r.success) return { ok: true, value: r.data };
      return { ok: false, error: r.error.message };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  private record(ref: ModelRef, res: CompleteResult): void {
    const u = this.usage;
    u.calls++;
    u.input += res.usage.input;
    u.output += res.usage.output;
    const k = `${ref.providerId}/${ref.model}`;
    const bm = (u.byModel[k] ??= { calls: 0, input: 0, output: 0 });
    bm.calls++;
    bm.input += res.usage.input;
    bm.output += res.usage.output;
    this.opts.onUsage?.(u, { model: k, usage: res.usage });
  }
}

/** 容错：模型可能回 label 而不是 id */
function fixChoice(node: DecisionNode, raw: LlmDecisionOutput): LlmDecisionOutput {
  if (node.options.find((o) => o.id === raw.choice)) return raw;
  const byLabel = node.options.find((o) => o.label === raw.choice || raw.choice.includes(o.label) || o.label.includes(raw.choice));
  return { ...raw, choice: (byLabel ?? node.options[0]).id };
}
