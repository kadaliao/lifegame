import { clamp, type EraContext, type Rng } from '@lifegame/core';
import type { Bot, LifeStage } from '@lifegame/schema';
import { JOBS, money } from './data.js';

/**
 * 日常小事：每个月有一定概率从这里抽一件。
 * 每件事按年代、城乡、家境、性格、职业、家里人挑人；同一件事一辈子有次数上限，
 * 发生过的事权重会降低，免得一个人连年重复同一句话。
 */
interface LifeEvent {
  id: string;
  stages: LifeStage[];
  /** 一辈子最多几次，默认 1 */
  max?: number;
  /** 每发生过一次，权重乘上它，默认 0.3 */
  repeat?: number;
  importance: number;
  when?: (b: Bot, c: EraContext) => boolean;
  weight?: (b: Bot, c: EraContext) => number;
  /** 改变状态并返回要写进人生的话。r 是这个人这个月专属的随机数，用它不会打乱这个人往后的随机数流 */
  run: (b: Bot, c: EraContext, r: Rng) => string | { text: string; related?: string[] } | undefined;
}

// ---------- 小工具 ----------

const wi = (c: EraContext) => (c.world.eraState as { wageIndex: number }).wageIndex;
/** 积蓄折算成 1980 年的钱，便于跨年代比较 */
const savings = (b: Bot, c: EraContext) => b.state.wealth / wi(c);
const pick = <T>(r: Rng, xs: T[]): T => r.pick(xs);
const student = (b: Bot) => b.state.tags.includes('student');
const inCollege = (b: Bot, c: EraContext) => student(b) && c.age(b) >= 18;
const urban = (b: Bot) => b.state.location === 'city' || b.state.location === 'metro';
const countryside = (b: Bot) => b.state.location === 'rural' || b.state.location === 'town';
const jobOf = (b: Bot) => (b.state.job ? JOBS.find((j) => j.id === b.state.job!.id) : undefined);
const OFFICE = new Set(['clerk', 'accountant', 'finance', 'programmer', 'pm', 'media', 'designer', 'lawyer', 'engineer', 'researcher', 'civil', 'soe', 'teacher', 'professor', 'sales', 'ai']);
const office = (b: Bot) => !!b.state.job && OFFICE.has(b.state.job.id);
/** AI 浪潮里首当其冲的白领岗位 */
const AI_HIT = new Set(['clerk', 'accountant', 'finance', 'programmer', 'pm', 'media', 'designer', 'lawyer', 'sales']);
const away = (b: Bot) => b.state.city !== b.origin.hometown;
const living = (c: EraContext, id: string | undefined) => {
  const x = id ? c.bot(id) : undefined;
  return x && x.deathTick === undefined ? x : undefined;
};
const kids = (b: Bot, c: EraContext, lo = 0, hi = 200) =>
  b.childrenIds.map((id) => living(c, id)).filter((k): k is Bot => !!k && c.age(k) >= lo && c.age(k) <= hi);
const grandkids = (b: Bot, c: EraContext, lo = 0, hi = 200) => kids(b, c).flatMap((k) => kids(k, c, lo, hi));
const spouse = (b: Bot, c: EraContext) => living(c, b.spouseId);
/** 第一代人的父母不在模拟里，他们的生老病死只能靠这里的小事交代 */
const offstageParents = (b: Bot) => b.parentIds.length === 0;
/** 丧偶、上了年纪、不和自己住一个城市的父母 */
const lonelyParent = (b: Bot, c: EraContext) =>
  b.parentIds.map((id) => living(c, id)).find((p) => !!p && !p.spouseId && c.age(p) >= 70 && p.state.city !== b.state.city);
const done = (b: Bot, id: string) => (b.state.vars[`e${EVENTS.findIndex((e) => e.id === id)}`] ?? 0) > 0;
const lose = (b: Bot, f: number) => { const x = Math.max(0, b.state.wealth) * f; b.state.wealth -= x; return x; };
const mood = (b: Bot, d: number) => { b.state.happiness += d; };
/** 损失一部分积蓄，但不超过当年若干个月的普通工资 */
const loseUpTo = (b: Bot, c: EraContext, f: number, cap: number) => { const x = Math.min(Math.max(0, b.state.wealth) * f, wi(c) * cap); b.state.wealth -= x; return x; };
const marriedYears = (b: Bot, c: EraContext) => Math.floor((c.tick - (b.relationships.find((r) => r.kind === 'spouse' && r.botId === b.spouseId)?.sinceTick ?? c.tick)) / 12);
/** 金额取整到两位有效数字，读起来像人说的话 */
const nice = (n: number) => { const p = 10 ** Math.max(0, Math.floor(Math.log10(Math.max(1, n))) - 1); return Math.round(n / p) * p; };

// ---------- 事件 ----------

