import { clamp, type EraContext, type Rng } from '@lifegame/core';
import type { Bot, Origin, Personality, Region, Sex, Talents, Values } from '@lifegame/schema';
import { PARENT_JOBS, PLACES, REGION_NAME } from './data.js';
import { fullName, surname } from './names.js';

export const EDU_LABEL: Record<Bot['state']['education'], string> = {
  none: '未上学', primary: '小学', junior: '初中', vocational: '中专/职高', senior: '高中',
  college: '大专', bachelor: '本科', master: '硕士', phd: '博士',
};

function g(rng: Rng, mean = 50, sd = 18): number {
  return Math.round(rng.gaussClamped(mean, sd, 1, 99));
}

export function rollPersonality(rng: Rng): Personality {
  return {
    openness: g(rng), conscientiousness: g(rng), extraversion: g(rng), agreeableness: g(rng), neuroticism: g(rng),
  };
}

export function rollTalents(rng: Rng, ses: number): Talents {
  return {
    physique: g(rng, 50 + (ses - 3) * 2),
    intellect: g(rng, 50 + (ses - 3) * 3),
    charm: g(rng),
    luck: g(rng, 50, 22),
  };
}

export function rollValues(rng: Rng, p: Personality, origin: Origin): Values {
  const n = () => rng.gauss(0, 10);
  return {
    ambition: clamp(Math.round(40 + p.conscientiousness * 0.3 + p.extraversion * 0.2 + (origin.ses - 3) * -3 + n()), 1, 99),
    family: clamp(Math.round(45 + p.agreeableness * 0.3 + (origin.region === 'rural' ? 10 : 0) + n()), 1, 99),
    security: clamp(Math.round(40 + p.neuroticism * 0.3 - p.openness * 0.1 + (origin.region === 'town' ? 8 : 0) + n()), 1, 99),
    adventure: clamp(Math.round(30 + p.openness * 0.4 + p.extraversion * 0.2 - p.neuroticism * 0.1 + n()), 1, 99),
    tradition: clamp(Math.round(45 - p.openness * 0.3 + (origin.region === 'rural' ? 12 : origin.region === 'metro' ? -8 : 0) + n()), 1, 99),
  };
}

export function rollOrigin(rng: Rng, year: number): Origin {
  // 1980 年代城镇化率约 20%
  const urbanShare = clamp(0.2 + (year - 1980) * 0.012, 0.2, 0.7);
  const r = rng.next();
  const region: Region = r < 1 - urbanShare ? 'rural'
    : r < 1 - urbanShare + urbanShare * 0.45 ? 'town'
      : r < 1 - urbanShare + urbanShare * 0.85 ? 'city' : 'metro';
  const sesMean = { rural: 2.0, town: 2.6, city: 3.1, metro: 3.4 }[region];
  const ses = clamp(Math.round(rng.gaussClamped(sesMean, 0.9, 1, 5)), 1, 5);
  const place = rng.pick(PLACES.filter((p) => p.region === region));
  const jobs = PARENT_JOBS[region];
  return {
    ses, region, hometown: place.name,
    fatherJob: rng.pick(jobs),
    motherJob: rng.chance(region === 'rural' ? 0.8 : 0.4) ? (region === 'rural' ? '农民' : '家庭主妇') : rng.pick(jobs),
  };
}

export function newBotBase(ctx: EraContext, opts: {
  id: string; name: string; sex: Sex; birthTick: number; familyId: string; parentIds: string[]; generation: number; origin: Origin;
  personality: Personality; talents: Talents; values: Values;
}): Bot {
  const { origin, talents } = opts;
  return {
    id: opts.id, name: opts.name, sex: opts.sex, birthTick: opts.birthTick,
    familyId: opts.familyId, parentIds: opts.parentIds, childrenIds: [], generation: opts.generation,
    origin, personality: opts.personality, talents, values: opts.values,
    state: {
      health: clamp(65 + talents.physique * 0.3 + (origin.ses - 3) * 2, 30, 100),
      happiness: 60,
      wealth: 0,
      education: 'none',
      skills: { academic: 5, social: 10 + opts.personality.extraversion * 0.1, craft: 5, business: 5 },
      location: origin.region,
      city: origin.hometown,
      ownsHome: false,
      tags: [],
      vars: {},
    },
    stage: 'infant',
    intelligence: 'rules',
    memory: [],
    reflections: [],
    relationships: [],
  };
}

export function createInitialBot(ctx: EraContext, birthTick: number, startYear: number): Bot {
  const rng = ctx.rng;
  const year = startYear + Math.floor(birthTick / 12);
  const sex: Sex = rng.chance(0.52) ? 'male' : 'female';
  const origin = rollOrigin(rng, year);
  const personality = rollPersonality(rng);
  const talents = rollTalents(rng, origin.ses);
  const values = rollValues(rng, personality, origin);
  const id = ctx.nextId('b');
  return newBotBase(ctx, {
    id, name: fullName(rng, sex, year), sex, birthTick, familyId: `f_${id}`, parentIds: [], generation: 0,
    origin, personality, talents, values,
  });
}

