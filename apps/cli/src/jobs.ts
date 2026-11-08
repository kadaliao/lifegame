/**
 * 就业市场体检：多个种子跑完整个时代，按十年统计各职业的入职人数和入职月薪（相对全体中位数）。
 *   pnpm --filter @lifegame/cli jobs -- --seeds=6 --jobs=程序员,文员,工厂工人
 */
import { World } from '@lifegame/core';
import { getEra } from '@lifegame/eras';

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? 'true'];
}));
const seeds = Number(args.seeds ?? 6);
const focus = (args.jobs ?? '程序员,产品经理,文员,会计,设计师,工厂工人,外卖骑手,司机,养老护理员,AI 工程师').split(',');
const era = getEra('china-modern');

interface Hire { decade: number; title: string; salary: number }
const hires: Hire[] = [];
let badMoney = 0;
for (let seed = 1; seed <= seeds; seed++) {
  const w = World.create(era, { seed, eraId: era.id, population: 300, startYear: 1980, endYear: 2060, birthSpan: 10 });
  while (!w.finished) {
    const r = w.step();
    for (const e of r.events) {
      if (/-\d/.test(e.text) && /元/.test(e.text)) badMoney++;
      if (e.type !== 'job' || typeof e.data?.salary !== 'number') continue;
      const title = e.text.match(/成为(.+?)，月薪/)?.[1] ?? '';
      if (!title) continue;
      hires.push({ decade: Math.floor((1980 + Math.floor(e.tick / 12)) / 10) * 10, title, salary: e.data.salary as number });
    }
  }
}
const decades = [...new Set(hires.map((h) => h.decade))].sort();
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const rows: string[] = [];
rows.push(['职业', ...decades.map((d) => `${d}s`)].join('\t'));
for (const title of focus) {
  rows.push([title, ...decades.map((d) => {
    const hs = hires.filter((h) => h.decade === d && h.title === title);
    const all = hires.filter((h) => h.decade === d);
    if (!hs.length) return '·';
    return `${hs.length}人×${(median(hs.map((h) => h.salary)) / median(all.map((h) => h.salary))).toFixed(1)}`;
  })].join('\t'));
}
console.log(`${seeds} 个种子 · 每格：入职人数 × 入职月薪相对当年代全体中位数`);
console.log(rows.join('\n'));
console.log(`文本里出现负数金额的事件：${badMoney}`);
