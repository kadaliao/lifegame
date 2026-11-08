import { clamp, type DecisionDef, type EraContext } from '@lifegame/core';
import type { Bot, DecisionOption, Region, Sex } from '@lifegame/schema';
import {
  EDU_RANK, JOBS, LIVING_COST, MAJORS, PLACES, REGION_NAME, TIMELINE,
  housePrice, majorHeat, wageIndex, type JobDef, type Major,
} from './data.js';
import { EDU_LABEL, createChildBot } from './bots.js';

export interface Modifiers {
  layoff: number;
  hiring: number;
  examRate: number;   // >1 更容易录取
  health: number;     // >1 更危险
  founder: number;    // 创业成功倍率
  retireAge: number;
  tech35: boolean;
}

export interface EraState {
  year: number;
  wageIndex: number;
  modifiers: Modifiers;
  active: string[];
}

export function initEraState(): EraState {
  return { year: 1980, wageIndex: 1, modifiers: baseModifiers(), active: [] };
}

function baseModifiers(): Modifiers {
  return { layoff: 1, hiring: 1, examRate: 1, health: 1, founder: 1, retireAge: 60, tech35: false };
}

export function es(ctx: EraContext): EraState {
  return ctx.world.eraState as unknown as EraState;
}

const REGION_MULT: Record<Region, number> = { rural: 0.6, town: 0.8, city: 1.1, metro: 1.45 };

function tag(bot: Bot, t: string): void {
  if (!bot.state.tags.includes(t)) bot.state.tags.push(t);
}
function hasTag(bot: Bot, t: string): boolean {
  return bot.state.tags.includes(t);
}
function untag(bot: Bot, prefix: string): void {
  bot.state.tags = bot.state.tags.filter((t) => !t.startsWith(prefix));
}
function tagValue(bot: Bot, prefix: string): string | undefined {
  return bot.state.tags.find((t) => t.startsWith(prefix + ':'))?.slice(prefix.length + 1);
}
export function majorOf(bot: Bot): Major | undefined {
  return tagValue(bot, 'major') as Major | undefined;
}

// ---------- 年度世界钩子 ----------

export function onYear(ctx: EraContext): void {
  const s = es(ctx);
  s.year = ctx.year;
  s.wageIndex = wageIndex(ctx.year);
  const m = baseModifiers();
  s.active = [];
  for (const ev of TIMELINE) {
    const dur = ev.duration ?? 1;
    if (ctx.year < ev.year || ctx.year >= ev.year + dur) continue;
    s.active.push(ev.id);
    if (ctx.year === ev.year) {
      ctx.log({ type: 'world', importance: 6, text: `${ev.year}年：${ev.title}。${ev.text}`, data: { id: ev.id, title: ev.title, speculative: ev.speculative ?? false } });
    }
    switch (ev.id) {
      case 'inflation': m.hiring *= 0.7; break;
      case 'southern-tour': m.founder *= 1.6; m.hiring *= 1.2; break;
      case 'laid-off': m.layoff *= 2.2; break;
      case 'expansion': m.examRate *= 1.4; break;
      case 'wto': m.hiring *= 1.3; break;
      case 'sars': m.health *= 1.25; break;
      case 'crisis': m.layoff *= 1.8; m.hiring *= 0.75; break;
      case 'mobile': m.hiring *= 1.15; m.founder *= 1.4; break;
      case 'stock-crash': m.founder *= 1.3; break;
      case 'trade-war': m.layoff *= 1.2; break;
      case 'covid': m.health *= 1.5; m.layoff *= 1.6; m.hiring *= 0.6; break;
      case 'double-reduction': m.layoff *= 1.5; m.tech35 = true; break;
      case 'post-covid': m.hiring *= 0.7; m.tech35 = true; break;
      case 'ai-wave': m.layoff *= 1.3; m.tech35 = true; break;
      case 'aging': m.retireAge = 65; m.hiring *= 1.2; break;
      case 'silver': m.hiring *= 1.3; break;
    }
  }
  if (ctx.year >= 1999) m.examRate *= 1.4; // 扩招后长期
  if (ctx.year >= 2018 && ctx.year < 2030) m.tech35 = true;
  s.modifiers = m;
}

// ---------- 工具 ----------

function salaryFor(job: JobDef, bot: Bot, level: number, ctx: EraContext): number {
  const s = es(ctx);
  const skillF = 0.85 + (bot.state.skills.academic + bot.state.skills.social + bot.state.skills.business) / 600;
  return Math.round(job.base * s.wageIndex * REGION_MULT[bot.state.location] * (1 + level * 0.18) * skillF);
}

function pickJob(bot: Bot, ctx: EraContext, prefer?: (j: JobDef) => number): JobDef | undefined {
  const edu = EDU_RANK[bot.state.education];
  const major = majorOf(bot);
  const year = ctx.year;
  const cands = JOBS.filter((j) =>
    j.minEdu <= edu
    && (j.from === undefined || year >= j.from)
    && (j.to === undefined || year <= j.to)
    && (j.regions === undefined || j.regions.includes(bot.state.location))
    && j.id !== 'founder' && j.id !== 'soldier',
  );
  if (!cands.length) return undefined;
  return ctx.rng.weighted(cands, (j) => {
    let w = 1 + j.prestige / 60;
    if (j.majors) w *= major && j.majors.includes(major) ? 3 : 0.35;
    // 学历远高于岗位要求则不太想去
    if (edu - j.minEdu >= 3) w *= 0.3;
    if (edu - j.minEdu >= 2) w *= 0.6;
    if (bot.values.security > 65 && (j.id === 'civil' || j.id === 'soe' || j.id === 'teacher')) w *= 1.8;
    if (bot.values.ambition > 65 && j.base > 100) w *= 1.6;
    if (prefer) w *= prefer(j);
    return w;
  });
}

function giveJob(bot: Bot, job: JobDef, ctx: EraContext, note?: string): void {
  const level = bot.state.job?.id === job.id ? bot.state.job.level : 0;
  bot.state.job = { id: job.id, title: job.title, sector: job.sector, sinceTick: ctx.tick, salary: salaryFor(job, bot, level, ctx), level };
  delete bot.state.vars.unemployedSince;
  ctx.log({
    type: 'job', botId: bot.id, importance: 6,
    text: note ?? `${bot.name}在${bot.state.city}成为${job.title}，月薪${bot.state.job.salary}元。`,
    data: { job: job.id, salary: bot.state.job.salary },
  });
}

function moveTo(bot: Bot, region: Region, ctx: EraContext, why: string): void {
  if (bot.state.location === region && region !== 'metro') return;
  const place = ctx.rng.pick(PLACES.filter((p) => p.region === region));
  if (place.name === bot.state.city) return;
  bot.state.location = region;
  bot.state.city = place.name;
  ctx.log({ type: 'move', botId: bot.id, importance: 5, text: `${bot.name}${why}，来到${place.name}。` });
}

function homeRegion(bot: Bot): Region {
  return bot.origin.region === 'rural' ? 'town' : bot.origin.region;
}

function netWorth(bot: Bot): number {
  return bot.state.wealth + (bot.state.vars.assets ?? 0) - (bot.state.vars.debt ?? 0);
}