export function createChildBot(ctx: EraContext, mother: Bot, father: Bot, birthTick: number, sex: Sex, startYear: number): Bot {
  const rng = ctx.rng;
  const year = startYear + Math.floor(birthTick / 12);
  const parentSes = (mother.origin.ses + father.origin.ses) / 2;
  const wealth = father.state.wealth + mother.state.wealth + (father.state.vars.assets ?? 0) + (mother.state.vars.assets ?? 0);
  const wealthSes = wealth <= 0 ? 1 : clamp(Math.log10(wealth) - 2.5, 1, 5); // 1e4→1.5, 1e6→3.5, 1e7→4.5
  const ses = clamp(Math.round(parentSes * 0.4 + wealthSes * 0.6 + rng.gauss(0, 0.4)), 1, 5);
  const region = father.state.location;
  const origin: Origin = {
    ses, region, hometown: father.state.city,
    fatherJob: father.state.job?.title ?? '无业',
    motherJob: mother.state.job?.title ?? '家庭主妇',
  };
  const mix = (a: number, b: number) => clamp(Math.round((a + b) / 2 + rng.gauss(0, 10)), 1, 99);
  const personality: Personality = {
    openness: mix(mother.personality.openness, father.personality.openness),
    conscientiousness: mix(mother.personality.conscientiousness, father.personality.conscientiousness),
    extraversion: mix(mother.personality.extraversion, father.personality.extraversion),
    agreeableness: mix(mother.personality.agreeableness, father.personality.agreeableness),
    neuroticism: mix(mother.personality.neuroticism, father.personality.neuroticism),
  };
  const talents: Talents = {
    physique: mix(mother.talents.physique, father.talents.physique),
    intellect: mix(mother.talents.intellect, father.talents.intellect),
    charm: mix(mother.talents.charm, father.talents.charm),
    luck: g(rng, 50, 22),
  };
  const values = rollValues(rng, personality, origin);
  const id = ctx.nextId('b');
  const family = father.name.length > 2 && !/^[欧上司诸东南西北]/.test(father.name) ? father.name[0] : father.name[0];
  return newBotBase(ctx, {
    id, name: fullName(rng, sex, year, family || surname(rng)), sex, birthTick,
    familyId: father.familyId, parentIds: [father.id, mother.id], generation: Math.max(father.generation, mother.generation) + 1,
    origin, personality, talents, values,
  });
}

// ---------- 人格卡 ----------

function level(v: number, low: string, mid: string, high: string): string {
  return v < 35 ? low : v > 65 ? high : mid;
}

export function personalityWords(p: Personality): string[] {
  return [
    level(p.openness, '保守务实', '不太好奇', '好奇心强、爱新鲜'),
    level(p.conscientiousness, '散漫随性', '做事还算靠谱', '自律、有条理'),
    level(p.extraversion, '内向安静', '不算外向', '外向健谈'),
    level(p.agreeableness, '有主见、不太迁就人', '待人平和', '温和、乐于助人'),
    level(p.neuroticism, '情绪稳定、心大', '偶尔焦虑', '敏感、容易焦虑'),
  ].filter((w) => !w.startsWith('不太') && !w.startsWith('不算') && !w.startsWith('偶尔') && w !== '待人平和' && w !== '做事还算靠谱');
}

export function talentWords(t: Talents): string[] {
  const out: string[] = [];
  if (t.intellect > 70) out.push('天资聪颖');
  if (t.intellect < 30) out.push('读书不开窍');
  if (t.physique > 70) out.push('身体结实');
  if (t.physique < 30) out.push('体弱多病');
  if (t.charm > 70) out.push('很有人缘');
  if (t.luck > 75) out.push('运气很好');
  if (t.luck < 25) out.push('总是倒霉');
  return out;
}

export function topValues(v: Values): string[] {
  const names: Record<keyof Values, string> = {
    ambition: '事业与出人头地', family: '家庭与亲情', security: '安稳与保障', adventure: '自由与冒险', tradition: '传统与本分',
  };
  return (Object.keys(v) as (keyof Values)[])
    .sort((a, b) => v[b] - v[a])
    .slice(0, 2)
    .map((k) => names[k]);
}

export function personaCard(bot: Bot, startYear: number): string {
  const birthYear = startYear + Math.floor(bot.birthTick / 12);
  const o = bot.origin;
  const sesWord = ['赤贫', '贫寒', '普通', '小康', '富裕'][o.ses - 1];
  const lines = [
    `姓名：${bot.name}，${bot.sex === 'male' ? '男' : '女'}，${birthYear}年生于${o.hometown}（${REGION_NAME[o.region]}）。`,
    `家境：${sesWord}。父亲是${o.fatherJob}，母亲是${o.motherJob}。`,
    `性格：${personalityWords(bot.personality).join('，') || '平平常常'}。`,
  ];
  const tw = talentWords(bot.talents);
  if (tw.length) lines.push(`天赋：${tw.join('，')}。`);
  lines.push(`最看重：${topValues(bot.values).join('、')}。`);
  if (bot.portrait) lines.push(`自我画像：${bot.portrait}`);
  return lines.join('\n');
}
