/**
 * 人生事件体检：多个种子跑完整个时代，统计随机事件在各阶段的占比，以及同一个人重复经历同一件事的情况。
 *   pnpm --filter @lifegame/cli events -- --seeds=4
 */
import { World } from '@lifegame/core';
import { getEra } from '@lifegame/eras';
import type { Bot } from '@lifegame/schema';

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? 'true'];
}));
const seeds = Number(args.seeds ?? 4);
const era = getEra('china-modern');

// 把世界里所有人名换成"某"、数字换成 N，得到事件"模板"
let names: RegExp = /$^/;
function template(text: string, bot: Bot | undefined): string {
  let t = text;
  if (bot) t = t.split(bot.name).join('某');
  return t.replace(names, '某').replace(/\d+(\.\d+)?/g, 'N');
}

const byStage: Record<string, Record<string, number>> = {};
const repeats: Record<string, number[]> = {}; // 模板 → 每个经历过的人经历了几次
let lives = 0;
let miscTotal = 0;
const perLife: number[] = [];
const family: Record<string, number> = {};
const sample: Record<string, string> = {};
for (let seed = 1; seed <= seeds; seed++) {
  const w = World.create(era, { seed, eraId: era.id, population: 200, startYear: 1980, endYear: 2060, birthSpan: 10 });
  while (!w.finished) {
    w.step();
    while (w.pending.length) w.resolveDecision(w.pending[0].id, w.pending[0].options[0].id, 'rules');
  }
  const all = [...new Set(Object.values(w.state.bots).map((b) => b.name))].sort((a, c) => c.length - a.length);
  names = new RegExp(all.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  const counts = new Map<string, Map<string, number>>();
  for (const e of w.state.log) {
    if (e.type === 'family' && e.botId) { const t = template(e.text, w.state.bots[e.botId]); family[t] = (family[t] ?? 0) + 1; }
    if (e.type !== 'misc' || !e.botId) continue;
    const b = w.state.bots[e.botId];
    const age = Math.floor((e.tick - b.birthTick) / 12);
    const stage = era.stageOf(age);
    const t = template(e.text, b);
    sample[t] ??= t;
    (byStage[stage] ??= {})[t] = (byStage[stage][t] ?? 0) + 1;
    const m = counts.get(b.id) ?? new Map();
    m.set(t, (m.get(t) ?? 0) + 1);
    counts.set(b.id, m);
    miscTotal++;
  }
  for (const id of w.state.botOrder) {
    const b = w.state.bots[id];
    const years = ((b.deathTick ?? w.state.tick) - b.birthTick) / 12;
    if (years < 1) continue;
    lives++;
    const m = counts.get(id);
    perLife.push(m ? [...m.values()].reduce((s, n) => s + n, 0) / years * 10 : 0);
    if (m) for (const [t, n] of m) (repeats[t] ??= []).push(n);
  }
}

console.log(`${seeds} 个种子，${lives} 段人生，随机事件 ${miscTotal} 条，平均每人每十年 ${(perLife.reduce((s, n) => s + n, 0) / perLife.length).toFixed(1)} 条\n`);
const order = ['infant', 'child', 'teen', 'youth', 'adult', 'middle', 'senior'];
for (const st of order) {
  const m = byStage[st];
  if (!m) { console.log(`【${st}】没有随机事件\n`); continue; }
  const total = Object.values(m).reduce((s, n) => s + n, 0);
  console.log(`【${st}】${total} 条，${Object.keys(m).length} 种`);
  for (const [t, n] of Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log(`  ${(n / total * 100).toFixed(0).padStart(3)}%  ${t}`);
  }
  console.log();
}
console.log('同一个人反复经历（经历过的人里，平均几次 / 最多几次 / 两次以上占比）：');
const rows = Object.entries(repeats).map(([t, ns]) => ({ t, avg: ns.reduce((s, n) => s + n, 0) / ns.length, max: Math.max(...ns), multi: ns.filter((n) => n >= 2).length / ns.length }))
  .filter((r) => r.max >= 2).sort((a, b) => b.avg - a.avg).slice(0, 15);
for (const r of rows) console.log(`  ${r.avg.toFixed(1)} / ${r.max} / ${(r.multi * 100).toFixed(0)}%  ${r.t}`);
console.log(`\n一共用到 ${Object.keys(sample).length} 种小事`);

console.log('\n亲人的大事：');
for (const [t, n] of Object.entries(family).sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${String(n).padStart(5)}  ${t}`);