const EVENTS: LifeEvent[] = [
  // ===== 童年（3–11 岁）=====
  {
    id: 'river', stages: ['child'], importance: 3,
    when: (b, c) => countryside(b) && c.age(b) >= 6 && c.year < 2012,
    run: (b, c, r) => { mood(b, 2); return pick(r, [
      `${b.name}和小伙伴偷偷下河摸鱼，回家被父母揍了一顿。`,
      `${b.name}跟着村里的大孩子下河游泳，被大人拎着耳朵揪了回来。`,
    ]); },
  },
  {
    id: 'orchard', stages: ['child'], importance: 3,
    when: (b, c) => b.state.location === 'rural' && c.age(b) >= 5 && c.year < 2010,
    run: (b, c, r) => { mood(b, 2); return `${b.name}和小伙伴去偷摘邻居家的${pick(r, ['西瓜', '桃子', '枣', '玉米'])}，被人追了半条街。`; },
  },
  {
    id: 'street_games', stages: ['child'], importance: 3,
    when: (b, c) => c.year < 2006,
    run: (b, c, r) => { mood(b, 3); return `${b.name}${student(b) ? '放学后' : '整天'}和一群孩子${pick(r, ['弹玻璃珠', '跳皮筋', '拍画片', '踢毽子', '滚铁环'])}，玩到天黑才被喊回家吃饭。`; },
  },
  {
    id: 'tv', stages: ['child', 'teen'], importance: 3,
    when: (_b, c) => c.year < 1996,
    run: (b) => {
      mood(b, 4);
      return countryside(b)
        ? `家里买了第一台黑白电视，一到晚上，半个村的孩子都挤到${b.name}家来看。`
        : `家里换了彩电，${b.name}每天放学守着看动画片。`;
    },
  },
  {
    id: 'hobby_class', stages: ['child'], importance: 3,
    when: (b, c) => urban(b) && b.origin.ses >= 3 && c.year >= 1990 && c.age(b) >= 5,
    run: (b, c, r) => {
      b.state.skills.academic += 1; mood(b, -1);
      if (c.year < 2005) return `${b.name}被送去少年宫学${pick(r, ['电子琴', '书法', '画画', '珠心算'])}。`;
      const xs = ['钢琴', '英语', '奥数', '舞蹈', '围棋', ...(c.year >= 2016 ? ['编程'] : [])];
      return `${b.name}的周末被塞满了${pick(r, xs)}、${pick(r, xs.filter((x) => x !== '钢琴'))}等好几个兴趣班。`;
    },
  },
  {
    id: 'red_scarf', stages: ['child'], importance: 3,
    when: (b, c) => student(b) && c.age(b) >= 7 && c.age(b) <= 9,
    run: (b) => { mood(b, 3); return `${b.name}加入了少先队，戴上了红领巾。`; },
  },
  {
    id: 'top_student', stages: ['child', 'teen'], importance: 3, max: 3, repeat: 0.5,
    when: student,
    weight: (b) => b.state.skills.academic / 40,
    run: (b, c, r) => { mood(b, 4); b.state.skills.academic += 2; return pick(r, [
      `${b.name}期末考了全班第一，奖状贴满了墙。`,
      `${b.name}的作文被老师当范文在班上念。`,
      `${b.name}被评为三好学生，家里人高兴了好几天。`,
    ]); },
  },
  {
    id: 'naughty', stages: ['child'], importance: 3, max: 2,
    when: (b, c) => c.age(b) >= 5,
    weight: (b) => ((100 - b.personality.conscientiousness) / 50) * (b.personality.extraversion / 50),
    run: (b, c, r) => { mood(b, -2); return pick(r, [
      `${b.name}踢球把邻居家的窗玻璃打碎了，赔了钱还挨了骂。`,
      student(b) ? `${b.name}上课传纸条，被老师罚站了一节课。` : `${b.name}把家里的闹钟拆了，装不回去，挨了一顿骂。`,
      `${b.name}偷拿家里的钱买零食，被发现后挨了一顿揍。`,
    ]); },
  },
  {
    id: 'bullied', stages: ['child', 'teen'], importance: 4,
    when: student,
    weight: (b) => 0.4 * (b.personality.neuroticism / 50) * ((100 - b.talents.physique) / 60),
    run: (b) => { mood(b, -6); return `${b.name}在学校被几个高年级的孩子欺负，好一阵子不敢一个人上学。`; },
  },
  {
    id: 'child_ill', stages: ['child'], importance: 4, max: 2,
    weight: (b) => (100 - b.talents.physique) / 50,
    run: (b, c, r) => { b.state.health -= 6; return pick(r, [
      `${b.name}大病一场，在医院躺了半个月。`,
      `${b.name}得了肺炎，打了一个星期的吊瓶。`,
      `${b.name}出水痘，在家关了两个星期。`,
    ]); },
  },
  {
    id: 'dog_bite', stages: ['child'], importance: 3,
    weight: () => 0.4,
    run: (b) => `${b.name}被${countryside(b) ? '村口' : '小区里'}的狗咬了一口，去打了好几针狂犬疫苗。`,
  },
  {
    id: 'first_city', stages: ['child'], importance: 4,
    when: (b, c) => b.state.location === 'rural' && c.age(b) >= 6,
    run: (b, c, r) => {
      mood(b, 4);
      return c.year < 2010
        ? `${b.name}第一次跟着大人进城，看见了高楼和公共汽车，回来念叨了好多天。`
        : `${b.name}第一次坐上高铁去城里，趴在车窗上看了一路。`;
    },
  },
  {
    id: 'left_behind', stages: ['child', 'teen'], importance: 5,
    when: (b, c) => b.origin.region === 'rural' && b.state.location === 'rural' && c.year > 1995 && c.year < 2015,
    weight: () => 2,
    run: (b) => { mood(b, -8); return `${b.name}的父母去外地打工了，${b.name}成了留守儿童，跟着爷爷奶奶过。`; },
  },
  {
    id: 'new_home', stages: ['child', 'teen'], importance: 4,
    when: (b) => offstageParents(b) && b.origin.region !== 'rural',
    weight: (b) => b.origin.ses / 3,
    run: (b, c, r) => {
      mood(b, 4);
      return c.year < 1998
        ? `家里分到了单位的新楼房，${b.name}第一次有了自己的小床。`
        : `家里搬进了新买的商品房，${b.name}有了自己的房间。`;
    },
  },
  {
    id: 'lucky_money', stages: ['child'], importance: 3,
    weight: () => 0.6,
    run: (b, c, r) => `过年${b.name}拿到了${c.year < 1995 ? '几块钱' : c.year < 2010 ? '几百块' : '上千块'}压岁钱，转手就被妈妈"先替你存着"了。`,
  },
  {
    id: 'myopia', stages: ['child', 'teen'], importance: 3,
    when: (_b, c) => c.year >= 2010,
    weight: () => 0.6,
    run: (b, c, r) => { b.state.health -= 1; return `${b.name}每天抱着${c.year < 2016 ? '手机' : '平板'}看动画片，近视了，戴上了小眼镜。`; },
  },
  {
    id: 'ai_tutor', stages: ['child', 'teen'], importance: 3,
    when: (b, c) => student(b) && c.year >= 2030,
    run: (b) => { b.state.skills.academic += 2; mood(b, 2); return `家里的 AI 学习机比爸妈还会讲题，${b.name}写作业不再挨骂了。`; },
  },

  // ===== 少年（12–17 岁）=====
  {
    id: 'puppy_love', stages: ['teen'], importance: 5,
    when: student,
    weight: (b) => b.talents.charm / 50,
    run: (b, c, r) => { mood(b, 4); b.state.skills.academic -= 2; return pick(r, [
      `${b.name}早恋了，被老师叫了家长。`,
      `${b.name}和同桌传了一学期的纸条，被班主任抓了个正着。`,
    ]); },
  },
  {
    id: 'crush', stages: ['teen'], importance: 4,
    when: student,
    weight: (b) => (100 - b.personality.extraversion) / 50,
    run: (b) => { mood(b, 1); return `${b.name}暗恋班上一个同学，整整三年，一句话也没敢说。`; },
  },
  {
    id: 'gaming', stages: ['teen'], importance: 4, max: 2, repeat: 0.4,
    when: (b, c) => student(b) && c.year >= 1990,
    weight: (b, c) => (c.year > 2000 ? 1.5 : 0.6) * ((100 - b.personality.conscientiousness) / 50),
    run: (b, c, r) => {
      b.state.skills.academic -= 6;
      const what = c.year < 2000 ? '泡游戏厅' : c.year < 2012 ? '泡网吧' : c.year < 2030 ? '打手游' : '玩 VR 游戏';
      return `${b.name}迷上了${what}，成绩一落千丈。`;
    },
  },
  {
    id: 'contest', stages: ['teen'], importance: 5,
    when: student,
    weight: (b) => b.talents.intellect / 60,
    run: (b, c, r) => { b.state.skills.academic += 6; mood(b, 5); return `${b.name}在${pick(r, ['数学', '物理', '化学', '作文'])}竞赛中拿了奖。`; },
  },
  {
    id: 'boarding', stages: ['teen'], importance: 4,
    when: (b, c) => student(b) && countryside(b) && c.age(b) <= 15,
    weight: () => 1.5,
    run: (b, c, r) => {
      mood(b, -2);
      return c.year < 2005
        ? `${b.name}去镇上读书，开始住校，每周背一罐咸菜、一袋馒头回学校。`
        : `${b.name}开始住校，第一次离开家，头几个晚上偷偷在被窝里哭。`;
    },
  },
  {
    id: 'idol', stages: ['teen'], importance: 3,
    run: (b, c, r) => {
      mood(b, 3);
      if (c.year < 1995) return `${b.name}迷上了港台流行歌，攒钱买磁带，抄了满满一本歌词。`;
      if (c.year < 2005) return `${b.name}的房间贴满了歌星海报，随身听里全是偶像的歌。`;
      if (c.year < 2014) return `${b.name}熬夜给选秀节目投票，零花钱全花在了短信上。`;
      if (c.year < 2030) return `${b.name}追偶像团体，攒钱买专辑、打榜应援。`;
      return `${b.name}迷上了一个虚拟偶像，和同学争论它到底算不算一个人。`;
    },
  },
  {
    id: 'cold_war', stages: ['teen'], importance: 4,
    weight: (b) => b.personality.neuroticism / 50,
    run: (b) => { mood(b, -4); return `${b.name}青春期和父母闹别扭，一个月没说几句话。`; },
  },
  {
    id: 'sports', stages: ['teen'], importance: 4,
    when: student,
    weight: (b) => b.talents.physique / 50,
    run: (b, c, r) => { b.state.health += 3; mood(b, 3); return `${b.name}被选进了校${pick(r, ['篮球队', '田径队', '足球队', '排球队'])}，每天训练到天黑。`; },
  },
  {
    id: 'smoke', stages: ['teen'], importance: 3,
    when: (_b, c) => c.year < 2020,
    weight: (b) => ((100 - b.personality.conscientiousness) / 60) * (b.sex === 'male' ? 1 : 0.3),
    run: (b) => {
      b.state.health -= 1;
      return student(b) ? `${b.name}跟着几个哥们躲在厕所里学抽烟，被教导主任逮个正着。` : `${b.name}跟着工友学会了抽烟。`;
    },
  },
  {
    id: 'cram', stages: ['teen'], importance: 4,
    when: (b, c) => student(b) && urban(b) && c.year >= 1995,
    run: (b, c, r) => {
      b.state.skills.academic += 3; mood(b, -3);
      return c.year < 2021
        ? `${b.name}的周末和寒暑假都泡在补习班里，难得睡个懒觉。`
        : c.year < 2030
          ? `双减之后，补习班搬进了居民楼，${b.name}照样每周去上三次课。`
          : `${b.name}每天晚上跟 AI 家教刷题到十一点。`;
    },
  },
  {
    id: 'first_qq', stages: ['teen', 'youth'], importance: 3,
    when: (_b, c) => c.year >= 1999 && c.year <= 2006,
    run: (b) => { mood(b, 2); return `${b.name}在网吧申请了第一个 QQ 号，网名起得很"非主流"。`; },
  },
  {
    id: 'first_phone', stages: ['teen', 'youth'], importance: 3,
    when: (_b, c) => c.year >= 2003 && c.year <= 2015,
    run: (b, c, r) => { mood(b, 3); return `${b.name}有了第一部手机，${c.year < 2010 ? '是台翻盖机，每天和同学发短信' : '上课偷偷在桌子底下刷'}。`; },
  },
  {
    id: 'poor_help', stages: ['teen'], importance: 4,
    when: (b) => student(b) && b.origin.ses <= 2,
    weight: () => 1.5,
    run: (b, c, r) => {
      b.personality.conscientiousness = clamp(b.personality.conscientiousness + 2, 1, 99);
      return b.state.location === 'rural'
        ? `${b.name}放学和假期都要下地干活，作业只能${c.year < 1995 ? '在煤油灯下' : '趁天黑前'}赶完。`
        : `${b.name}暑假去${pick(r, ['饭馆', '工地', '亲戚的小店'])}打零工，挣下学期的学费。`;
    },
  },
  {
    id: 'senior_year', stages: ['teen'], importance: 4,
    when: (b, c) => b.state.tags.includes('path:senior') && c.age(b) >= 16,
    weight: () => 2,
    run: (b) => { b.state.skills.academic += 2; mood(b, -3); return `${b.name}上了高三，每天只睡五个小时，教室后墙挂着高考倒计时。`; },
  },

  // ===== 年代大事的亲身经历 =====
  {
    id: 'hk_1997', stages: ['child', 'teen', 'youth', 'adult', 'middle', 'senior'], importance: 3,
    when: (_b, c) => c.year === 1997,
    weight: () => 3,
    run: (b) => `香港回归那天晚上，${b.name}守在电视机前看交接仪式。`,
  },
  {
    id: 'sars', stages: ['teen', 'youth'], importance: 4,
    when: (b, c) => c.year === 2003 && student(b),
    weight: () => 3,
    run: (b) => `非典期间学校封校，${b.name}每天被量三次体温。`,
  },
  {
    id: 'olympics', stages: ['child', 'teen', 'youth', 'adult', 'middle', 'senior'], importance: 3,
    when: (_b, c) => c.year === 2008,
    weight: () => 3,
    run: (b) => { mood(b, 3); return `北京奥运会开幕那晚，${b.name}和家人守在电视机前看完了整场。`; },
  },
  {
    id: 'online_class', stages: ['child', 'teen', 'youth'], importance: 4,
    when: (b, c) => c.year >= 2020 && c.year <= 2022 && student(b),
    weight: () => 3,
    run: (b) => { mood(b, -3); return `疫情来了，${b.name}在家对着屏幕上网课，好几个月没见到同学。`; },
  },
  {
    id: 'lockdown', stages: ['youth', 'adult', 'middle', 'senior'], importance: 4,
    when: (b, c) => c.year >= 2020 && c.year <= 2022 && !student(b),
    weight: () => 2,
    run: (b) => { mood(b, -3); return `${b.name}被封控在${countryside(b) ? '村里' : '小区里'}一个多月，每天下楼排队做核酸。`; },
  },

  // ===== 青年（18–29 岁）=====
  {
    id: 'dorm', stages: ['youth'], importance: 4,
    when: inCollege,
    weight: () => 2,
    run: (b) => { mood(b, 4); b.state.skills.social += 2; return `${b.name}和大学室友夜里卧谈到天亮，处成了一辈子的朋友。`; },
  },
  {
    id: 'fail_course', stages: ['youth'], importance: 4,
    when: inCollege,
    weight: (b) => (100 - b.personality.conscientiousness) / 50,
    run: (b, c, r) => { b.state.skills.academic -= 3; mood(b, -3); return `${b.name}${c.year < 2005 ? '整天打牌' : '沉迷游戏'}，期末挂了两门课，差点拿不到学位。`; },
  },
  {
    id: 'student_cadre', stages: ['youth'], importance: 4,
    when: inCollege,
    weight: (b) => b.personality.extraversion / 50,
    run: (b) => { b.state.skills.social += 4; return `${b.name}当上了学生会干部，忙着办晚会、拉赞助。`; },
  },
  {
    id: 'breakup', stages: ['youth', 'adult'], importance: 5, max: 2, repeat: 0.4,
    when: (b) => !b.spouseId,
    weight: () => 1.5,
    run: (b, c, r) => { mood(b, -10); return pick(r, [
      `${b.name}失恋了，难过了好一阵。`,
      `${b.name}的初恋去了另一座城市，两个人慢慢断了联系。`,
      `${b.name}被分手了，在${c.year < 2010 ? '日记本' : '朋友圈'}里写了很长一段话，又删掉了。`,
    ]); },
  },
  {
    id: 'blind_date', stages: ['youth', 'adult'], importance: 4, max: 3, repeat: 0.5,
    when: (b, c) => !b.spouseId && !student(b) && c.age(b) >= 22,
    run: (b, c, r) => {
      mood(b, -2);
      if (c.year < 1995) return `${b.name}被媒人领去相亲，两人在公园里转了一圈就没了下文。`;
      if (c.year < 2012) return pick(r, [`${b.name}被家里安排相亲，饭桌上对方先问有没有房。`, `${b.name}被家里安排相亲，场面很尴尬。`]);
      return pick(r, [`${b.name}的照片被爸妈挂到了公园的相亲角。`, `${b.name}在相亲软件上聊了几个人，见面后都不了了之。`, `${b.name}被家里安排相亲，场面很尴尬。`]);
    },
  },
  {
    id: 'spring_rush', stages: ['youth', 'adult'], importance: 4, max: 2, repeat: 0.4,
    when: (b, c) => away(b) && !!b.state.job && c.year >= 1985 && c.year < 2030,
    run: (b, c, r) => {
      mood(b, -2);
      if (c.year < 2000) return `春节回家，${b.name}在挤满人的绿皮火车上站了三十个小时。`;
      if (c.year < 2012) return `为了一张回家的火车票，${b.name}在售票厅排了一夜的队。`;
      return `${b.name}在 12306 上抢了三天，才抢到一张回家的车票。`;
    },
  },
  {
    id: 'remit', stages: ['youth'], importance: 4,
    when: (b, c) => !!b.state.job && c.tick - b.state.job.sinceTick < 36 && c.age(b) <= 26 && b.origin.ses <= 3 && b.state.wealth > 0,
    weight: (b) => 0.5 * (b.values.family / 50) * (b.origin.ses <= 2 ? 2 : 1),
    run: (b) => {
      const x = nice(Math.min(b.state.wealth * 0.5, b.state.job!.salary));
      b.state.wealth -= x; mood(b, 3);
      return `${b.name}攒下的第一笔钱，给家里寄回去了${money(x)}。`;
    },
  },
  {
    id: 'rent', stages: ['youth', 'adult'], importance: 4, max: 2, repeat: 0.4,
    when: (b, c) => b.state.location === 'metro' && !b.state.ownsHome && !student(b) && c.year >= 1990,
    run: (b, c, r) => {
      mood(b, -4);
      if (c.year < 2005) return `${b.name}和几个老乡挤在城中村的单间里，夏天热得整夜睡不着。`;
      return pick(r, [
        `${b.name}租的房子被房东突然收回，周末扛着行李到处找房。`,
        `${b.name}被二房东卷走了押金，只好重新找房。`,
        `${b.name}每天通勤两个小时，${c.year < 2012 ? '挤公交' : '挤地铁'}挤到怀疑人生。`,
      ]);
    },
  },
  {
    id: 'overtime', stages: ['youth', 'adult'], importance: 4, max: 2, repeat: 0.4,
    when: (b, c) => c.year >= 2008 && !!b.state.job && ['互联网', '金融', '文化传媒', '法律', '人工智能'].includes(jobOf(b)!.sector),
    weight: () => 1.5,
    run: (b, c, r) => { b.state.health -= 3; mood(b, -3); return pick(r, [
      `${b.name}的项目组实行"996"，凌晨两点打车回家是常事。`,
      `${b.name}连续加班了三个月，体检报告上多了好几个箭头。`,
    ]); },
  },
  {
    id: 'scolded', stages: ['youth', 'adult', 'middle'], importance: 4, max: 3, repeat: 0.5,
    when: (b) => !!b.state.job && jobOf(b)!.prestige >= 35 && b.state.job.id !== 'founder',
    run: (b, c, r) => { mood(b, -5); return pick(r, [
      `${b.name}被领导当众批评，憋了一肚子气。`,
      `${b.name}辛苦做的方案，被同事拿去领导面前邀了功。`,
      `${b.name}年终考评没评上优秀，奖金泡了汤。`,
    ]); },
  },
  {
    id: 'bonus', stages: ['youth', 'adult', 'middle'], importance: 5, max: 2, repeat: 0.4,
    when: (b) => !!b.state.job && jobOf(b)!.prestige >= 35 && b.state.job.id !== 'founder',
    weight: () => 0.8,
    run: (b) => {
      const x = nice(b.state.job!.salary * 3);
      b.state.wealth += x; mood(b, 6);
      return `${b.name}做成了一个大项目，拿到${money(x)}奖金。`;
    },
  },
  {
    id: 'driving', stages: ['youth', 'adult'], importance: 3,
    when: (b, c) => c.year >= 2003 && c.year < 2035 && !student(b) && (urban(b) || savings(b, c) > 100),
    weight: () => 0.6,
    run: (b) => `${b.name}去考驾照，科目二挂了两次才过。`,
  },
  {
    id: 'pet', stages: ['youth', 'adult'], importance: 3,
    when: (b, c) => urban(b) && !b.spouseId && c.year >= 2010 && !student(b),
    run: (b, c, r) => { mood(b, 4); return `${b.name}养了一只${pick(r, ['猫', '狗'])}，下班回家终于有个伴。`; },
  },
  {
    id: 'travel', stages: ['youth', 'adult'], importance: 4, max: 2, repeat: 0.4,
    when: (b, c) => c.year >= 2000 && savings(b, c) > 100,
    weight: (b) => 0.7 * (b.values.adventure / 50),
    run: (b, c, r) => {
      lose(b, 0.05); mood(b, 5);
      return c.year < 2014
        ? `${b.name}背着包去了一趟${pick(r, ['西藏', '云南', '新疆', '青海湖'])}，回来晒黑了一圈。`
        : `${b.name}请了年假，去${pick(r, ['大理', '川西', '海边', '日本', '东南亚', '新疆'])}玩了一圈。`;
    },
  },
  {
    id: 'fitness', stages: ['youth', 'adult'], importance: 3,
    when: (b, c) => urban(b) && c.year >= 2014 && !!b.state.job,
    run: (b, c, r) => {
      const end = pick(r, ['去了两次就再也没去过', '坚持了半年，瘦了十斤', '后来跑完了人生第一个全程马拉松']);
      if (!end.startsWith('去了两次')) b.state.health += 3;
      return `${b.name}办了一张健身卡，${end}。`;
    },
  },
  {
    id: 'scam', stages: ['youth', 'adult', 'middle'], importance: 6,
    when: (b, c) => savings(b, c) > 150,
    weight: (b, c) => (c.year > 2005 ? 0.6 : 0.3) * (b.personality.agreeableness / 50),
    run: (b, c, r) => {
      mood(b, -12);
      if (c.year < 2003) { const x = loseUpTo(b, c, 0.4, 1500); return `${b.name}被老乡骗进传销窝点，好不容易才脱身，带去的${money(x)}全打了水漂。`; }
      const x = loseUpTo(b, c, r.range(0.2, 0.5), 3000);
      if (c.year < 2013) return `${b.name}接到一个自称"公检法"的电话，稀里糊涂转出去了${money(x)}。`;
      if (c.year < 2028) return `${b.name}在网上遇到了"杀猪盘"，被骗走${money(x)}。`;
      return `${b.name}接到"家人"打来的视频电话求救，转了${money(x)}才发现是 AI 换脸。`;
    },
  },
  {
    id: 'lottery', stages: ['youth', 'adult', 'middle', 'senior'], importance: 5,
    weight: (b) => b.talents.luck / 150,
    run: (b, c, r) => {
      const x = nice(wi(c) * (r.chance(0.85) ? r.range(20, 80) : r.range(400, 1500)));
      b.state.wealth += x; mood(b, 6);
      return `${b.name}买彩票中了${money(x)}，${x > wi(c) * 300 ? '高兴得一夜没睡着' : '请朋友吃了顿饭'}。`;
    },
  },
  {
    id: 'invest', stages: ['youth', 'adult', 'middle'], importance: 5, max: 2, repeat: 0.4,
    when: (b, c) => c.year >= 1991 && urban(b) && savings(b, c) > 100,
    weight: (b) => b.values.adventure / 50,
    run: (b, c, r) => {
      const y = c.year;
      const win = r.chance(0.35 + b.talents.luck / 250);
      const gain = () => { const x = Math.max(0, b.state.wealth) * r.range(0.1, 0.4); b.state.wealth += x; mood(b, 4); return x; };
      const loss = (f: number) => { mood(b, -6); return lose(b, f); };
      if (y < 2001) return win ? `${b.name}托人买到了原始股，上市后赚了${money(gain())}。` : `${b.name}托人买的原始股成了废纸，亏了${money(loss(0.3))}。`;
      if (y >= 2006 && y <= 2008) return `${b.name}赶上全民炒股开了户，先赚后赔，最后亏了${money(loss(0.25))}。`;
      if (y >= 2014 && y <= 2015) return win ? `${b.name}在牛市里赚了${money(gain())}，股灾前跑了出来。` : `${b.name}在牛市里加了杠杆，股灾时爆了仓，亏掉${money(loss(0.4))}。`;
      if (y >= 2016 && y <= 2019) return `${b.name}把积蓄投进了 P2P，平台爆雷，${money(loss(0.5))}血本无归。`;
      const what = y < 2020 ? '炒股' : y < 2026 ? '买基金' : '买 AI 概念股';
      return win ? `${b.name}跟风${what}，赚了${money(gain())}。` : `${b.name}跟风${what}，亏了${money(loss(0.15))}。`;
    },
  },
  {
    id: 'ai_anxiety', stages: ['youth', 'adult', 'middle'], importance: 4,
    when: (b, c) => c.year >= 2026 && c.year <= 2040 && !!b.state.job && AI_HIT.has(b.state.job.id),
    weight: () => 2,
    run: (b) => { mood(b, -4); return `${b.name}看着 AI 一个下午做完了自己一周的活，心里一阵发慌。`; },
  },

  // ===== 成年（30–44 岁）=====
  {
    id: 'kid_fever', stages: ['youth', 'adult'], importance: 4,
    when: (b, c) => kids(b, c, 0, 5).length > 0,
    weight: () => 1.5,
    run: (b, c, r) => {
      const k = pick(r, kids(b, c, 0, 5));
      b.state.health -= 1;
      return { text: `${k.name}半夜发高烧，${b.name}抱着孩子在儿童医院排了一夜的队。`, related: [k.id] };
    },
  },
  {
    id: 'school_pull', stages: ['adult', 'middle'], importance: 5, max: 2, repeat: 0.4,
    when: (b, c) => kids(b, c, 5, 15).length > 0,
    run: (b, c, r) => {
      const k = pick(r, kids(b, c, 5, 15));
      lose(b, 0.05); mood(b, -3);
      const text = b.state.location === 'metro' && c.year >= 2010 && c.year < 2024
        ? `为了${k.name}上学，${b.name}跑遍了附近的学区房，一问价格又默默走了。`
        : `${b.name}为了让${k.name}上个好学校，四处托关系。`;
      return { text, related: [k.id] };
    },
  },
  {
    id: 'tutoring', stages: ['adult', 'middle'], importance: 4,
    when: (b, c) => urban(b) && c.year >= 2000 && c.year < 2021 && kids(b, c, 6, 15).length > 0,
    run: (b, c, r) => {
      const k = pick(r, kids(b, c, 6, 15));
      const x = loseUpTo(b, c, 0.1, 400); mood(b, -2);
      return { text: `${b.name}给${k.name}报了三个补习班，一年花掉${money(x)}。`, related: [k.id] };
    },
  },
  {
    id: 'teen_kid', stages: ['adult', 'middle'], importance: 4,
    when: (b, c) => kids(b, c, 13, 17).length > 0,
    run: (b, c, r) => {
      const k = pick(r, kids(b, c, 13, 17));
      mood(b, -4);
      return { text: `${k.name}进了青春期，和${b.name}${pick(r, ['一句话不对就摔门', '冷战了整整一个月', '为了玩手机大吵一架'])}。`, related: [k.id] };
    },
  },
  {
    id: 'fight', stages: ['adult', 'middle'], importance: 5, max: 2, repeat: 0.4,
    when: (b, c) => !!spouse(b, c),
    weight: () => 0.6,
    run: (b, c, r) => {
      const sp = spouse(b, c)!;
      mood(b, -6);
      const text = kids(b, c, 0, 10).length && r.chance(0.5)
        ? `${b.name}和${sp.name}为了谁带孩子的事吵了一夜。`
        : pick(r, [`${b.name}和${sp.name}大吵一架，差点离婚。`, `${b.name}和${sp.name}为了给双方老人多少钱的事冷战了一个星期。`]);
      return { text, related: [sp.id] };
    },
  },
  {
    id: 'anniversary', stages: ['adult', 'middle'], importance: 4,
    when: (b, c) => !!spouse(b, c) && c.year >= 1995 && marriedYears(b, c) >= 8 && marriedYears(b, c) <= 30,
    run: (b, c, r) => {
      const sp = spouse(b, c)!; const n = marriedYears(b, c); mood(b, 5);
      return { text: `${b.name}和${sp.name}结婚${n}年，${n >= 20 ? '孩子们张罗着给两人拍了一套纪念照' : '补拍了一套婚纱照'}。`, related: [sp.id] };
    },
  },
  {
    id: 'another_child', stages: ['adult'], importance: 3,
    when: (b, c) => c.year >= 2016 && !!b.spouseId && b.childrenIds.length === 1,
    run: (b) => { mood(b, -2); return `长辈天天催${b.name}再生一个，${b.name}算了算账，没敢接话。`; },
  },
  {
    id: 'car', stages: ['youth', 'adult', 'middle'], importance: 5,
    when: (b, c) => c.year >= 2003 && savings(b, c) > 400 && !student(b),
    run: (b, c, r) => {
      lose(b, 0.25); mood(b, 5);
      if (c.year >= 2035) return `${b.name}买了第一辆无人驾驶的车，上车说一声目的地就行。`;
      return `${b.name}买了人生第一辆车，${countryside(b) || away(b) ? '过年开回老家，亲戚们都围过来看' : '周末终于能带家人出去转转'}。`;
    },
  },
  {
    id: 'lend', stages: ['adult', 'middle'], importance: 5,
    when: (b, c) => savings(b, c) > 100,
    weight: (b) => 0.4 * (b.personality.agreeableness / 60),
    run: (b, c, r) => { const x = loseUpTo(b, c, 0.2, 1200); mood(b, -5); return `${b.name}借给老同学${money(x)}，后来对方再也联系不上了。`; },
  },
  {
    id: 'desk_body', stages: ['adult', 'middle'], importance: 4,
    when: office,
    run: (b) => { b.state.health -= 3; return `${b.name}长年伏案，颈椎和腰都出了毛病，开始每周去做理疗。`; },
  },
  {
    id: 'demolition', stages: ['youth', 'adult', 'middle', 'senior'], importance: 7,
    when: (b, c) => b.origin.region !== 'metro' && c.year >= 2005 && c.year <= 2020,
    weight: () => 0.3,
    run: (b, c, r) => {
      const x = nice(wi(c) * r.range(800, 6000));
      b.state.wealth += x; mood(b, 8);
      return `${b.name}老家的房子赶上了拆迁，分到${money(x)}补偿款。`;
    },
  },

  // ===== 父母（只给父母不在模拟里的第一代人；后代的父母是真人，他们的病和死由引擎写进来）=====
  {
    id: 'parent_live_in', stages: ['adult', 'middle', 'senior'], importance: 5,
    when: (b, c) => (offstageParents(b) ? c.age(b) < 60 && !(done(b, 'mother_dies') && done(b, 'father_dies')) : !!lonelyParent(b, c)),
    weight: (b) => b.values.family / 60,
    run: (b, c, r) => {
      mood(b, -2);
      const how = pick(r, ['每天端水喂药', '下班先去陪老人说说话']);
      const p = lonelyParent(b, c);
      if (p) {
        // 真人父母跟着搬过来
        p.state.city = b.state.city; p.state.location = b.state.location;
        return { text: `${b.name}把独居的${p.sex === 'male' ? '父亲' : '母亲'}${p.name}接到家里同住，${how}。`, related: [p.id] };
      }
      const who = done(b, 'mother_dies') ? '父亲' : done(b, 'father_dies') ? '母亲' : pick(r, ['父亲', '母亲']);
      return `${b.name}把年迈的${who}接到家里同住，${how}。`;
    },
  },
  {
    id: 'father_ill', stages: ['adult', 'middle'], importance: 7,
    when: (b, c) => (offstageParents(b) ? !done(b, 'father_dies') : (b.parentIds.map((id) => living(c, id)).find((p) => p?.sex === 'male')?.state.health ?? 100) < 45),
    weight: () => 1.2,
    run: (b, c, r) => {
      const f = b.parentIds.map((id) => living(c, id)).find((p) => p?.sex === 'male');
      const x = loseUpTo(b, c, 0.4, 2500); mood(b, -10); b.state.health -= 3;
      const cost = x > 0 ? `，花掉了${money(x)}积蓄` : '，到处借钱交住院费';
      if (f) return { text: `${b.name}的父亲${f.name}病重住院，${b.name}在医院陪护了几个月${cost}。`, related: [f.id] };
      return `${b.name}的父亲病重，${b.name}在医院陪护了几个月${cost}。`;
    },
  },
  {
    id: 'father_dies', stages: ['adult', 'middle', 'senior'], importance: 8,
    when: (b, c) => offstageParents(b) && c.age(b) >= 32,
    weight: (b, c) => (c.age(b) - 25) / 25,
    run: (b) => { mood(b, -15); return `${b.name}的父亲去世了。`; },
  },
  {
    id: 'mother_dies', stages: ['adult', 'middle', 'senior'], importance: 8,
    when: (b, c) => offstageParents(b) && c.age(b) >= 32,
    weight: (b, c) => (c.age(b) - 28) / 25,
    run: (b) => { mood(b, -15); return `${b.name}的母亲去世了。`; },
  },

  // ===== 中年（45–59 岁）=====
  {
    id: 'checkup', stages: ['middle'], importance: 7,
    weight: (b) => (100 - b.state.health) / 40,
    run: (b, c, r) => { b.state.health -= 6; return `${b.name}体检查出${pick(r, ['高血压', '糖尿病', '脂肪肝', '腰椎间盘突出', '甲状腺结节'])}，不得不开始养生。`; },
  },
  {
    id: 'down_payment', stages: ['middle', 'senior'], importance: 6,
    when: (b, c) => c.year >= 2003 && savings(b, c) > 200 && kids(b, c, 24, 40).some((k) => !k.state.ownsHome),
    weight: (b) => b.values.family / 40,
    run: (b, c, r) => {
      const k = pick(r, kids(b, c, 24, 40).filter((x) => !x.state.ownsHome));
      const x = lose(b, 0.5);
      k.state.wealth += x;
      return { text: `${b.name}拿出${money(x)}积蓄，帮${k.name}凑买房的首付。`, related: [k.id] };
    },
  },
  {
    id: 'push_marry', stages: ['middle', 'senior'], importance: 4, max: 2, repeat: 0.4,
    when: (b, c) => kids(b, c, 27, 40).some((k) => !k.spouseId),
    weight: (b) => b.values.tradition / 40,
    run: (b, c, r) => {
      const k = pick(r, kids(b, c, 27, 40).filter((x) => !x.spouseId));
      mood(b, -3);
      return { text: `${b.name}天天催${k.name}结婚，${pick(r, ['偷偷去公园相亲角给孩子挂了资料', '过年饭桌上又吵了起来', '托遍了亲戚朋友介绍对象'])}。`, related: [k.id] };
    },
  },
  {
    id: 'midlife', stages: ['middle'], importance: 4,
    weight: (b) => b.personality.neuroticism / 50,
    run: (b) => { mood(b, -3); return `${b.name}步入中年，常常半夜醒来睡不着，想着${b.state.vars.debt ? '房贷、' : ''}孩子和老人。`; },
  },
  {
    id: 'hobby', stages: ['middle', 'senior'], importance: 3,
    run: (b, c, r) => { mood(b, 4); return `${b.name}迷上了${pick(r, ['钓鱼', '养花', '书法', '摄影', '徒步', '下象棋'])}，周末总不见人影。`; },
  },
  {
    id: 'reunion', stages: ['middle', 'senior'], importance: 5, max: 2, repeat: 0.4,
    weight: () => 0.7,
    run: (b, c, r) => { mood(b, 4); return `${b.name}和多年不见的老同学聚会，${pick(r, ['当年的差生成了老板', '当年的班长头发全白了', '才发现大家聊的都是孩子和血压'])}，感慨万千。`; },
  },
  {
    id: 'peer_death', stages: ['middle', 'senior'], importance: 5,
    weight: () => 0.5,
    run: (b) => { mood(b, -4); return `${b.name}听说一位老同学因病走了，第一次觉得人生无常。`; },
  },
  {
    id: 'smartphone', stages: ['middle', 'senior'], importance: 3,
    when: (b, c) => c.year >= 2013 && c.year <= 2020 && c.age(b) >= 48,
    run: (b, c, r) => {
      const k = kids(b, c, 15)[0];
      return `${b.name}被${k ? k.name : '年轻同事'}教会了用微信，开始在家族群里转发养生文章。`;
    },
  },

  // ===== 老年（60 岁以上）=====
  {
    id: 'grandkids', stages: ['middle', 'senior'], importance: 5,
    when: (b, c) => grandkids(b, c, 1, 8).length > 0,
    weight: () => 2,
    run: (b, c, r) => {
      const g = pick(r, grandkids(b, c, 1, 8));
      mood(b, 3);
      return { text: `${b.name}开始帮着带孙辈，每天接送${g.name}上下学。`, related: [g.id] };
    },
  },
  {
    id: 'square_dance', stages: ['senior'], importance: 3,
    run: (b, c, r) => {
      b.state.health += 2; mood(b, 3);
      return c.year < 2008 ? `${b.name}每天早上去公园打太极拳。` : c.year < 2035 ? `${b.name}迷上了广场舞，天天晚上准时到场。` : `${b.name}报了社区老年大学的${pick(r, ['书法', '摄影', '合唱', '短视频剪辑'])}班。`;
    },
  },
  {
    id: 'fall', stages: ['senior'], importance: 7, max: 2, repeat: 0.4,
    weight: (b) => (100 - b.state.health) / 30,
    run: (b) => { b.state.health -= 12; lose(b, 0.15); return `${b.name}摔了一跤，住院做了手术。`; },
  },
  {
    id: 'health_scam', stages: ['senior'], importance: 6,
    when: (b, c) => c.year >= 2005 && savings(b, c) > 50,
    weight: (b) => b.personality.agreeableness / 50,
    run: (b, c, r) => { const x = loseUpTo(b, c, 0.2, 600); mood(b, -6); return `${b.name}被保健品推销员哄着听"健康讲座"，前后买了${money(x)}的保健品。`; },
  },
  {
    id: 'short_video', stages: ['senior'], importance: 3,
    when: (_b, c) => c.year >= 2018,
    run: (b) => { mood(b, 2); return `${b.name}学会了刷短视频，一刷就是一下午。`; },
  },
  {
    id: 'empty_nest', stages: ['senior'], importance: 5,
    when: (b, c) => kids(b, c, 18).length > 0 && kids(b, c, 18).every((k) => k.state.city !== b.state.city),
    weight: () => 1.5,
    run: (b, c, r) => {
      const k = kids(b, c, 18)[0];
      mood(b, -4);
      return { text: `${k.name}在${k.state.city}安了家，一年只回来一次，${b.name}${spouse(b, c) ? '和老伴' : '一个人'}守着空荡荡的屋子。`, related: [k.id] };
    },
  },
  {
    id: 'tour', stages: ['senior'], importance: 4,
    when: (b, c) => savings(b, c) > 100,
    run: (b, c, r) => {
      lose(b, 0.05); mood(b, 5);
      return `${b.name}和${spouse(b, c) ? '老伴' : '几个老朋友'}报了旅行团，${pick(r, ['去北京看了升国旗', '坐邮轮出了一趟国', '逛遍了江南的古镇'])}。`;
    },
  },
  {
    id: 'memoir', stages: ['senior'], importance: 4,
    when: (b, c) => c.age(b) >= 65,
    weight: (b) => b.personality.openness / 60,
    run: (b, c, r) => `${b.name}开始把自己这一辈子的事写下来，${c.year < 2030 ? '写满了三个笔记本' : '对着 AI 口述，整理成了一本书'}。`,
  },
  {
    id: 'nursing_home', stages: ['senior'], importance: 6,
    when: (b, c) => c.age(b) >= 78 && !b.spouseId && c.year >= 2025,
    weight: () => 1.5,
    run: (b, c, r) => { mood(b, -2); return `${b.name}住进了养老院，${c.year >= 2040 ? '护理机器人每天提醒吃药、陪着说话' : '和几个老伙计成了牌友'}。`; },
  },
  {
    id: 'care_robot', stages: ['senior'], importance: 5,
    when: (b, c) => c.year >= 2040 && b.state.health < 55,
    weight: () => 1.5,
    run: (b) => { b.state.health += 3; return `社区给${b.name}家配了一台护理机器人，帮着翻身、量血压。`; },
  },
];

