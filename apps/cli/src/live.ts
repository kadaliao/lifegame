/**
 * 用真模型跑一个世界（调度逻辑与网页相同，见 @lifegame/llm 的 Director）：
 *   pnpm cli:live -- --model=aihubmix/qwen3-vl-plus --heroes=1 --seed=42
 *   pnpm cli:live -- --heroes=12 --leads=3 --speed=2 --level=1 --quiet
 *       模拟一个 2 年/秒播放的画面：前 3 人是主角，其余和继承来的子女是配角，统计用户实际会看到的停顿。
 * 不加 --speed 时没有画面，世界总是等模型（从不推测）。
 *   pnpm cli:live -- --model=llm7/mistral-Nemo-Instruct-2407   免密钥的免费模型
 * 密钥从环境变量读（各服务的变量名见 packages/llm/src/presets.ts 的 envKey），不会打印。结果写到 runs/。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { World, stageName } from '@lifegame/core';
import { getEra } from '@lifegame/eras';
import { Brain, Director, MockProvider, PRESETS, createProvider, favorite, type LlmMessage, type Provider } from '@lifegame/llm';
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
/** 画面播放速度（年/秒）；0 表示没有画面 */
const speed = Number(args.speed ?? 0);
const ahead = speed ? Math.max(60, Math.min(600, Math.round(speed * 12 * 12))) : Infinity;

const providers: Record<string, Provider> = { mock: new MockProvider() };
const limits: Record<string, number> = { mock: concurrency };
for (const p of PRESETS) {
  if (p.id === 'mock' || p.editableUrl) continue;
  const apiKey = p.envKey ? process.env[p.envKey] : undefined;
  if (p.key === 'required' && !apiKey) continue;
  providers[p.id] = createProvider({ id: p.id, kind: 'openai-compatible', baseUrl: p.baseUrl, apiKey, models: [] });
  limits[p.id] = Math.min(concurrency, p.concurrency ?? concurrency);
}
if (!providers[providerId]) {
  console.error(`没有 ${providerId} 的密钥。可用：${Object.keys(providers).join(', ')}`);
  process.exit(1);
}

interface Trace { kind: string; botId: string; ms: number; messages: LlmMessage[]; result: string }
const traces: Trace[] = [];
const brain = new Brain({ providers, defaultModel: { providerId, model }, concurrency: limits, onTrace: (t) => traces.push(t) });

const era = getEra('china-modern');
const world = World.create(era, { seed, eraId: era.id, population, startYear: era.defaultStartYear, endYear, birthSpan: era.defaultBirthSpan });
world.setFlags({ reflections: level >= 2, inherit });
const order = world.state.botOrder;
const heroes: string[] = [];
const step = Math.max(1, Math.floor(order.length / heroCount));
for (let i = Number(args.hero ?? 0); i < order.length && heroes.length < heroCount; i += step) heroes.push(order[i]);
const leadCount = Number(args.leads ?? heroes.length);
heroes.forEach((id, i) => world.setIntelligence(id, 'llm', modelRef, i < leadCount));
const focusId = heroes[0];
const log = (s: string) => { if (!quiet) process.stdout.write(s + '\n'); };

// 模拟画面：按速度前进，但不越过 frontier
let display = 0;
let last = Date.now();
let visibleStallMs = 0;
let maxStallMs = 0;
let stallStart: number | undefined;
let director!: Director;
const advance = () => {
  const now = Date.now();
  if (speed) {
    const want = display + speed * 12 * ((now - last) / 1000);
    const f = director.frontier;
    if (want > f && display >= f - 0.001 && !(director.world.finished && director.world.provisional.length === 0)) {
      stallStart ??= now;
    } else if (stallStart !== undefined) {
      const s = now - stallStart;
      visibleStallMs += s;
      maxStallMs = Math.max(maxStallMs, s);
      stallStart = undefined;
    }
    display = Math.min(f, want);
  }
  last = now;
};

director = new Director(world, brain, {
  display: () => (speed ? Math.floor(display) : -Infinity),
  ahead: () => ahead,
  onError: (m) => log(`  ${m}`),
});

function report(node: DecisionNode) {
  const bot = director.world.bot(focusId)!;
  const { year } = tickToYearMonth(node.tick, director.world.state.config.startYear);
  const age = Math.floor((node.tick - bot.birthTick) / 12);
  if (node.kind === '__reflect') {
    if (node.monologue) log(`  ── ${stageName(node.data?.stage as LifeStage)}反思：${node.monologue}`);
    return;
  }
  const opt = node.options.find((o) => o.id === node.chosen);
  log(`${year}（${age}岁）${node.situation}\n  → ${opt?.label}${node.chosen !== favorite(node) ? '  ※ 与规则首选不同' : ''}\n  「${node.monologue ?? ''}」`);
}

