/**
 * 用真模型跑一个世界：
 *   pnpm cli:live -- --model=aihubmix/qwen3-vl-plus --heroes=1 --seed=42
 *   pnpm cli:live -- --heroes=12 --level=1 --quiet     # 压力测试：很多智能人格同时活
 *   pnpm cli:live -- --heroes=12 --leads=3 --speed=2 --quiet
 *       模拟一个 2 年/秒播放的画面：前 3 人是主角（世界可以等他们），
 *       其余和继承来的子女是配角（画面追上时凭直觉选），统计用户实际会看到的停顿。
 * 密钥从环境变量读，不会打印。结果写到 runs/。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { World, stageName } from '@lifegame/core';
import { getEra } from '@lifegame/eras';
import { Brain, ENV_PROVIDERS, MockProvider, createProvider, envProviderConfig, type LlmMessage, type Provider } from '@lifegame/llm';
import { tickToYearMonth, type DecisionNode, type LifeStage } from '@lifegame/schema';

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? 'true'];
}));

const modelRef = args.model ?? 'aihubmix/qwen3-vl-plus';
const [providerId, ...rest] = modelRef.split('/');
const model = rest.join('/');
const seed = Number(args.seed ?? 42);
const population = Number(args.pop ?? 200);
const heroCount = Number(args.heroes ?? 1);
const level = Number(args.level ?? 2);
const endYear = Number(args.end ?? 2060);
const concurrency = Number(args.concurrency ?? 4);
const inherit = args.inherit !== 'false';
const quiet = args.quiet === 'true';
/** 画面播放速度（年/秒）；0 表示不模拟画面，世界总是等模型 */
const speed = Number(args.speed ?? 0);
const ahead = speed ? Math.max(60, Math.min(600, Math.round(speed * 12 * 12))) : Infinity;

const providers: Record<string, Provider> = { mock: new MockProvider() };
for (const def of ENV_PROVIDERS) {
  if (process.env[def.envKey]) providers[def.id] = createProvider(envProviderConfig(def, process.env, []));
}
if (!providers[providerId]) {
  console.error(`没有 ${providerId} 的密钥。可用：${Object.keys(providers).join(', ')}`);
  process.exit(1);
}

interface Trace { kind: string; botId: string; ms: number; messages: LlmMessage[]; result: string }
const traces: Trace[] = [];
const brain = new Brain({ providers, defaultModel: { providerId, model }, concurrency, onTrace: (t) => traces.push(t) });

const era = getEra('china-modern');
const world = World.create(era, { seed, eraId: era.id, population, startYear: era.defaultStartYear, endYear, birthSpan: era.defaultBirthSpan });
const order = world.state.botOrder;
const heroes: string[] = [];
const step = Math.max(1, Math.floor(order.length / heroCount));
for (let i = Number(args.hero ?? 0); i < order.length && heroes.length < heroCount; i += step) heroes.push(order[i]);
const leadCount = Number(args.leads ?? heroes.length);
heroes.forEach((id, i) => world.setIntelligence(id, 'llm', modelRef, i < leadCount));
const focus = world.bot(heroes[0])!;
const STAGES: LifeStage[] = ['infant', 'child', 'teen', 'youth', 'adult', 'middle', 'senior'];
const log = (s: string) => { if (!quiet) process.stdout.write(s + '\n'); };

const favorite = (n: DecisionNode) => n.options.reduce((a, b) => ((b.weight ?? 1) > (a.weight ?? 1) ? b : a)).id;

let decisions = 0;
let differ = 0;
let failures = 0;
let blockedMs = 0;
let peakInflight = 0;
let autoCount = 0;
let visibleStallMs = 0;
let maxVisibleStallMs = 0;
const inflight = new Map<string, Promise<void>>();
const aborts = new Map<string, AbortController>();
const background: Promise<unknown>[] = [];

function dispatch() {
  for (const node of world.pending) {
    if (inflight.has(node.id)) continue;
    const ctl = new AbortController();
    aborts.set(node.id, ctl);
    const p = brain.decide(world, node, ctl.signal)
      .then((r) => {
        world.resolveDecision(node.id, r.choice, 'llm', r.monologue, r.model);
        const bot = world.bot(node.botId);
        if (bot && r.goal) bot.goal = r.goal;
      })
      .catch((err) => {
        if (ctl.signal.aborted) return;
        failures++;
        world.resolveDecision(node.id, favorite(node), 'auto');
        log(`  决策失败，按性格：${String(err).slice(0, 120)}`);
      })
      .finally(() => { inflight.delete(node.id); aborts.delete(node.id); });
    inflight.set(node.id, p);
    peakInflight = Math.max(peakInflight, inflight.size);
  }
}

function report(node: DecisionNode) {
  decisions++;
  if (node.chosen !== favorite(node)) differ++;
  if (node.botId !== focus.id) return;
  const { year } = tickToYearMonth(node.tick, world.state.config.startYear);
  const age = Math.floor((node.tick - focus.birthTick) / 12);
  const opt = node.options.find((o) => o.id === node.chosen);
  log(`${year}（${age}岁）${node.situation}\n  → ${opt?.label}${node.chosen !== favorite(node) ? '  ※ 与规则首选不同' : ''}\n  「${node.monologue ?? ''}」`);
}