/** 每件事在人身上记次数用的键：用短编号，快照每年都要整个序列化一次 */
const KEY = new Map(EVENTS.map((e, i) => [e, `e${i}`]));
/** 按人生阶段分好组，免得每次都把所有事过一遍 */
const BY_STAGE = new Map<LifeStage, LifeEvent[]>();
for (const e of EVENTS) for (const st of e.stages) BY_STAGE.set(st, [...(BY_STAGE.get(st) ?? []), e]);

/** 每个月调用一次：一定概率发生一件小事 */
export function lifeEvent(bot: Bot, ctx: EraContext): void {
  const v = bot.state.vars;
  if (ctx.tick - (v.lastEventTick ?? -99) < 7) return;
  const last = EVENTS[v.lastEvent ?? -1];
  const live: LifeEvent[] = [];
  const weights: number[] = [];
  for (const e of BY_STAGE.get(bot.stage) ?? []) {
    const n = v[KEY.get(e)!] ?? 0;
    if (n >= (e.max ?? 1) || e === last || (e.when && !e.when(bot, ctx))) continue;
    const w = (e.weight ? e.weight(bot, ctx) : 1) * (e.repeat ?? 0.3) ** n;
    if (w > 0) { live.push(e); weights.push(w); }
  }
  if (!live.length) return;
  // 挑哪件事、事情怎么发展，用这个人这个月专属的随机数：
  // 家里人变了只会改掉提到他们的那几句，不会把这个人往后的人生整个打乱
  const r = ctx.keyedRng(`life:${bot.id}:${ctx.tick}`);
  const ev = live[r.weighted(live.map((_, i) => i), (i) => weights[i])];
  const out = ev.run(bot, ctx, r);
  if (!out) return;
  v.lastEventTick = ctx.tick;
  v.lastEvent = EVENTS.indexOf(ev);
  v[KEY.get(ev)!] = (v[KEY.get(ev)!] ?? 0) + 1;
  const st = bot.state;
  st.happiness = clamp(st.happiness, 0, 100);
  st.health = clamp(st.health, 1, 100);
  for (const k of ['academic', 'social', 'business', 'craft'] as const) st.skills[k] = clamp(st.skills[k], 0, 100);
  const { text, related } = typeof out === 'string' ? { text: out, related: undefined } : out;
  ctx.log({ type: 'misc', botId: bot.id, relatedIds: related, importance: ev.importance, text });
}