function money(n: number): string {
  if (Math.abs(n) >= 1e8) return `${(n / 1e8).toFixed(1)}亿元`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e4).toFixed(1)}万元`;
  return `${Math.round(n)}元`;
}

function opt(id: string, label: string, description: string, weight: number): DecisionOption {
  return { id, label, description, weight: Math.max(0.05, weight) };
}

// ---------- 生日钩子 ----------

export function onBirthday(bot: Bot, age: number, ctx: EraContext): void {
  const rng = ctx.rng;
  const s = es(ctx);
  const m = s.modifiers;

  // 年度死亡判定
  if (checkDeath(bot, age, ctx)) return;

  // 健康年度变化
  if (age > 40) bot.state.health -= (age - 40) * 0.045 + rng.range(0, 0.6);
  else if (bot.state.health < 90) bot.state.health += 1;
  if (bot.state.job && JOBS.find((j) => j.id === bot.state.job!.id)!.stress > 60) bot.state.health -= 0.6;
  bot.state.health = clamp(bot.state.health, 1, 100);

  // 学业
  schooling(bot, age, ctx);

  // 工作进展
  if (bot.state.job) career(bot, age, ctx);

  // 待业找工作
  if (!bot.state.job && age >= 16 && age < m.retireAge && !hasTag(bot, 'student') && !hasTag(bot, 'retired') && !hasTag(bot, 'founder')) {
    const since = bot.state.vars.unemployedSince ?? ctx.tick;
    if (ctx.tick - since >= 6 || age === 16) {
      if (bot.state.location === 'rural' && age <= 45 && ctx.year >= 1985 && rng.chance(ctx.year < 2015 ? 0.5 : 0.3)) {
        moveTo(bot, rng.chance(0.5) ? 'metro' : 'city', ctx, '外出打工');
        const jobId = ctx.year < 2015 || rng.chance(0.5) ? 'migrant' : 'rider';
        giveJob(bot, JOBS.find((j) => j.id === jobId)!, ctx);
      } else {
        const job = pickJob(bot, ctx);
        if (job && rng.chance(0.75 * m.hiring)) giveJob(bot, job, ctx);
      }
    }
  }

  // 婚恋
  if (!bot.spouseId && !hasTag(bot, 'student')) marriageMarket(bot, age, ctx);

  // 生育（以女方为主体）
  if (bot.sex === 'female' && bot.spouseId && age >= 21 && age <= 42) fertility(bot, age, ctx);

  // 买房
  if (ctx.year >= 1998 && !bot.state.ownsHome && age >= 24 && age <= 50 && !hasTag(bot, 'student')) housing(bot, ctx);

  // 退休
  const retireAge = bot.sex === 'female' && ctx.year < 2030 ? m.retireAge - 5 : m.retireAge;
  if (age >= retireAge && !hasTag(bot, 'retired') && !hasTag(bot, 'founder')) retire(bot, ctx);
}

function schooling(bot: Bot, age: number, ctx: EraContext): void {
  const rng = ctx.rng;
  const st = bot.state;
  const inSchool = hasTag(bot, 'student');
  if (inSchool) {
    const gain = bot.talents.intellect / 100 * 6 + bot.personality.conscientiousness / 100 * 4 + (bot.origin.ses - 3) * 0.7 + rng.gauss(0, 1.5);
    st.skills.academic = clamp(st.skills.academic + gain, 0, 100);
    st.skills.social = clamp(st.skills.social + bot.personality.extraversion / 100 * 2, 0, 100);
  }

  if (age === 6) {
    const skip = bot.origin.region === 'rural' && bot.origin.ses === 1 && ctx.year < 1992 && rng.chance(0.15);
    if (skip) {
      tag(bot, 'noschool');
      ctx.log({ type: 'school', botId: bot.id, importance: 7, text: `${bot.name}到了上学年龄，家里却拿不出学费，只能留在家里干活。` });
    } else {
      tag(bot, 'student');
      ctx.log({ type: 'school', botId: bot.id, importance: 4, text: `${bot.name}背上书包，上小学了。` });
    }
    return;
  }
  if (age === 12 && inSchool) {
    st.education = 'primary';
    // 农村贫困家庭小学后辍学
    if (bot.origin.region === 'rural' && bot.origin.ses <= 2 && ctx.year < 1998 && rng.chance(0.12 + (bot.sex === 'female' ? 0.1 : 0))) {
      untag(bot, 'student');
      tag(bot, 'path:work');
      ctx.log({ type: 'school', botId: bot.id, importance: 7, text: `${bot.name}小学毕业后没能继续读书，${bot.sex === 'female' ? '留在家里帮忙带弟妹' : '跟着大人下地干活'}。` });
      return;
    }
    ctx.log({ type: 'school', botId: bot.id, importance: 4, text: `${bot.name}升入初中。` });
    return;
  }
  if (age === 15 && inSchool) {
    st.education = 'junior';
    untag(bot, 'student');
    zhongkao(bot, ctx);
    return;
  }
  if ((age === 18 && hasTag(bot, 'path:senior')) || (age > 18 && hasTag(bot, 'path:retry'))) {
    untag(bot, 'student');
    untag(bot, 'path');
    st.education = 'senior';
    gaokao(bot, ctx);
    return;
  }
  if (age === 18 && hasTag(bot, 'path:vocational')) {
    untag(bot, 'student');
    untag(bot, 'path');
    st.education = 'vocational';
    st.skills.craft = clamp(st.skills.craft + 25, 0, 100);
    ctx.log({ type: 'school', botId: bot.id, importance: 5, text: `${bot.name}从职校毕业，学了一门手艺。` });
    firstJob(bot, ctx);
    return;
  }
  // 大学/研究生毕业
  const gradAt = bot.state.vars.gradTick;
  if (gradAt !== undefined && ctx.tick >= gradAt && hasTag(bot, 'student')) {
    graduate(bot, ctx);
  }
}

function zhongkao(bot: Bot, ctx: EraContext): void {
  const st = bot.state;
  const score = st.skills.academic + ctx.rng.gauss(0, 6);
  const poor = bot.origin.ses <= 2;
  const options: DecisionOption[] = [
    opt('senior', '上普通高中，三年后拼高考', `中考成绩${score > 60 ? '不错' : score > 45 ? '一般' : '不太理想'}。${poor ? '家里负担会很重。' : ''}`,
      (score > 45 ? 3 : 0.8) * (bot.values.ambition / 50) * (poor ? 0.6 : 1) * (bot.origin.ses >= 4 ? 2 : 1)),
    opt('vocational', '读中专/职高，早点学门技术', ctx.year < 1998 ? '这年头中专毕业包分配，是条稳妥的路。' : '学门手艺，三年后就能工作。',
      1.2 * (bot.values.security / 50) * (score < 60 ? 1.5 : 0.6)),
    opt('work', '不读了，出去打工挣钱', poor ? '家里确实需要钱。' : '早点进社会，自己挣钱花。',
      (poor ? 1.5 : 0.3) * (score < 40 ? 2 : 0.5) * (ctx.year < 2005 ? 1.3 : 0.6)),
  ];
  ctx.requestDecision(bot, {
    kind: 'zhongkao',
    situation: `${ctx.year}年，${bot.name}初中毕业了。`,
    options,
  });
}

function gaokao(bot: Bot, ctx: EraContext): void {
  const rng = ctx.rng;
  const st = bot.state;
  const m = es(ctx).modifiers;
  let score = st.skills.academic * 0.75 + bot.talents.intellect * 0.2 + rng.gauss(0, 7) + (bot.talents.luck - 50) * 0.08;
  if (bot.origin.region === 'metro') score += 4;
  const shift = (m.examRate - 1) * 12; // 扩招后门槛下降
  const tiers: Array<[string, number, string]> = [
    ['985', 90, '顶尖名校'], ['211', 82, '重点大学'], ['一本', 74, '一本院校'], ['二本', 64, '普通本科'], ['专科', 52, '大专'],
  ];
  let tier = '落榜';
  let tierName = '';
  for (const [t, th, name] of tiers) {
    if (score >= th - shift) { tier = t; tierName = name; break; }
  }
  bot.state.vars.gaokaoScore = Math.round(score);
  const retries = bot.state.vars.gaokaoRetries ?? 0;
  ctx.log({
    type: 'exam', botId: bot.id, importance: 8, data: { tier, score: Math.round(score) },
    text: tier === '落榜'
      ? `${ctx.year}年高考放榜，${bot.name}落榜了。`
      : `${ctx.year}年高考放榜，${bot.name}考上了${tierName}（${tier}）。`,
  });
  const options: DecisionOption[] = [];
  if (tier !== '落榜') {
    options.push(opt(`go:${tier}`, `去读${tierName}`, '按部就班，踏进大学校门。', 4));
    if (tier !== '985' && retries < 1 && ctx.year < 2024) {
      options.push(opt('retry', '复读一年，明年冲更好的学校', '再苦一年，成绩有可能上一个台阶，也可能原地踏步。',
        0.6 * (bot.values.ambition / 50) * (bot.personality.conscientiousness / 50) * (tier === '专科' ? 2 : 0.6)));
    }
  } else {
    if (retries < 2) options.push(opt('retry', '复读一年再考', '很多人复读后考上了，但也有人越考越差。', 1.5 * (bot.personality.conscientiousness / 50) * (bot.origin.ses >= 2 ? 1 : 0.5)));
    options.push(opt('work', '不考了，出去打工', '早点挣钱，减轻家里负担。', 1.2 * (bot.origin.ses <= 2 ? 1.5 : 0.7)));
    if (bot.sex === 'male' && bot.talents.physique > 45) options.push(opt('army', '去当兵', '两年义务兵，退伍后有安置，也能锻炼人。', 0.8 * (bot.values.tradition / 50)));
  }
  if (tier !== '落榜' && bot.sex === 'male' && bot.talents.physique > 55 && ctx.year >= 2001) {
    options.push(opt('army', '先去当兵，保留学籍', '部队锻炼两年，退伍后回校读书还有补贴。', 0.25 * (bot.values.tradition / 50)));
  }
  ctx.requestDecision(bot, {
    kind: 'gaokao',
    situation: `${ctx.year}年夏天，高考${tier === '落榜' ? '落榜' : `考上${tierName}`}，${bot.name}站在人生第一个岔路口。`,
    options,
  });
}

function enroll(bot: Bot, tier: string, ctx: EraContext): void {
  tag(bot, 'student');
  tag(bot, `gaokao:${tier}`);
  const years = tier === '专科' ? 3 : 4;
  bot.state.vars.gradTick = ctx.tick + years * 12;
  bot.state.vars.gradEdu = tier === '专科' ? 4 : 5;
  const region: Region = tier === '985' || tier === '211' ? (ctx.rng.chance(0.6) ? 'metro' : 'city') : tier === '专科' ? (ctx.rng.chance(0.5) ? 'city' : 'town') : 'city';
  moveTo(bot, region, ctx, '去上大学');
  // 选专业
  const options = MAJORS.map((mj) => {
    const fit = mj === '计算机' || mj === '工科' ? bot.talents.intellect : mj === '艺术' ? bot.talents.charm : mj === '金融' ? bot.values.ambition : mj === '师范' ? bot.values.security : 50;
    return opt(`major:${mj}`, mj, majorBlurb(mj, ctx.year), majorHeat(mj, ctx.year) * (0.5 + fit / 100));
  });
  ctx.requestDecision(bot, {
    kind: 'major',
    situation: `${bot.name}拿到了录取通知书，要填专业志愿了。`,
    options,
  });
}

function majorBlurb(mj: Major, year: number): string {
  switch (mj) {
    case '计算机': return year < 2000 ? '新兴专业，前景不明。' : year < 2012 ? '互联网正在起飞，程序员很吃香。' : '大厂高薪，但卷得厉害，35 岁是道坎。';
    case '金融': return year < 2015 ? '金融是最赚钱的行业。' : '光环褪去，但依然体面。';
    case '医学': return '学制长、很辛苦，但越老越吃香。';
    case '师范': return year < 2000 ? '包分配，铁饭碗。' : '稳定，有寒暑假。';
    case '工科': return '好就业，进厂进院所都行。';
    case '文科': return '选择面广，但起薪不高。';
    case '艺术': return '靠天赋吃饭，收入两极分化。';
  }
}

function graduate(bot: Bot, ctx: EraContext): void {
  untag(bot, 'student');
  const eduRank = bot.state.vars.gradEdu ?? 5;
  const eduMap: Record<number, Bot['state']['education']> = { 4: 'college', 5: 'bachelor', 6: 'master', 7: 'phd' };
  bot.state.education = eduMap[eduRank] ?? 'bachelor';
  delete bot.state.vars.gradTick;
  ctx.log({ type: 'school', botId: bot.id, importance: 6, text: `${bot.name}${EDU_LABEL[bot.state.education]}毕业了。` });
  careerChoice(bot, ctx);
}

function careerChoice(bot: Bot, ctx: EraContext): void {
  const y = ctx.year;
  const v = bot.values;
  const edu = EDU_RANK[bot.state.education];
  const options: DecisionOption[] = [
    opt('metro', '去大城市打拼', y < 1992 ? '北上广机会多，但举目无亲。' : '机会多、工资高、房价也高。', 1.5 * (v.ambition / 50) * (v.adventure / 50)),
    opt('home', '回老家找份安稳工作', '离父母近，生活压力小，天花板也低。', 1.2 * (v.family / 50) * (v.security / 50)),
  ];
  if (edu >= 5 && !hasTag(bot, 'grad:master')) {
    options.push(opt('master', '考研', y < 2000 ? '研究生很稀缺。' : y > 2018 ? '考研人数年年破纪录，上岸不易。' : '多读三年，起点更高。',
      0.8 * (bot.state.skills.academic / 60) * (y > 2015 ? 1.5 : 0.8)));
  }
  if (edu >= 4) {
    options.push(opt('civil', '考公务员', y < 2000 ? '进体制，端铁饭碗。' : y > 2020 ? '千军万马过独木桥，但上岸就是一辈子的安稳。' : '稳定体面，竞争激烈。',
      1.0 * (v.security / 50) * (v.tradition / 50) * (y > 2020 ? 1.8 : 1)));
  }
  if (y >= 1992) {
    options.push(opt('startup', '创业', y < 2000 ? '下海潮正热，敢闯就有机会。' : y < 2019 ? '资本热钱涌动，万一成了呢。' : '寒冬里创业，九死一生。',
      0.5 * (v.adventure / 50) * (v.ambition / 50) * (bot.origin.ses >= 4 ? 1.8 : 0.7)));
  }
  ctx.requestDecision(bot, {
    kind: 'career',
    situation: `${y}年，${bot.name}走出校门，要决定往哪里去。`,
    options,
  });
}

function firstJob(bot: Bot, ctx: EraContext): void {
  const y = ctx.year;
  const v = bot.values;
  const options: DecisionOption[] = [
    opt('factory', '去沿海进厂', y < 1990 ? '去广东的工厂，一个月能寄回家几十块。' : y < 2010 ? '流水线很累，但比种地强。' : '工厂招工难，工资涨了不少。', 1.5 * (bot.origin.ses <= 2 ? 1.5 : 0.8)),
    opt('home', '留在老家', '守着父母，日子清苦但踏实。', 1.0 * (v.family / 50) * (v.tradition / 50)),
    opt('craft', '学门手艺（厨师/电工/美发）', '手艺在身，饿不死。', 1.0 * (bot.state.skills.craft / 30)),
  ];
  if (bot.sex === 'male' && bot.talents.physique > 45) options.push(opt('army', '去当兵', '部队管吃管住，退伍有安置费。', 0.6 * (v.tradition / 50)));
  if (y >= 2015) options.push(opt('rider', '去城里送外卖', '多劳多得，月入过万不是梦。', 0.8 * (v.ambition / 50)));
  if (y >= 2016 && bot.talents.charm > 60) options.push(opt('streamer', '做主播', '靠脸和口才吃饭，可能一夜爆红，也可能没人看。', 0.6 * (v.adventure / 50)));
  ctx.requestDecision(bot, {
    kind: 'first_job',
    situation: `${y}年，${bot.name}要开始养活自己了。`,
    options,
  });
}

function career(bot: Bot, age: number, ctx: EraContext): void {
  const rng = ctx.rng;
  const job = bot.state.job!;
  const def = JOBS.find((j) => j.id === job.id)!;
  const m = es(ctx).modifiers;
  const years = (ctx.tick - job.sinceTick) / 12;

  if (def.id === 'founder') { founderYear(bot, ctx); return; }

  // 晋升
  const promoP = 0.12 * (bot.personality.conscientiousness / 50) * (0.6 + bot.state.skills.social / 100) * (years >= 2 ? 1 : 0.3) * (job.level < 5 ? 1 : 0.3);
  if (rng.chance(promoP)) {
    job.level++;
    job.salary = salaryFor(def, bot, job.level, ctx);
    bot.state.happiness = clamp(bot.state.happiness + 6, 0, 100);
    bot.state.skills.social = clamp(bot.state.skills.social + 3, 0, 100);
    ctx.log({ type: 'job', botId: bot.id, importance: 5, text: `${bot.name}升职了，月薪涨到${job.salary}元。` });
  } else {
    job.salary = salaryFor(def, bot, job.level, ctx);
  }

  // 失业
  let layoffP = 0.02 * m.layoff;
  if (def.id === 'civil' || def.id === 'teacher' || def.id === 'doctor' || def.id === 'professor') layoffP *= 0.03;
  if (def.id === 'farmer' || def.id === 'shop' || def.id === 'streamer') layoffP = def.id === 'farmer' ? 0 : 0.01;
  if (def.id === 'soe' && es(ctx).active.includes('laid-off')) layoffP = 0.18;
  if (def.id === 'factory' && es(ctx).active.includes('laid-off')) layoffP = 0.14;
  if ((def.sector === '互联网' || def.sector === '文化传媒') && m.tech35 && age >= 35) layoffP += 0.12;
  if (def.id === 'founder') layoffP = 0;
  if (rng.chance(layoffP)) {
    bot.state.job = undefined;
    bot.state.vars.unemployedSince = ctx.tick;
    bot.state.happiness = clamp(bot.state.happiness - 15, 0, 100);
    const why = es(ctx).active.includes('laid-off') && (def.id === 'soe' || def.id === 'factory') ? '赶上下岗潮，' : m.tech35 && age >= 35 && def.sector === '互联网' ? '过了 35 岁，' : '';
    ctx.log({ type: 'job', botId: bot.id, importance: 7, text: `${why}${bot.name}失去了${def.title}的工作。` });
    if (age >= 28 && age < m.retireAge - 5) laidOffChoice(bot, age, ctx);
  }
}

function laidOffChoice(bot: Bot, age: number, ctx: EraContext): void {
  const y = ctx.year;
  const v = bot.values;
  const options: DecisionOption[] = [
    opt('same', '找同行的工作', '轻车熟路，但行情未必好。', 2),
    opt('switch', '转行从头来过', '放下身段，重新学。', 0.8 * (bot.personality.openness / 50)),
    opt('home', '回老家', '大城市待不下去了，回去至少有口饭。', 0.7 * (v.family / 50) * (bot.state.location === 'metro' ? 1.5 : 0.5)),
  ];
  if (EDU_RANK[bot.state.education] >= 4 && age <= 35) options.push(opt('civil', '考公务员/事业编', '上岸就不用再担心裁员。', 0.8 * (v.security / 50) * (y > 2015 ? 1.5 : 1)));
  if (y >= 2015) options.push(opt('rider', '先去送外卖/开网约车过渡', '不体面，但现金流立刻有了。', 0.6));
  if (y >= 1992) options.push(opt('startup', '干脆自己干', '把积蓄押上去创业。', 0.4 * (v.adventure / 50) * (netWorth(bot) > 200000 * es(ctx).wageIndex / 30 ? 1.5 : 0.5)));
  ctx.requestDecision(bot, {
    kind: 'laid_off',
    situation: `${y}年，${age}岁的${bot.name}失业了。`,
    options,
  });
}

function founderYear(bot: Bot, ctx: EraContext): void {
  const rng = ctx.rng;
  const m = es(ctx).modifiers;
  const s = es(ctx);
  const biz = bot.state.skills.business;
  const years = (ctx.tick - bot.state.job!.sinceTick) / 12;
  bot.state.skills.business = clamp(biz + 5, 0, 100);
  const base = 60 * s.wageIndex * REGION_MULT[bot.state.location];
  const roll = rng.next() * (0.7 + biz / 100) * m.founder * (0.7 + bot.talents.luck / 150);
  if (roll > 1.25) {
    const gain = base * rng.range(40, 300);
    bot.state.wealth += gain;
    bot.state.job!.salary = Math.round(base * rng.range(6, 20));
    bot.state.happiness = clamp(bot.state.happiness + 10, 0, 100);
    ctx.log({ type: 'money', botId: bot.id, importance: 8, text: `${bot.name}的生意大获成功，一年赚了${money(gain)}。` });
  } else if (roll > 0.55) {
    bot.state.job!.salary = Math.round(base * rng.range(1, 4));
    if (years >= 1 && rng.chance(0.3)) ctx.log({ type: 'money', botId: bot.id, importance: 3, text: `${bot.name}的小生意不温不火，勉强维持。` });
  } else {
    const loss = Math.min(bot.state.wealth * rng.range(0.3, 0.9), base * rng.range(10, 80));
    bot.state.wealth -= loss;
    bot.state.job!.salary = Math.round(base * 0.5);
    bot.state.happiness = clamp(bot.state.happiness - 10, 0, 100);
    ctx.log({ type: 'money', botId: bot.id, importance: 7, text: `${bot.name}创业失利，亏了${money(loss)}。` });
    if (roll < 0.2 || bot.state.wealth < -base * 20) {
      untag(bot, 'founder');
      bot.state.job = undefined;
      bot.state.vars.unemployedSince = ctx.tick;
      ctx.log({ type: 'job', botId: bot.id, importance: 8, text: `${bot.name}的公司倒闭了。` });
    }
  }
}

function marriageMarket(bot: Bot, age: number, ctx: EraContext): void {
  const rng = ctx.rng;
  const minAge = bot.sex === 'male' ? 23 : 21;
  if (age < minAge || age > 55) return;
  // 年龄越大、家庭观越重越想结婚；2010 后结婚意愿整体下降
  const peak = bot.sex === 'male' ? 28 : 26;
  let p = 0.18 * Math.exp(-Math.pow(age - peak, 2) / 60) + 0.04;
  p *= bot.values.family / 50;
  if (ctx.year > 2010) p *= 0.75;
  if (ctx.year > 2020) p *= 0.7;
  if (hasTag(bot, 'single')) p *= 0.3;
  if (!rng.chance(p)) return;

  const t = ctx.tick;
  if (ctx.openDecision(bot.id, 'marry')) return;
  const cands = ctx.alive().filter((c) => {
    if (c.sex === bot.sex || c.spouseId || c.familyId === bot.familyId || c.id === bot.id) return false;
    if (ctx.openDecision(c.id, 'marry')) return false;
    if (hasTag(c, 'student')) return false;
    const ca = Math.floor((t - c.birthTick) / 12);
    const cmin = c.sex === 'male' ? 23 : 21;
    if (ca < cmin) return false;
    const gap = bot.sex === 'male' ? age - ca : ca - age;
    return gap >= -4 && gap <= 10;
  });
  if (!cands.length) return;
  const score = (c: Bot) => {
    let sc = 60;
    sc -= Math.abs(c.origin.ses - bot.origin.ses) * 8;
    sc -= Math.abs(EDU_RANK[c.state.education] - EDU_RANK[bot.state.education]) * 6;
    if (c.state.city !== bot.state.city) sc -= c.state.location === bot.state.location ? 10 : 22;
    sc += (c.personality.agreeableness + bot.personality.agreeableness - 100) * 0.15;
    sc += (c.talents.charm - 50) * 0.2;
    sc += rng.gauss(0, 8);
    return sc;
  };
  let best: Bot | undefined;
  let bestScore = -Infinity;
  for (const c of rng.shuffle(cands).slice(0, 12)) {
    const sc = score(c);
    if (sc > bestScore) { bestScore = sc; best = c; }
  }
  if (!best || bestScore < 35) return;
  // 双方有一个是智能人格时，由他/她来拿主意，不让规则角色替主角做决定
  const me = bot.intelligence !== 'llm' && best.intelligence === 'llm' ? best : bot;
  const other = me === bot ? best : bot;
  const meAge = ctx.age(me);
  const mePeak = me.sex === 'male' ? 28 : 26;
  const intro = other.state.city === me.state.city ? (rng.chance(0.5) ? '经人介绍' : '在朋友聚会上') : '经老家亲戚介绍';
  const pDesc = `${other.name}，${ctx.age(other)}岁，${other.state.job?.title ?? '暂无工作'}，${EDU_LABEL[other.state.education]}，${['赤贫', '贫寒', '普通', '小康', '富裕'][other.origin.ses - 1]}家庭${other.state.city === me.state.city ? '' : `，人在${other.state.city}`}。`;
  const pressure = meAge > mePeak + 2 ? 1.6 : 1;
  const options: DecisionOption[] = [
    opt('marry', '结婚', '两个人搭伙过日子，也让父母安心。', 2.5 * (me.values.family / 50) * pressure * (bestScore / 50)),
    opt('wait', '再等等，还没准备好', ctx.year > 2010 ? '身边不少人都晚婚甚至不婚。' : '父母会催，但人生是自己的。', 1.0 * (me.values.adventure / 50) * (ctx.year > 2010 ? 1.4 : 0.7)),
  ];
  if (ctx.year >= 2005 && meAge >= 30) options.push(opt('single', '决定不婚', '一个人也能过得很好。', 0.3 * (me.values.adventure / 50) * (100 - me.values.family) / 50));
  ctx.requestDecision(me, {
    kind: 'marry',
    data: { partnerId: other.id },
    situation: `${ctx.year}年，${meAge}岁的${me.name}${intro}认识了${pDesc}两人处得不错，到了谈婚论嫁的时候。`,
    options,
  });
}

function doMarry(bot: Bot, partner: Bot, ctx: EraContext): void {
  if (partner.spouseId || partner.deathTick !== undefined) {
    ctx.log({ type: 'love', botId: bot.id, importance: 6, text: `${bot.name}准备求婚时，${partner.name}已经另有归宿。` });
    bot.state.happiness = clamp(bot.state.happiness - 10, 0, 100);
    return;
  }
  bot.spouseId = partner.id;
  partner.spouseId = bot.id;
  bot.relationships.push({ botId: partner.id, kind: 'spouse', affinity: 70, sinceTick: ctx.tick });
  partner.relationships.push({ botId: bot.id, kind: 'spouse', affinity: 70, sinceTick: ctx.tick });
  untag(bot, 'single');
  untag(partner, 'single');
  // 搬到一起：去收入高/城市大的一方
  const rank: Record<Region, number> = { rural: 0, town: 1, city: 2, metro: 3 };
  const [stay, move] = rank[bot.state.location] >= rank[partner.state.location] ? [bot, partner] : [partner, bot];
  if (move.state.city !== stay.state.city) {
    move.state.location = stay.state.location;
    move.state.city = stay.state.city;
    ctx.log({ type: 'move', botId: move.id, importance: 4, text: `${move.name}随${stay.name}搬到${stay.state.city}生活。` });
  }
  bot.state.happiness = clamp(bot.state.happiness + 15, 0, 100);
  partner.state.happiness = clamp(partner.state.happiness + 15, 0, 100);
  const text = `${bot.name}和${partner.name}结婚了。`;
  ctx.log({ type: 'marriage', botId: bot.id, relatedIds: [partner.id], importance: 9, text });
  ctx.log({ type: 'marriage', botId: partner.id, relatedIds: [bot.id], importance: 9, text });
}

function allowedChildren(ctx: EraContext, bot: Bot): number {
  const y = ctx.year;
  if (y >= 2021) return 3;
  if (y >= 2016) return 2;
  if (y >= 1984 && bot.state.location === 'rural') return 2; // 一孩半政策
  return 1;
}

function fertility(bot: Bot, age: number, ctx: EraContext): void {
  const rng = ctx.rng;
  if (bot.state.vars.dueTick) return;
  if (ctx.openDecision(bot.id, 'have_child') || (bot.spouseId && ctx.openDecision(bot.spouseId, 'have_child'))) return;
  const n = bot.childrenIds.length;
  const allowed = allowedChildren(ctx, bot);
  if (n >= allowed) return;
  if (hasTag(bot, 'dink')) return;
  if (n > 0 && ctx.tick - (bot.state.vars.lastBirth ?? 0) < 24) return;
  const spouse = ctx.bot(bot.spouseId!);
  if (!spouse || spouse.deathTick !== undefined) return;
  const yearsMarried = (ctx.tick - (bot.relationships.find((r) => r.kind === 'spouse')?.sinceTick ?? ctx.tick)) / 12;
  // 夫妻里有智能人格的，由他/她来拿主意
  const decider = bot.intelligence !== 'llm' && spouse.intelligence === 'llm' ? spouse : bot;
  const partner = decider === bot ? spouse : bot;
  let p = n === 0 ? (yearsMarried < 1 ? 0.35 : 0.5) : 0.25;
  if (ctx.year > 2015) p *= 0.7;
  if (age > 36) p *= 0.5;
  if (!rng.chance(p)) return;
  const options: DecisionOption[] = [
    opt('yes', n === 0 ? '要个孩子' : '再要一个', n === 0 ? '父母盼着抱孙子。' : `已经有${n}个孩子，${ctx.year > 2016 ? '政策允许再生。' : '老家可以再生一个。'}`,
      2.5 * (bot.values.family / 50) * (n === 0 ? 1.5 : 0.6) * (ctx.year > 2016 ? 0.6 : 1)),
    opt('later', '过两年再说', '先把日子过稳，房子、工作都还没着落。', 1.0 * (netWorth(bot) < 0 ? 2 : 1) * (ctx.year > 2010 ? 1.4 : 0.8)),
  ];
  if (ctx.year >= 2005 && n === 0) options.push(opt('dink', '不要孩子', '两个人的生活也很好。', 0.25 * (bot.values.adventure / 50) * ((100 - bot.values.family) / 50) * (bot.state.location === 'metro' ? 1.8 : 0.6)));
  const wifeNote = decider === bot ? '' : `妻子${bot.name}${age}岁。`;
  ctx.requestDecision(decider, {
    kind: 'have_child',
    situation: `${ctx.year}年，${decider.name}${ctx.age(decider)}岁，和${partner.name}结婚${Math.max(1, Math.round(yearsMarried))}年了。${wifeNote}`,
    options,
  });
}

function housing(bot: Bot, ctx: EraContext): void {
  const rng = ctx.rng;
  if (bot.spouseId) {
    const sp = ctx.bot(bot.spouseId);
    if (sp?.state.ownsHome) { bot.state.ownsHome = true; return; }
  }
  if (bot.state.vars.homeDeclinedAt && ctx.tick - bot.state.vars.homeDeclinedAt < 36) return;
  if (ctx.openDecision(bot.id, 'buy_home') || (bot.spouseId && ctx.openDecision(bot.spouseId, 'buy_home'))) return;
  const area = bot.state.location === 'metro' ? 75 : 95;
  const price = housePrice(bot.state.location, ctx.year) * area;
  if (price <= 0) return;
  const down = price * 0.3;
  const spouseCash = bot.spouseId ? (ctx.bot(bot.spouseId)?.state.wealth ?? 0) : 0;
  const age = ctx.age(bot);
  const familyHelp = age > 40 ? 0 : bot.origin.ses >= 4 ? price * 0.3 : bot.origin.ses === 3 ? price * 0.1 : 0;
  const cash = bot.state.wealth + spouseCash * 0.5 + familyHelp;
  if (bot.state.wealth + familyHelp < down) return;
  if (cash < down) return;
  if (!rng.chance(0.6)) return;
  const monthly = Math.round(((price - down) * 1.5) / (25 * 12));
  const income = (bot.state.job?.salary ?? 0) + (bot.spouseId ? (ctx.bot(bot.spouseId)?.state.job?.salary ?? 0) : 0);
  const ratio = income > 0 ? monthly / income : 9;
  const homePrice = housePrice(homeRegion(bot), ctx.year) * 110;
  const options: DecisionOption[] = [
    opt('buy', `在${bot.state.city}买房`, `总价${money(price)}，首付${money(down)}${familyHelp > 0 ? '（父母能帮衬一部分）' : ''}，月供${monthly}元，占家庭收入${Math.round(ratio * 100)}%。`,
      2 * (bot.values.security / 50) * (ratio < 0.5 ? 1.5 : ratio < 0.8 ? 0.8 : 0.3) * (bot.spouseId ? 1.5 : 0.8)),
    opt('wait', '再攒攒，先租着', ctx.year < 2015 ? '房价还在涨，等得起吗？' : ctx.year > 2022 ? '房价在跌，不急。' : '房价高位，再看看。', 1.0 * (ctx.year > 2022 ? 2 : 0.8)),
  ];
  if (bot.state.location !== homeRegion(bot) && homePrice < price * 0.5) {
    options.push(opt('hometown', '回老家买一套', `老家总价只要${money(homePrice)}，全款都够，但人还在外面漂。`, 0.8 * (bot.values.family / 50) * (bot.values.tradition / 50)));
  }
  ctx.requestDecision(bot, {
    kind: 'buy_home',
    data: { price, homePrice },
    situation: `${ctx.year}年，${bot.name}手里攒了${money(bot.state.wealth)}，中介打来电话。`,
    options,
  });
}

function buyHome(bot: Bot, price: number, region: Region, ctx: EraContext): void {
  const down = price * 0.3;
  const familyHelp = ctx.age(bot) > 40 ? 0 : bot.origin.ses >= 4 ? price * 0.3 : bot.origin.ses === 3 ? price * 0.1 : 0;
  const ownPay = Math.max(0, down - familyHelp);
  bot.state.wealth -= ownPay;
  bot.state.ownsHome = true;
  bot.state.vars.assets = (bot.state.vars.assets ?? 0) + price;
  bot.state.vars.debt = (bot.state.vars.debt ?? 0) + (price - down) * 1.5;
  bot.state.vars.mortgageMonthly = Math.round(((price - down) * 1.5) / (25 * 12));
  bot.state.vars.homeRegion = ({ rural: 0, town: 1, city: 2, metro: 3 } as Record<Region, number>)[region];
  bot.state.vars.homePriceBase = price;
  bot.state.vars.homeYear = ctx.year;
  bot.state.happiness = clamp(bot.state.happiness + 12, 0, 100);
  const where = region === bot.state.location ? bot.state.city : `老家${REGION_NAME[region]}`;
  ctx.log({ type: 'home', botId: bot.id, importance: 8, text: `${bot.name}在${where}买了房，总价${money(price)}${familyHelp > 0 ? '，父母掏了' + money(familyHelp) : ''}，背上了${bot.state.vars.mortgageMonthly}元的月供。` });
  if (bot.spouseId) {
    const sp = ctx.bot(bot.spouseId);
    if (sp) { sp.state.ownsHome = true; sp.state.happiness = clamp(sp.state.happiness + 8, 0, 100); }
  }
}

function retire(bot: Bot, ctx: EraContext): void {
  tag(bot, 'retired');
  const job = bot.state.job;
  let pension = 0;
  if (job) {
    const def = JOBS.find((j) => j.id === job.id)!;
    const rate = def.id === 'civil' || def.id === 'soe' || def.id === 'teacher' || def.id === 'professor' ? 0.8 : def.id === 'farmer' ? 0.1 : 0.45;
    pension = Math.round(job.salary * rate);
  } else {
    pension = Math.round(20 * es(ctx).wageIndex * (bot.state.location === 'rural' ? 0.4 : 1));
  }
  bot.state.vars.pension = pension;
  bot.state.job = undefined;
  ctx.log({ type: 'job', botId: bot.id, importance: 7, text: `${bot.name}退休了，每月领${pension}元养老金。` });
}

function checkDeath(bot: Bot, age: number, ctx: EraContext): boolean {
  const rng = ctx.rng;
  const m = es(ctx).modifiers;
  let p: number;
  if (age <= 5) {
    p = (ctx.year < 1990 ? 0.012 : ctx.year < 2005 ? 0.005 : 0.0015) * (bot.origin.region === 'rural' ? 1.5 : 1) * (6 - bot.origin.ses) / 3;
  } else {
    p = 0.00004 * Math.exp(0.092 * age);
  }
  p *= 1 + Math.max(0, (55 - bot.state.health) / 55) * 1.2;
  p *= m.health;
  if (bot.state.health <= 5) p = Math.max(p, 0.5);
  if (!rng.chance(p)) return false;
  let cause: string;
  if (age <= 5) cause = '因病夭折';
  else if (age < 40) cause = rng.pick(['因车祸去世', '因病去世', '意外去世']);
  else if (age < 75) cause = rng.pick(['因病去世', '心脏病突发去世', '因癌症去世']);
  else cause = rng.pick(['安详离世', '因病去世', '在睡梦中离世']);
  ctx.kill(bot, cause);
  return true;
}

// ---------- 月度钩子 ----------

export function onTick(bot: Bot, ctx: EraContext): void {
  const rng = ctx.rng;
  const s = es(ctx);
  const st = bot.state;
  const age = ctx.age(bot);

  // 收入与支出
  let income = 0;
  if (st.job) income += st.job.salary;
  if (st.vars.pension) income += st.vars.pension;
  if (bot.spouseId && !st.job && !st.vars.pension) {
    // 无收入者由配偶负担一半生活费
    income += LIVING_COST[st.location] * s.wageIndex * 0.5;
  }
  const dependents = bot.childrenIds.filter((cid) => { const c = ctx.bot(cid); return c && c.deathTick === undefined && ctx.age(c) < 22; }).length;
  let cost = age >= 18 ? LIVING_COST[st.location] * s.wageIndex * (1 + 0.35 * dependents / Math.max(1, bot.spouseId ? 2 : 1)) : 0;
  if (hasTag(bot, 'student') && age >= 18) cost += LIVING_COST[st.location] * s.wageIndex * 0.6 * (bot.origin.ses <= 2 ? 1 : 0); // 穷学生自己扛
  if (age >= 18 && st.vars.mortgageMonthly && (st.vars.debt ?? 0) > 0) {
    const pay = Math.min(st.vars.mortgageMonthly, st.vars.debt!);
    cost += pay;
    st.vars.debt = st.vars.debt! - pay;
    if (st.vars.debt <= 0) {
      delete st.vars.debt;
      delete st.vars.mortgageMonthly;
      ctx.log({ type: 'home', botId: bot.id, importance: 6, text: `${bot.name}还清了房贷。` });
    }
  }
  // 家庭收入的婚内分摊：挣钱少的一方开销由多的一方分担一部分
  st.wealth += income - cost;
  if (st.wealth < 0 && bot.spouseId) {
    const sp = ctx.bot(bot.spouseId);
    if (sp && sp.state.wealth > -st.wealth) { sp.state.wealth += st.wealth; st.wealth = 0; }
  }
  // 父母兜底：未成年或在读学生不记负债
  if (st.wealth < 0 && (age < 18 || hasTag(bot, 'student'))) st.wealth = 0;
  // 有余钱存款生息/理财
  if (st.wealth > 0 && ctx.month === 1) st.wealth *= ctx.year < 2000 ? 1.08 : ctx.year < 2015 ? 1.04 : 1.02;
  // 房产估值随行情
  if (st.vars.homePriceBase && ctx.month === 1) {
    const regionIdx = st.vars.homeRegion ?? 2;
    const region = (['rural', 'town', 'city', 'metro'] as Region[])[regionIdx];
    st.vars.assets = Math.round(st.vars.homePriceBase * housePrice(region, ctx.year) / Math.max(1, housePrice(region, st.vars.homeYear ?? ctx.year)));
  }

  // 生产
  if (st.vars.dueTick && ctx.tick >= st.vars.dueTick) {
    delete st.vars.dueTick;
    const father = ctx.bot(bot.spouseId ?? '');
    if (father) {
      const sex: Sex = rng.chance(0.515) ? 'male' : 'female';
      const child = createChildBot(ctx, bot, father, ctx.tick, sex, ctx.world.config.startYear);
      ctx.addBot(child);
      bot.childrenIds.push(child.id);
      father.childrenIds.push(child.id);
      st.vars.lastBirth = ctx.tick;
      bot.relationships.push({ botId: child.id, kind: 'child', affinity: 80, sinceTick: ctx.tick });
      father.relationships.push({ botId: child.id, kind: 'child', affinity: 80, sinceTick: ctx.tick });
      child.relationships.push({ botId: bot.id, kind: 'parent', affinity: 80, sinceTick: ctx.tick }, { botId: father.id, kind: 'parent', affinity: 80, sinceTick: ctx.tick });
      bot.state.happiness = clamp(bot.state.happiness + 12, 0, 100);
      father.state.happiness = clamp(father.state.happiness + 12, 0, 100);
      const text = `${bot.name}和${father.name}的${sex === 'male' ? '儿子' : '女儿'}${child.name}出生了。`;
      ctx.log({ type: 'child', botId: bot.id, relatedIds: [father.id, child.id], importance: 9, text });
      ctx.log({ type: 'child', botId: father.id, relatedIds: [bot.id, child.id], importance: 9, text });
      ctx.log({ type: 'birth', botId: child.id, relatedIds: [bot.id, father.id], importance: 8, text: `${child.name}出生在${bot.state.city}，父亲是${father.state.job?.title ?? '无业'}，母亲是${bot.state.job?.title ?? '家庭主妇'}。` });
    }
  }

  // 幸福感回归基线
  const jobDef = st.job ? JOBS.find((j) => j.id === st.job!.id) : undefined;
  let baseline = 48 + (50 - bot.personality.neuroticism) * 0.3 + bot.personality.extraversion * 0.08;
  if (bot.spouseId) baseline += 6;
  if (age >= 20 && age < 60) baseline += jobDef ? jobDef.prestige * 0.1 - jobDef.stress * 0.06 : hasTag(bot, 'student') ? 2 : -9;
  const nw = netWorth(bot) / s.wageIndex; // 折算到 1980 元
  baseline += nw > 0 ? Math.min(12, Math.log10(nw + 1) * 3 - 6) : Math.max(-10, nw / 500);
  baseline += (st.health - 60) * 0.12;
  baseline += bot.childrenIds.length > 0 ? 3 : 0;
  st.happiness = clamp(st.happiness + (baseline - st.happiness) * 0.06, 0, 100);

  // 月度随机事件
  if (rng.chance(0.05)) randomEvent(bot, age, ctx);

  // 主播/骑手等平台职业的收入波动
  if (st.job?.id === 'streamer' && ctx.month === 6) {
    if (rng.chance(0.08)) { const gain = st.job.salary * rng.range(30, 200); st.wealth += gain; ctx.log({ type: 'money', botId: bot.id, importance: 8, text: `${bot.name}的账号突然爆了，一年打赏和带货赚了${money(gain)}。` }); }
    else if (rng.chance(0.3)) { st.job.salary = Math.round(st.job.salary * 0.6); ctx.log({ type: 'money', botId: bot.id, importance: 4, text: `${bot.name}的直播间越来越冷清。` }); }
  }
}

interface RandomEventDef {
  id: string;
  once?: boolean;
  cond?: (b: Bot, ctx: EraContext) => boolean;
  stages: Bot['stage'][];
  weight: (b: Bot, ctx: EraContext) => number;
  text: (b: Bot, ctx: EraContext) => string;
  importance: number;
  apply?: (b: Bot, ctx: EraContext) => void;
}

const RANDOM_EVENTS: RandomEventDef[] = [
  { id: 'top_student', cond: (b) => b.state.tags.includes('student'), stages: ['child'], weight: (b) => b.state.skills.academic / 40, importance: 3, text: (b) => `${b.name}期末考了全班第一，奖状贴满了墙。`, apply: (b) => { b.state.happiness += 5; b.state.skills.academic += 2; } },
  { id: 'river', stages: ['child'], weight: () => 1, importance: 3, text: (b) => `${b.name}和小伙伴在河边摸鱼，被父母揍了一顿。`, apply: (b) => { b.state.happiness += 2; } },
  { id: 'child_ill', stages: ['child'], weight: (b) => (100 - b.talents.physique) / 50, importance: 4, text: (b) => `${b.name}大病一场，在医院躺了半个月。`, apply: (b) => { b.state.health -= 8; } },
  { id: 'left_behind', once: true, stages: ['child', 'teen'], weight: (b, c) => (b.origin.region === 'rural' && b.state.location === 'rural' && c.year > 1995 && c.year < 2015 ? 2 : 0), importance: 5, text: (b) => `${b.name}的父母去外地打工了，${b.name}成了留守儿童。`, apply: (b) => { b.state.happiness -= 8; } },
  { id: 'gaming', cond: (b) => b.state.tags.includes('student'), stages: ['teen'], weight: (b, c) => (c.year > 2000 ? 1.5 : 0.3), importance: 4, text: (b, c) => `${b.name}沉迷${c.year < 2010 ? '网吧' : '手游'}，成绩一落千丈。`, apply: (b) => { b.state.skills.academic -= 6; } },
  { id: 'puppy_love', cond: (b) => b.state.tags.includes('student'), stages: ['teen'], weight: (b) => b.talents.charm / 50, importance: 5, text: (b) => `${b.name}早恋了，被老师叫了家长。`, apply: (b) => { b.state.happiness += 4; b.state.skills.academic -= 2; } },
  { id: 'contest', once: true, cond: (b) => b.state.tags.includes('student'), stages: ['teen'], weight: (b) => b.talents.intellect / 60, importance: 5, text: (b) => `${b.name}在奥数/物理竞赛中拿了奖。`, apply: (b) => { b.state.skills.academic += 6; b.state.happiness += 5; } },
  { id: 'breakup', stages: ['youth', 'adult'], weight: (b) => (b.spouseId ? 0 : 1.5), importance: 5, text: (b) => `${b.name}失恋了，难过了好一阵。`, apply: (b) => { b.state.happiness -= 10; } },
  { id: 'blind_date', stages: ['youth', 'adult'], weight: (b) => (b.spouseId ? 0 : 1), importance: 4, text: (b) => `${b.name}被家里安排相亲，场面很尴尬。`, apply: (b) => { b.state.happiness -= 2; } },
  { id: 'scolded', cond: (b) => !!b.state.job && JOBS.find((j) => j.id === b.state.job!.id)!.prestige >= 35, stages: ['youth', 'adult', 'middle'], weight: (b) => (b.state.job ? 1 : 0), importance: 4, text: (b) => `${b.name}被领导当众批评，憋了一肚子气。`, apply: (b) => { b.state.happiness -= 5; } },
  { id: 'bonus', cond: (b) => !!b.state.job && JOBS.find((j) => j.id === b.state.job!.id)!.prestige >= 35, stages: ['youth', 'adult', 'middle'], weight: (b) => (b.state.job ? 0.8 : 0), importance: 5, text: (b) => `${b.name}做成了一个大项目，拿到一笔不小的奖金。`, apply: (b, c) => { b.state.wealth += (b.state.job?.salary ?? 0) * 3; b.state.happiness += 6; void c; } },
  { id: 'scam', stages: ['youth', 'adult'], weight: (b, c) => (c.year > 2005 ? 0.6 : 0.2), importance: 6, text: (b, c) => `${b.name}被${c.year > 2015 ? '网络诈骗' : '传销'}骗走了一大笔积蓄。`, apply: (b) => { b.state.wealth *= 0.5; b.state.happiness -= 12; } },
  { id: 'lottery', stages: ['youth', 'adult', 'middle'], weight: (b) => b.talents.luck / 80, importance: 6, text: (b, c) => `${b.name}买彩票中了${c.year < 2000 ? '五千' : '五万'}块。`, apply: (b, c) => { b.state.wealth += 50 * es(c).wageIndex * 10; b.state.happiness += 8; } },
  { id: 'invest', stages: ['youth', 'adult', 'middle'], weight: (b, c) => (c.year >= 2000 && c.year <= 2020 && b.state.location !== 'rural' ? 0.8 : 0), importance: 5, text: (b, c) => `${b.name}跟风${c.year < 2010 ? '炒股' : c.year < 2018 ? '买基金' : '买理财'}，${b.talents.luck > 55 ? '小赚一笔' : '亏了不少'}。`, apply: (b) => { b.state.wealth *= b.talents.luck > 55 ? 1.15 : 0.85; } },
  { id: 'father_ill', once: true, stages: ['adult', 'middle'], weight: () => 1.2, importance: 7, text: (b) => `${b.name}的父亲病重，${b.name}在医院陪护了几个月，花光了积蓄。`, apply: (b) => { b.state.wealth *= 0.6; b.state.happiness -= 10; b.state.health -= 3; } },
  { id: 'mother_dies', once: true, stages: ['adult', 'middle'], weight: () => 1.0, importance: 8, text: (b) => `${b.name}的母亲去世了。`, apply: (b) => { b.state.happiness -= 15; } },
  { id: 'school_pull', stages: ['adult', 'middle'], weight: (b) => (b.childrenIds.length ? 1 : 0), importance: 5, text: (b) => `${b.name}为了孩子上学的事四处托关系。`, apply: (b) => { b.state.wealth *= 0.95; b.state.happiness -= 3; } },
  { id: 'fight', stages: ['adult', 'middle'], weight: (b) => (b.spouseId ? 0.5 : 0), importance: 6, text: (b) => `${b.name}和伴侣大吵一架，差点离婚。`, apply: (b) => { b.state.happiness -= 8; } },
  { id: 'checkup', once: true, stages: ['middle'], weight: (b) => (100 - b.state.health) / 40, importance: 7, text: (b) => `${b.name}体检查出${['高血压', '糖尿病', '脂肪肝', '腰椎间盘突出'][Math.floor(b.talents.luck / 26)]}，不得不开始养生。`, apply: (b) => { b.state.health -= 6; } },
  { id: 'reunion', stages: ['middle', 'senior'], weight: () => 0.6, importance: 5, text: (b) => `${b.name}和多年不见的老同学聚会，感慨万千。`, apply: (b) => { b.state.happiness += 4; } },
  { id: 'grandkids', stages: ['senior'], weight: (b) => (b.childrenIds.length ? 1.5 : 0), importance: 4, text: (b) => `${b.name}开始帮儿女带孙辈，每天接送上下学。`, apply: (b) => { b.state.happiness += 3; } },
  { id: 'square_dance', stages: ['senior'], weight: () => 1, importance: 3, text: (b, c) => `${b.name}${c.year > 2010 ? '迷上了广场舞' : '每天早上去公园打太极'}。`, apply: (b) => { b.state.health += 2; b.state.happiness += 3; } },
  { id: 'fall', stages: ['senior'], weight: (b) => (100 - b.state.health) / 30, importance: 7, text: (b) => `${b.name}摔了一跤，住院做了手术。`, apply: (b) => { b.state.health -= 12; b.state.wealth *= 0.85; } },
  { id: 'health_scam', stages: ['senior'], weight: (b, c) => (c.year > 2015 ? 0.8 : 0), importance: 6, text: (b) => `${b.name}被保健品推销员骗了好几万。`, apply: (b) => { b.state.wealth *= 0.8; b.state.happiness -= 6; } },
];

function randomEvent(bot: Bot, age: number, ctx: EraContext): void {
  void age;
  if (ctx.tick - (bot.state.vars.lastEventTick ?? -99) < 7) return;
  const pool = RANDOM_EVENTS.filter((e) =>
    e.stages.includes(bot.stage)
    && (!e.once || !hasTag(bot, `ev:${e.id}`))
    && (!e.cond || e.cond(bot, ctx))
    && e.weight(bot, ctx) > 0);
  if (!pool.length) return;
  const ev = ctx.rng.weighted(pool, (e) => e.weight(bot, ctx));
  bot.state.vars.lastEventTick = ctx.tick;
  if (ev.once) tag(bot, `ev:${ev.id}`);
  ev.apply?.(bot, ctx);
  bot.state.happiness = clamp(bot.state.happiness, 0, 100);
  bot.state.health = clamp(bot.state.health, 1, 100);
  bot.state.skills.academic = clamp(bot.state.skills.academic, 0, 100);
  ctx.log({ type: 'misc', botId: bot.id, importance: ev.importance, text: ev.text(bot, ctx) });
}

// ---------- 决策落地 ----------

export const decisions: Record<string, DecisionDef> = {
  zhongkao: {
    kind: 'zhongkao',
    apply(bot, choice, ctx) {
      if (choice === 'senior') { tag(bot, 'student'); tag(bot, 'path:senior'); }
      else if (choice === 'vocational') { tag(bot, 'student'); tag(bot, 'path:vocational'); }
      else { tag(bot, 'path:work'); firstJob(bot, ctx); }
    },
  },
  gaokao: {
    kind: 'gaokao',
    apply(bot, choice, ctx) {
      if (choice.startsWith('go:')) { enroll(bot, choice.slice(3), ctx); return; }
      if (choice === 'retry') {
        bot.state.vars.gaokaoRetries = (bot.state.vars.gaokaoRetries ?? 0) + 1;
        tag(bot, 'student');
        tag(bot, 'path:retry');
        bot.state.skills.academic = clamp(bot.state.skills.academic + 4 + bot.personality.conscientiousness / 20, 0, 100);
        return;
      }
      if (choice === 'army') { army(bot, ctx); return; }
      tag(bot, 'path:work');
      firstJob(bot, ctx);
    },
  },
  major: {
    kind: 'major',
    apply(bot, choice) {
      tag(bot, choice);
      if (choice === 'major:计算机' || choice === 'major:工科') bot.state.skills.craft += 10;
      if (choice === 'major:金融') bot.state.skills.business += 15;
    },
  },
  career: {
    kind: 'career',
    deliberation: 2,
    apply(bot, choice, ctx) {
      switch (choice) {
        case 'metro': {
          moveTo(bot, 'metro', ctx, '去大城市打拼');
          const job = pickJob(bot, ctx);
          if (job) giveJob(bot, job, ctx); else bot.state.vars.unemployedSince = ctx.tick;
          break;
        }
        case 'home': {
          moveTo(bot, homeRegion(bot), ctx, '回到老家');
          const job = pickJob(bot, ctx, (j) => (j.id === 'civil' || j.id === 'teacher' || j.id === 'soe' ? 1.8 : 1));
          if (job) giveJob(bot, job, ctx); else bot.state.vars.unemployedSince = ctx.tick;
          break;
        }
        case 'master': {
          const p = clamp(bot.state.skills.academic / 110 * (ctx.year > 2018 ? 0.7 : 1), 0.1, 0.9);
          if (ctx.rng.chance(p)) {
            tag(bot, 'student'); tag(bot, 'grad:master');
            bot.state.vars.gradTick = ctx.tick + 36;
            bot.state.vars.gradEdu = 6;
            bot.state.skills.academic = clamp(bot.state.skills.academic + 8, 0, 100);
            ctx.log({ type: 'exam', botId: bot.id, importance: 7, text: `${bot.name}考研上岸，继续读研究生。` });
          } else {
            ctx.log({ type: 'exam', botId: bot.id, importance: 6, text: `${bot.name}考研失利，只好先找工作。` });
            const job = pickJob(bot, ctx);
            if (job) giveJob(bot, job, ctx); else bot.state.vars.unemployedSince = ctx.tick;
          }
          break;
        }
        case 'civil': {
          const p = clamp((bot.state.skills.academic * 0.6 + bot.personality.conscientiousness * 0.3) / 100 * (ctx.year > 2020 ? 0.35 : ctx.year > 2008 ? 0.55 : 0.8), 0.05, 0.85);
          if (ctx.rng.chance(p)) {
            giveJob(bot, JOBS.find((j) => j.id === 'civil')!, ctx, `${bot.name}考上了公务员，进了${bot.state.city}的机关单位。`);
          } else {
            ctx.log({ type: 'exam', botId: bot.id, importance: 6, text: `${bot.name}考公失利，差了几分。` });
            const job = pickJob(bot, ctx, (j) => (j.id === 'soe' || j.id === 'teacher' ? 1.5 : 1));
            if (job) giveJob(bot, job, ctx); else bot.state.vars.unemployedSince = ctx.tick;
          }
          break;
        }
        case 'startup': startFounder(bot, ctx); break;
      }
    },
  },
  first_job: {
    kind: 'first_job',
    apply(bot, choice, ctx) {
      switch (choice) {
        case 'factory': moveTo(bot, ctx.rng.chance(0.4) ? 'metro' : 'city', ctx, '南下打工'); giveJob(bot, JOBS.find((j) => j.id === (ctx.year < 1985 ? 'migrant' : 'factory'))!, ctx); break;
        case 'home': { const job = pickJob(bot, ctx); if (job) giveJob(bot, job, ctx); break; }
        case 'craft': bot.state.skills.craft = clamp(bot.state.skills.craft + 30, 0, 100); moveTo(bot, 'town', ctx, '去县城学手艺'); giveJob(bot, JOBS.find((j) => j.id === 'shop')!, ctx, `${bot.name}学成手艺，在${bot.state.city}开了个小店。`); break;
        case 'army': army(bot, ctx); break;
        case 'rider': moveTo(bot, 'city', ctx, '进城'); giveJob(bot, JOBS.find((j) => j.id === 'rider')!, ctx); break;
        case 'streamer': giveJob(bot, JOBS.find((j) => j.id === 'streamer')!, ctx); break;
      }
    },
  },
  laid_off: {
    kind: 'laid_off',
    deliberation: 2,
    apply(bot, choice, ctx) {
      switch (choice) {
        case 'same': { const job = pickJob(bot, ctx); if (job && ctx.rng.chance(0.7 * es(ctx).modifiers.hiring)) giveJob(bot, job, ctx); break; }
        case 'switch': { bot.state.skills.craft += 5; const job = pickJob(bot, ctx, (j) => (j.sector === '互联网' ? 0.3 : 1.2)); if (job) giveJob(bot, job, ctx); break; }
        case 'home': { moveTo(bot, homeRegion(bot), ctx, '离开大城市回老家'); const job = pickJob(bot, ctx); if (job) giveJob(bot, job, ctx); break; }
        case 'civil': {
          const p = clamp((bot.state.skills.academic * 0.5 + bot.personality.conscientiousness * 0.3) / 100 * 0.4, 0.05, 0.6);
          if (ctx.rng.chance(p)) giveJob(bot, JOBS.find((j) => j.id === 'civil')!, ctx, `${bot.name}考上了事业编，终于上岸。`);
          else { ctx.log({ type: 'exam', botId: bot.id, importance: 5, text: `${bot.name}考编失利。` }); const job = pickJob(bot, ctx); if (job) giveJob(bot, job, ctx); }
          break;
        }
        case 'rider': giveJob(bot, JOBS.find((j) => j.id === 'rider')!, ctx, `${bot.name}穿上了黄色的骑手服，开始送外卖。`); break;
        case 'startup': startFounder(bot, ctx); break;
      }
    },
  },
  marry: {
    kind: 'marry',
    deliberation: 3,
    apply(bot, choice, ctx, node) {
      const partner = ctx.bot(String(node.data?.partnerId ?? ''));
      if (choice === 'marry' && partner) doMarry(bot, partner, ctx);
      else if (choice === 'single') { tag(bot, 'single'); ctx.log({ type: 'love', botId: bot.id, importance: 6, text: `${bot.name}决定不结婚了，一个人过。` }); }
      else if (partner) ctx.log({ type: 'love', botId: bot.id, importance: 4, text: `${bot.name}和${partner.name}的事最后没了下文。` });
    },
  },
  have_child: {
    kind: 'have_child',
    deliberation: 2,
    apply(bot, choice, ctx) {
      const mother = bot.sex === 'female' ? bot : ctx.bot(bot.spouseId ?? '');
      if (choice === 'yes' && mother) mother.state.vars.dueTick = ctx.tick + 10;
      else if (choice === 'dink') { tag(bot, 'dink'); const sp = ctx.bot(bot.spouseId ?? ''); if (sp) tag(sp, 'dink'); ctx.log({ type: 'child', botId: bot.id, importance: 6, text: `${bot.name}夫妻俩决定做丁克。` }); }
    },
  },
  buy_home: {
    kind: 'buy_home',
    deliberation: 2,
    apply(bot, choice, ctx, node) {
      if (bot.state.ownsHome) return; // 犹豫期里配偶已经买了
      const price = Number(node.data?.price ?? 0);
      const homePrice = Number(node.data?.homePrice ?? 0);
      if (choice === 'buy') buyHome(bot, price, bot.state.location, ctx);
      else if (choice === 'hometown') buyHome(bot, homePrice, homeRegion(bot), ctx);
      else bot.state.vars.homeDeclinedAt = ctx.tick;
    },
  },
};

function army(bot: Bot, ctx: EraContext): void {
  giveJob(bot, JOBS.find((j) => j.id === 'soldier')!, ctx, `${bot.name}穿上军装，入伍了。`);
  bot.state.skills.craft += 10;
  bot.state.health = clamp(bot.state.health + 8, 0, 100);
  bot.personality.conscientiousness = clamp(bot.personality.conscientiousness + 8, 1, 99);
  bot.state.vars.dischargeTick = ctx.tick + 24;
}

function startFounder(bot: Bot, ctx: EraContext): void {
  tag(bot, 'founder');
  const seed = Math.min(bot.state.wealth * 0.7, 300 * es(ctx).wageIndex * 10);
  bot.state.wealth -= seed;
  bot.state.skills.business += 10;
  giveJob(bot, JOBS.find((j) => j.id === 'founder')!, ctx, `${bot.name}拿出${money(seed)}积蓄，在${bot.state.city}开始创业。`);
}

/** 服役期满退伍 */
export function checkDischarge(bot: Bot, ctx: EraContext): void {
  if (bot.state.job?.id === 'soldier' && bot.state.vars.dischargeTick && ctx.tick >= bot.state.vars.dischargeTick) {
    delete bot.state.vars.dischargeTick;
    bot.state.job = undefined;
    bot.state.wealth += 30 * es(ctx).wageIndex * 10;
    ctx.log({ type: 'job', botId: bot.id, importance: 6, text: `${bot.name}退伍了，拿到一笔安置费。` });
    bot.state.vars.unemployedSince = ctx.tick - 12;
  }
}