async function main() {
  log(`模型 ${modelRef} · 种子 ${seed} · 智能人格 ${heroes.length} 人（主角 ${Math.min(leadCount, heroes.length)}） · 并发 ${concurrency} · 档位 ${level}${speed ? ` · 画面 ${speed} 年/秒` : ''}`);
  log(`跟随：${focus.name}（${focus.id}）`);
  if (level >= 2) {
    try { focus.portrait = await brain.portrait(world, focus); log(`旁白：${focus.portrait}`); } catch (e) { failures++; }
  }
  const t0 = Date.now();
  // 模拟画面：按速度前进，但不能超过模拟
  let display = 0;
  let last = Date.now();
  const advance = () => {
    const now = Date.now();
    if (speed) display = Math.min(world.tick, display + speed * 12 * ((now - last) / 1000));
    last = now;
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  while (!world.finished) {
    advance();
    dispatch();
    if (world.tick >= display + ahead) { await sleep(20); continue; }
    const res = world.step();
    for (const e of res.events) {
      if (e.type === 'decision' && e.decisionId) {
        const n = world.state.decisions[e.decisionId];
        if (n.resolvedBy !== 'rules') report(n);
      }
      if (e.type === 'child' && inherit && e.relatedIds) {
        const parent = world.bot(e.botId!);
        const child = world.bot(e.relatedIds[1]);
        // 继承来的是配角
        if (parent?.intelligence === 'llm' && child && child.intelligence !== 'llm') world.setIntelligence(child.id, 'llm', modelRef, false);
      }
      // 阶段反思不挡世界
      if (e.type === 'stage' && level >= 2) {
        const bot = world.bot(e.botId!);
        const idx = STAGES.indexOf(e.data?.stage as LifeStage);
        if (!bot || bot.intelligence !== 'llm' || idx <= 1) continue;
        const ended = STAGES[idx - 1];
        background.push(brain.reflect(world, bot, ended).then((r) => {
          bot.reflections.push({ stage: ended, tick: e.tick, text: r.reflection });
          if (r.goal) bot.goal = r.goal;
          if (bot.id === focus.id) log(`  ── ${stageName(ended)}反思：${r.reflection}`);
        }).catch(() => { failures++; }));
      }
    }
    if (res.pending.length) dispatch();
    if (res.blocked.length) {
      const b0 = Date.now();
      let stall = 0;
      for (;;) {
        advance();
        const still = res.blocked.filter((n) => n.chosen === undefined);
        if (!still.length) break;
        const waits = still.map((n) => inflight.get(n.id)).filter(Boolean) as Promise<void>[];
        // 配角：缓冲不到一半就凭直觉，把缓冲留给主角
        if (speed && world.tick - display <= ahead / 2) {
          for (const n of still) {
            if (world.bot(n.botId)?.lead) continue;
            world.resolveDecision(n.id, favorite(n), 'auto', '（来不及细想，凭直觉选了）');
            aborts.get(n.id)?.abort();
            autoCount++;
          }
        }
        if (speed && display >= world.tick - 1) {
          // 画面追上了：只剩主角在让世界等，用户能看到这段停顿
          for (const n of still) {
            if (world.bot(n.botId)?.lead || n.chosen !== undefined) continue;
            world.resolveDecision(n.id, favorite(n), 'auto', '（来不及细想，凭直觉选了）');
            aborts.get(n.id)?.abort();
            autoCount++;
          }
          if (still.every((n) => n.chosen !== undefined)) break;
          const s0 = Date.now();
          await Promise.race([...waits, sleep(50)]);
          stall += Date.now() - s0;
        } else {
          await Promise.race([...waits, sleep(20)]);
        }
      }
      visibleStallMs += stall;
      maxVisibleStallMs = Math.max(maxVisibleStallMs, stall);
      blockedMs += Date.now() - b0;
    }
  }
  await Promise.allSettled(background);
  const ms = Date.now() - t0;
  const lat = traces.filter((t) => t.kind === 'decide').map((t) => t.ms).sort((a, b) => a - b);
  const pct = (p: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] : 0);
  const serialMs = lat.reduce((a, b) => a + b, 0);
  const u = brain.usage;
  const heroesAtEnd = world.state.botOrder.filter((id) => world.state.bots[id].intelligence === 'llm').length;
  const summary = {
    model: modelRef, seed, concurrency,
    heroesAtStart: heroes.length, heroesAtEnd,
    calls: u.calls, inputTokens: u.input, outputTokens: u.output, retries: u.errors, failures,
    decisions, differFromRules: differ,
    decideLatencyMs: { p50: pct(0.5), p90: pct(0.9), max: lat[lat.length - 1] ?? 0 },
    peakInflight,
    speedYearsPerSecond: speed || undefined,
    idealSeconds: speed ? +((endYear - era.defaultStartYear) / speed).toFixed(1) : undefined,
    supportsFellBack: speed ? autoCount : undefined,
    visibleStallSeconds: speed ? +(visibleStallMs / 1000).toFixed(1) : undefined,
    longestVisibleStallSeconds: speed ? +(maxVisibleStallMs / 1000).toFixed(1) : undefined,
    wallSeconds: +(ms / 1000).toFixed(1),
    worldBlockedSeconds: +(blockedMs / 1000).toFixed(1),
    serialWouldBlockSeconds: +(serialMs / 1000).toFixed(1),
    focus: `${focus.name} · ${focus.deathTick !== undefined ? `卒于${world.state.config.startYear + Math.floor(focus.deathTick / 12)}，${focus.deathCause}` : '在世'}`,
  };
  process.stdout.write('\n' + JSON.stringify(summary, null, 2) + '\n');

  const dir = join(process.cwd(), '..', '..', 'runs');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(dir, `${stamp}-${providerId}-${model.replace(/[^\w.-]/g, '_')}-s${seed}-h${heroes.length}.json`);
  writeFileSync(file, JSON.stringify({ summary, persona: era.personaCard(focus, (world as unknown as { ctx: never }).ctx), reflections: focus.reflections, traces }, null, 2));
  process.stdout.write(`记录：${file}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
