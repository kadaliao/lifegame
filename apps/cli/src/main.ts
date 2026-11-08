import { World, stageName } from '@lifegame/core';
import { getEra } from '@lifegame/eras';
import { tickToYearMonth, type Bot } from '@lifegame/schema';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? 'true'];
}));

const era = getEra(args.era ?? 'china-modern');
const seed = Number(args.seed ?? 42);
const population = Number(args.pop ?? 200);
const world = World.create(era, {
  seed, eraId: era.id, population,
  startYear: era.defaultStartYear, endYear: Number(args.end ?? era.defaultEndYear), birthSpan: era.defaultBirthSpan,
});

const t0 = performance.now();
let steps = 0;
while (!world.finished) {
  world.step();
  steps++;
  while (world.pending.length) world.resolveDecision(world.pending[0].id, world.pending[0].options[0].id, 'rules');
}
const ms = performance.now() - t0;
const sum = world.summary();
console.log(`时代：${era.name}  种子：${seed}  人口：${population}→${sum.total}  存活：${sum.alive}  去世：${sum.dead}`);
console.log(`${steps} tick，${ms.toFixed(0)}ms，平均 ${(ms / steps).toFixed(2)}ms/tick，事件 ${world.state.log.length} 条，决策 ${Object.keys(world.state.decisions).length} 个`);

const bots = world.state.botOrder.map((id) => world.state.bots[id]);
const gen0 = bots.filter((b) => b.generation === 0);
const dead0 = gen0.filter((b) => b.deathTick !== undefined);
const avgAge = dead0.reduce((s, b) => s + (b.deathTick! - b.birthTick) / 12, 0) / Math.max(1, dead0.length);
const edu = count(gen0.map((b) => b.state.education));
const married = gen0.filter((b) => b.relationships.some((r) => r.kind === 'spouse')).length;
const kids = gen0.reduce((s, b) => s + b.childrenIds.length, 0);
const homes = gen0.filter((b) => b.state.ownsHome).length;
console.log(`第一代 ${gen0.length} 人：平均去世年龄 ${avgAge.toFixed(1)}，结过婚 ${married}，子女 ${kids}，有房 ${homes}`);
console.log('学历分布：', edu);
console.log('第二代：', bots.filter((b) => b.generation === 1).length, '人；第三代：', bots.filter((b) => b.generation === 2).length, '人');
const jobs = count(gen0.map((b) => b.state.job?.title ?? (b.state.tags.includes('retired') ? '退休' : '无')));
console.log('当前职业：', jobs);
const nw = gen0.map((b) => b.state.wealth + (b.state.vars.assets ?? 0) - (b.state.vars.debt ?? 0)).sort((a, b) => a - b);
console.log(`净资产 中位数 ${fmt(nw[Math.floor(nw.length / 2)])}，P10 ${fmt(nw[Math.floor(nw.length * 0.1)])}，P90 ${fmt(nw[Math.floor(nw.length * 0.9)])}`);

const pick = args.bot ? world.bot(args.bot)! : gen0[Number(args.idx ?? 0)];
printLife(pick);

function printLife(b: Bot) {
  console.log(`\n===== ${b.name} 的一生（${b.id}） =====`);
  console.log(era.personaCard(b, (world as any).ctx));
  const evs = world.state.log.filter((e) => e.botId === b.id && e.importance >= 4);
  for (const e of evs) {
    const { year } = tickToYearMonth(e.tick, world.state.config.startYear);
    const age = Math.floor((e.tick - b.birthTick) / 12);
    console.log(`${year} (${age}岁) ${e.text}`);
  }
  console.log(`阶段：${stageName(b.stage)}`);
}

function count(xs: string[]) {
  const m: Record<string, number> = {};
  for (const x of xs) m[x] = (m[x] ?? 0) + 1;
  return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]));
}
function fmt(n: number) {
  return Math.abs(n) >= 1e4 ? `${(n / 1e4).toFixed(1)}万` : `${Math.round(n)}`;
}