async function main() {
  log(`模型 ${modelRef} · 种子 ${seed} · 智能人格 ${heroes.length} 人（主角 ${Math.min(leadCount, heroes.length)}） · 并发 ${limits[providerId]} · 档位 ${level}${speed ? ` · 画面 ${speed} 年/秒` : ''}`);
  const t0 = Date.now();
  let blockedMs = 0;
  let guard = 0;
  let spin = 0;
  const done = () => director.world.finished && !director.unsettled && (!speed || display >= director.world.tick - 1);
  if (args.progress) {
    setInterval(() => {
      const w = director.world;
      process.stderr.write(`[${((Date.now() - t0) / 1000).toFixed(0)}s] 画面 ${display.toFixed(0)} frontier ${director.frontier} 模拟 ${w.tick} 推测 ${w.provisional.length} 待答 ${w.pending.length} 在路上 ${director.inflightCount} 队列 ${brain.queueDepth} 堆 ${(process.memoryUsage().heapUsed / 1e6).toFixed(0)}MB\n`);
    }, 2000).unref();
  }
  while (!done() && guard++ < 5_000_000) {
    advance();
    director.maintain();
    if (director.world.finished || director.world.tick >= director.target) {
      spin = 0;
      await director.whenAnswer(20);
      continue;
    }
    const r = director.step();
    // 一口气推进太多步时让出一下，让答案回调和计时器有机会运行
    if (++spin > 200) { spin = 0; await new Promise((res) => setImmediate(res)); }
    if (!r.advanced) {
      spin = 0;
      const b0 = Date.now();
      await director.whenAnswer(20);
      blockedMs += Date.now() - b0;
    }
  }
  advance();
  const w = director.world;
  // 最终世界里跟随对象的一生（推测都已纠正）
  log(`\n跟随：${w.bot(focusId)!.name}`);
  for (const n of Object.values(w.state.decisions).filter((d) => d.botId === focusId && d.applied && d.resolvedBy !== 'rules').sort((a, b) => a.seq - b.seq)) report(n);

  const ms = Date.now() - t0;
  const lat = traces.filter((t) => t.kind === 'decide').map((t) => t.ms).sort((a, b) => a - b);
  const pct = (p: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] : 0);
  const applied = Object.values(w.state.decisions).filter((d) => d.applied && d.resolvedBy !== 'rules' && d.kind !== '__reflect');
  const u = brain.usage;
  const focus = w.bot(focusId)!;
  const summary = {
    model: modelRef, seed, concurrency,
    heroesAtStart: heroes.length,
    heroesAtEnd: w.state.botOrder.filter((id) => w.state.bots[id].intelligence === 'llm').length,
    calls: u.calls, inputTokens: u.input, outputTokens: u.output, retries: u.errors,
    decisions: applied.length,
    leadDecisions: applied.filter((d) => w.bot(d.botId)?.lead).length,
    byModel: applied.filter((d) => d.resolvedBy === 'llm').length,
    byIntuition: applied.filter((d) => d.resolvedBy === 'auto').length,
    director: director.stats,
    decideLatencyMs: { p50: pct(0.5), p90: pct(0.9), max: lat[lat.length - 1] ?? 0 },
    speedYearsPerSecond: speed || undefined,
    idealSeconds: speed ? +((endYear - era.defaultStartYear) / speed).toFixed(1) : undefined,
    visibleStallSeconds: speed ? +(visibleStallMs / 1000).toFixed(1) : undefined,
    longestVisibleStallSeconds: speed ? +(maxStallMs / 1000).toFixed(1) : undefined,
    wallSeconds: +(ms / 1000).toFixed(1),
    worldBlockedSeconds: +(blockedMs / 1000).toFixed(1),
    focus: `${focus.name} · ${focus.deathTick !== undefined ? `卒于${w.state.config.startYear + Math.floor(focus.deathTick / 12)}，${focus.deathCause}` : '在世'}`,
  };
  process.stdout.write('\n' + JSON.stringify(summary, null, 2) + '\n');

  const dir = join(process.cwd(), '..', '..', 'runs');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(dir, `${stamp}-${providerId}-${model.replace(/[^\w.-]/g, '_')}-s${seed}-h${heroes.length}.json`);
  writeFileSync(file, JSON.stringify({ summary, persona: era.personaCard(focus, (w as unknown as { ctx: never }).ctx), reflections: focus.reflections, traces }, null, 2));
  process.stdout.write(`记录：${file}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
