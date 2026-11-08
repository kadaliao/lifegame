import type { EraContext, EraPack } from '@lifegame/core';
import type { Bot, LifeStage } from '@lifegame/schema';
import { EDU_LABEL, createChildBot, createCustomBot, createInitialBot, personaCard } from './bots.js';
import { PARENT_JOBS, PLACES, REGION_NAME, TIMELINE, declineReason, jobTrend, wageIndex } from './data.js';
import { checkDischarge, decisions, es, initEraState, onBirthday, onTick, onYear } from './life.js';

function money(n: number): string {
  if (Math.abs(n) >= 1e8) return `${(n / 1e8).toFixed(1)}亿元`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e4).toFixed(1)}万元`;
  return `${Math.round(n)}元`;
}

export const chinaModern: EraPack = {
  id: 'china-modern',
  // 2：各职业随年代兴衰（AI 浪潮、自动化、老龄化）
  rulesVersion: 2,
  name: '当代中国 1980–2060',
  description: '从改革开放到深度老龄化。高考、下海、下岗、房贷、互联网、疫情、考公、AI——一代人的八十年。',
  defaultStartYear: 1980,
  defaultEndYear: 2060,
  defaultBirthSpan: 10,
  theme: { accent: '#c8362f', paper: '#f6f1e7', ink: '#2b2622', fontFamily: '"Noto Serif SC", "Songti SC", serif' },

  initEraState: () => initEraState() as unknown as Record<string, unknown>,

  stageOf(age: number): LifeStage {
    if (age < 3) return 'infant';
    if (age < 12) return 'child';
    if (age < 18) return 'teen';
    if (age < 30) return 'youth';
    if (age < 45) return 'adult';
    if (age < 60) return 'middle';
    return 'senior';
  },

  createInitialBot: (ctx, birthTick) => createInitialBot(ctx, birthTick, ctx.world.config.startYear),
  createChildBot: (ctx, mother, father, birthTick, sex) => createChildBot(ctx, mother, father, birthTick, sex, ctx.world.config.startYear),
  createCustomBot: (ctx, spec, birthTick, id) => createCustomBot(ctx, spec, birthTick, id, ctx.world.config.startYear),
  birthOptions: () => ({
    regions: (['rural', 'town', 'city', 'metro'] as const).map((id) => ({ id, label: REGION_NAME[id] })),
    places: PLACES.map((p) => ({ name: p.name, region: p.region })),
    parentJobs: PARENT_JOBS,
    sesLabels: ['赤贫', '贫寒', '普通', '小康', '富裕'],
  }),

  onYear,
  onTick(bot, ctx) {
    checkDischarge(bot, ctx);
    onTick(bot, ctx);
  },
  onBirthday,
  decisions,

  personaCard: (bot, ctx) => personaCard(bot, ctx.world.config.startYear),

  situationCard(bot: Bot, ctx: EraContext): string {
    const age = ctx.age(bot);
    const st = bot.state;
    const lines: string[] = [];
    lines.push(`现在是${ctx.year}年，${bot.name}${age}岁，住在${st.city}（${REGION_NAME[st.location]}）。`);
    const parts: string[] = [];
    parts.push(`学历${EDU_LABEL[st.education]}`);
    if (st.job) {
      const trend = jobTrend(st.job.id, ctx.year);
      const why = trend.demand < 0.6 ? declineReason(st.job.id, ctx.year) : undefined;
      parts.push(`职业${st.job.title}，月薪${st.job.salary}元${why ? `（这一行在萎缩：${why}，身边不断有人被裁）` : trend.demand > 1.3 ? '（这一行正缺人）' : ''}`);
    }
    else if (st.tags.includes('student')) parts.push('在读学生');
    else if (st.tags.includes('retired')) parts.push(`已退休，月领养老金${st.vars.pension ?? 0}元`);
    else if (age >= 16) parts.push('目前没有工作');
    parts.push(st.wealth >= 0 ? `存款${money(st.wealth)}` : `欠债${money(-st.wealth)}`);
    if (st.ownsHome) parts.push(`有房${st.vars.debt ? `，房贷还剩${money(st.vars.debt)}` : ''}`);
    else if (age >= 22) parts.push('租房');
    lines.push(parts.join('，') + '。');
    const sp = bot.spouseId ? ctx.bot(bot.spouseId) : undefined;
    if (sp) lines.push(`配偶${sp.name}，${sp.state.job?.title ?? '无业'}。`);
    if (bot.childrenIds.length) {
      const kids = bot.childrenIds.map((id) => ctx.bot(id)).filter(Boolean).map((k) => `${k!.name}（${ctx.age(k!)}岁）`);
      lines.push(`子女：${kids.join('、')}。`);
    }
    lines.push(`健康${Math.round(st.health)}/100，近期心情${st.happiness > 65 ? '不错' : st.happiness > 40 ? '一般' : '低落'}。`);
    return lines.join('\n');
  },

  wageIndex,

  eraCard(ctx: EraContext): string {
    const s = es(ctx);
    const active = TIMELINE.filter((t) => s.active.includes(t.id));
    const recent = TIMELINE.filter((t) => t.year <= ctx.year && t.year > ctx.year - 6);
    const picks = [...new Set([...active, ...recent])].slice(-3);
    if (!picks.length) return `${ctx.year}年的中国。`;
    return `${ctx.year}年的中国。近年大事：` + picks.map((t) => `${t.year}年${t.title}`).join('；') + '。';
  },
};
