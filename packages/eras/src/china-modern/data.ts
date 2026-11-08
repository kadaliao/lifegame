import type { Region } from '@lifegame/schema';

export interface Place { name: string; region: Region; province: string }

export const PLACES: Place[] = [
  { name: '北京', region: 'metro', province: '北京' },
  { name: '上海', region: 'metro', province: '上海' },
  { name: '广州', region: 'metro', province: '广东' },
  { name: '深圳', region: 'metro', province: '广东' },
  { name: '成都', region: 'city', province: '四川' },
  { name: '武汉', region: 'city', province: '湖北' },
  { name: '西安', region: 'city', province: '陕西' },
  { name: '杭州', region: 'city', province: '浙江' },
  { name: '南京', region: 'city', province: '江苏' },
  { name: '长沙', region: 'city', province: '湖南' },
  { name: '郑州', region: 'city', province: '河南' },
  { name: '沈阳', region: 'city', province: '辽宁' },
  { name: '合肥', region: 'city', province: '安徽' },
  { name: '昆明', region: 'city', province: '云南' },
  { name: '衡阳', region: 'town', province: '湖南' },
  { name: '周口', region: 'town', province: '河南' },
  { name: '六安', region: 'town', province: '安徽' },
  { name: '宜宾', region: 'town', province: '四川' },
  { name: '赣州', region: 'town', province: '江西' },
  { name: '菏泽', region: 'town', province: '山东' },
  { name: '邵阳', region: 'town', province: '湖南' },
  { name: '铁岭', region: 'town', province: '辽宁' },
  { name: '河南周口某村', region: 'rural', province: '河南' },
  { name: '四川达州某村', region: 'rural', province: '四川' },
  { name: '安徽阜阳某村', region: 'rural', province: '安徽' },
  { name: '湖南邵阳某村', region: 'rural', province: '湖南' },
  { name: '贵州毕节某村', region: 'rural', province: '贵州' },
  { name: '甘肃定西某村', region: 'rural', province: '甘肃' },
  { name: '江西赣州某村', region: 'rural', province: '江西' },
  { name: '山东菏泽某村', region: 'rural', province: '山东' },
  { name: '广西河池某村', region: 'rural', province: '广西' },
  { name: '河北邢台某村', region: 'rural', province: '河北' },
];

export const REGION_NAME: Record<Region, string> = { rural: '农村', town: '县城', city: '城市', metro: '一线城市' };

export const PARENT_JOBS: Record<Region, string[]> = {
  rural: ['农民', '农民', '农民', '乡村教师', '赤脚医生', '木匠', '村干部', '外出打工'],
  town: ['工人', '供销社职员', '小学教师', '个体户', '司机', '粮站职工', '县医院护士', '干部'],
  city: ['国企工人', '中学教师', '医生', '机关干部', '工程师', '会计', '售货员', '军人'],
  metro: ['大学教师', '机关干部', '研究员', '外贸职员', '医生', '工程师', '演员', '国企干部'],
};

export interface JobDef {
  id: string;
  title: string;
  sector: string;
  /** 1980 年基准月薪（元） */
  base: number;
  /** 可用年份区间 */
  from?: number;
  to?: number;
  /** 最低学历 */
  minEdu: number; // 0 none ... 7 phd，见 EDU_RANK
  /** 偏好专业 */
  majors?: string[];
  /** 适合地区 */
  regions?: Region[];
  /** 社会地位 0-100 */
  prestige: number;
  stress: number;
}

export const EDU_RANK: Record<string, number> = {
  none: 0, primary: 1, junior: 2, vocational: 3, senior: 3, college: 4, bachelor: 5, master: 6, phd: 7,
};

export const JOBS: JobDef[] = [
  { id: 'farmer', title: '农民', sector: '农业', base: 25, minEdu: 0, regions: ['rural'], prestige: 15, stress: 30 },
  { id: 'migrant', title: '进城务工', sector: '建筑/制造', base: 45, minEdu: 0, from: 1985, regions: ['city', 'metro'], prestige: 20, stress: 55 },
  { id: 'factory', title: '工厂工人', sector: '制造业', base: 50, minEdu: 1, prestige: 30, stress: 45 },
  { id: 'waiter', title: '服务员', sector: '服务业', base: 40, minEdu: 1, from: 1990, prestige: 20, stress: 40 },
  { id: 'driver', title: '司机', sector: '交通', base: 60, minEdu: 2, prestige: 30, stress: 45 },
  { id: 'rider', title: '外卖骑手', sector: '平台经济', base: 95, minEdu: 1, from: 2015, regions: ['town', 'city', 'metro'], prestige: 20, stress: 60 },
  { id: 'shop', title: '个体户', sector: '商业', base: 70, minEdu: 1, from: 1984, prestige: 35, stress: 50 },
  { id: 'sales', title: '销售', sector: '商业', base: 75, minEdu: 3, from: 1992, prestige: 35, stress: 60 },
  { id: 'clerk', title: '文员', sector: '企业行政', base: 55, minEdu: 4, prestige: 35, stress: 35 },
  { id: 'teacher', title: '教师', sector: '教育', base: 60, minEdu: 4, majors: ['师范', '文科'], prestige: 60, stress: 45 },
  { id: 'nurse', title: '护士', sector: '医疗', base: 58, minEdu: 3, majors: ['医学'], prestige: 45, stress: 60 },
  { id: 'doctor', title: '医生', sector: '医疗', base: 75, minEdu: 5, majors: ['医学'], prestige: 75, stress: 65 },
  { id: 'civil', title: '公务员', sector: '体制内', base: 65, minEdu: 4, prestige: 70, stress: 30 },
  { id: 'soe', title: '国企职员', sector: '国企', base: 65, minEdu: 4, prestige: 55, stress: 30 },
  { id: 'engineer', title: '工程师', sector: '工业', base: 80, minEdu: 5, majors: ['工科'], prestige: 60, stress: 50 },
  { id: 'accountant', title: '会计', sector: '财务', base: 65, minEdu: 4, majors: ['金融', '文科'], prestige: 45, stress: 40 },
  { id: 'finance', title: '金融从业者', sector: '金融', base: 140, minEdu: 5, from: 1992, majors: ['金融'], regions: ['city', 'metro'], prestige: 70, stress: 70 },
  { id: 'programmer', title: '程序员', sector: '互联网', base: 150, minEdu: 5, from: 1996, majors: ['计算机', '工科'], regions: ['city', 'metro'], prestige: 55, stress: 70 },
  { id: 'pm', title: '产品经理', sector: '互联网', base: 130, minEdu: 5, from: 2008, regions: ['city', 'metro'], prestige: 50, stress: 70 },
  { id: 'media', title: '媒体/新媒体', sector: '文化传媒', base: 70, minEdu: 5, majors: ['文科', '艺术'], from: 1992, prestige: 45, stress: 55 },
  { id: 'designer', title: '设计师', sector: '文化传媒', base: 85, minEdu: 4, majors: ['艺术'], from: 1995, prestige: 45, stress: 55 },
  { id: 'lawyer', title: '律师', sector: '法律', base: 120, minEdu: 5, majors: ['文科'], from: 1990, regions: ['city', 'metro'], prestige: 70, stress: 65 },
  { id: 'researcher', title: '科研人员', sector: '科研', base: 75, minEdu: 6, prestige: 70, stress: 45 },
  { id: 'professor', title: '大学教师', sector: '教育', base: 85, minEdu: 7, prestige: 80, stress: 45 },
  { id: 'founder', title: '创业者', sector: '创业', base: 60, minEdu: 2, from: 1992, prestige: 50, stress: 85 },
  { id: 'soldier', title: '军人', sector: '军队', base: 55, minEdu: 2, prestige: 60, stress: 50 },
  { id: 'streamer', title: '主播', sector: '平台经济', base: 110, minEdu: 2, from: 2016, prestige: 30, stress: 55 },
  { id: 'ai', title: 'AI 工程师', sector: '人工智能', base: 230, minEdu: 6, from: 2024, majors: ['计算机', '工科'], regions: ['city', 'metro'], prestige: 75, stress: 70 },
  { id: 'carer', title: '养老护理员', sector: '养老', base: 75, minEdu: 1, from: 2025, prestige: 25, stress: 55 },
];

/**
 * 各职业随年代的兴衰：[年份, 需求, 工资]，年份之间线性插值，两端外推取端点值。
 * 需求影响找到这份工作的机会和被裁的风险；工资是相对"全国工资指数"的倍数。
 * 2026 年以后的部分是推演：AI 接手写代码、做设计、记账、写稿；机器人进工厂；无人车上路；老龄化让护理最缺人。
 */
const JOB_TRENDS: Record<string, Array<[number, number, number]>> = {
  programmer: [[1996, 0.7, 1.0], [2000, 1.1, 1.15], [2010, 1.4, 1.3], [2018, 1.3, 1.35], [2022, 0.9, 1.15], [2026, 0.6, 0.95], [2030, 0.22, 0.7], [2040, 0.12, 0.6]],
  pm: [[2008, 1.0, 1.0], [2015, 1.3, 1.2], [2022, 0.8, 1.05], [2026, 0.6, 0.9], [2030, 0.25, 0.75], [2040, 0.2, 0.7]],
  clerk: [[2020, 1.0, 1.0], [2026, 0.8, 0.95], [2032, 0.35, 0.8], [2045, 0.25, 0.75]],
  accountant: [[2020, 1.0, 1.0], [2026, 0.85, 0.95], [2032, 0.4, 0.8], [2045, 0.3, 0.75]],
  designer: [[2020, 1.0, 1.0], [2026, 0.75, 0.9], [2032, 0.4, 0.75], [2045, 0.35, 0.7]],
  media: [[2020, 1.0, 1.0], [2026, 0.75, 0.9], [2032, 0.45, 0.8], [2045, 0.4, 0.75]],
  finance: [[1992, 1.0, 1.0], [2016, 1.2, 1.1], [2022, 0.9, 1.0], [2030, 0.6, 0.9], [2045, 0.5, 0.85]],
  lawyer: [[2026, 1.0, 1.0], [2035, 0.7, 0.9], [2050, 0.6, 0.85]],
  sales: [[2030, 1.0, 1.0], [2040, 0.8, 0.95]],
  factory: [[1980, 1.0, 1.0], [2001, 1.4, 1.0], [2008, 1.4, 1.0], [2009, 0.9, 1.0], [2015, 0.9, 1.05], [2025, 0.7, 1.05], [2040, 0.45, 1.0], [2060, 0.35, 1.0]],
  migrant: [[1985, 1.0, 1.0], [2001, 1.4, 1.0], [2015, 1.0, 1.05], [2025, 0.8, 1.05], [2040, 0.6, 1.0]],
  soe: [[1996, 1.0, 1.0], [1997, 0.4, 0.85], [2001, 0.4, 0.85], [2003, 1.0, 1.0]],
  teacher: [[2018, 1.0, 1.0], [2025, 0.85, 1.0], [2035, 0.6, 1.0], [2050, 0.5, 1.0]],
  nurse: [[2020, 1.0, 1.0], [2030, 1.4, 1.15], [2045, 1.6, 1.25]],
  doctor: [[2025, 1.0, 1.0], [2035, 1.2, 1.1]],
  rider: [[2015, 1.2, 1.0], [2022, 1.2, 0.9], [2030, 0.7, 0.85], [2040, 0.35, 0.8]],
  driver: [[2025, 1.0, 1.0], [2032, 0.6, 0.9], [2045, 0.3, 0.8]],
  ai: [[2024, 0.6, 1.0], [2028, 1.0, 1.1], [2035, 0.9, 1.0], [2050, 0.7, 0.9]],
  carer: [[2025, 0.8, 1.0], [2030, 1.5, 1.15], [2045, 1.8, 1.3]],
};

export function jobTrend(jobId: string, year: number): { demand: number; pay: number } {
  const pts = JOB_TRENDS[jobId];
  if (!pts) return { demand: 1, pay: 1 };
  if (year <= pts[0][0]) return { demand: pts[0][1], pay: pts[0][2] };
  for (let i = 1; i < pts.length; i++) {
    if (year <= pts[i][0]) {
      const [y0, d0, p0] = pts[i - 1];
      const [y1, d1, p1] = pts[i];
      const k = (year - y0) / (y1 - y0);
      return { demand: d0 + (d1 - d0) * k, pay: p0 + (p1 - p0) * k };
    }
  }
  const last = pts[pts.length - 1];
  return { demand: last[1], pay: last[2] };
}

/** 这一行为什么在萎缩（用于失业的叙述） */
export function declineReason(jobId: string, year: number): string | undefined {
  if (year >= 2026 && ['programmer', 'pm', 'clerk', 'accountant', 'designer', 'media', 'finance', 'lawyer'].includes(jobId)) return 'AI 接手了这份工作的大部分活';
  if (year >= 2025 && (jobId === 'factory' || jobId === 'migrant')) return '厂里换上了机器人';
  if (year >= 2030 && (jobId === 'driver' || jobId === 'rider')) return '无人车接走了大部分单子';
  if (year >= 2025 && jobId === 'teacher') return '生源越来越少，学校在并班';
  return undefined;
}

export const MAJORS = ['计算机', '金融', '医学', '师范', '工科', '文科', '艺术'] as const;
export type Major = (typeof MAJORS)[number];

/** 各专业热度随年份变化（权重倍数） */
export function majorHeat(major: Major, year: number): number {
  switch (major) {
    case '计算机': return year < 1998 ? 0.4 : year < 2010 ? 1.2 : year < 2024 ? 2.2 : year < 2030 ? 1.2 : 0.7;
    case '金融': return year < 1995 ? 0.5 : year < 2016 ? 1.8 : year < 2026 ? 1.2 : 0.8;
    case '医学': return year < 2025 ? 1.0 : 1.6;
    case '师范': return year < 2000 ? 1.3 : year < 2018 ? 0.7 : 1.3;
    case '工科': return 1.4;
    case '文科': return 1.0;
    case '艺术': return year < 2000 ? 0.4 : 0.8;
  }
}

/** 名义工资指数，1980 = 1 */
export function wageIndex(year: number): number {
  let idx = 1;
  for (let y = 1981; y <= year; y++) {
    const g = y <= 1990 ? 0.12 : y <= 2010 ? 0.13 : y <= 2020 ? 0.08 : y <= 2035 ? 0.045 : 0.03;
    idx *= 1 + g;
  }
  return idx;
}

/** 房价 元/平米，按地区与年份线性插值 */
const HOUSE_PRICE: Record<Region, Array<[number, number]>> = {
  metro: [[1980, 0], [1998, 3500], [2003, 5000], [2008, 14000], [2012, 25000], [2016, 50000], [2021, 65000], [2024, 58000], [2035, 60000], [2060, 70000]],
  city: [[1980, 0], [1998, 1500], [2003, 2500], [2008, 6000], [2012, 9000], [2016, 13000], [2021, 20000], [2024, 17000], [2035, 18000], [2060, 20000]],
  town: [[1980, 0], [1998, 600], [2003, 1000], [2008, 2200], [2012, 3500], [2016, 5000], [2021, 7500], [2024, 6500], [2035, 6500], [2060, 7000]],
  rural: [[1980, 0], [1998, 200], [2008, 500], [2016, 1000], [2021, 1500], [2060, 2000]],
};

export function housePrice(region: Region, year: number): number {
  const pts = HOUSE_PRICE[region];
  if (year <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (year <= pts[i][0]) {
      const [y0, p0] = pts[i - 1];
      const [y1, p1] = pts[i];
      return p0 + ((p1 - p0) * (year - y0)) / (y1 - y0);
    }
  }
  return pts[pts.length - 1][1];
}

/** 每月基本生活开销（1980 元基准，乘工资指数） */
export const LIVING_COST: Record<Region, number> = { rural: 12, town: 20, city: 30, metro: 45 };

export interface TimelineEvent {
  year: number;
  id: string;
  title: string;
  text: string;
  /** 影响持续年数 */
  duration?: number;
  speculative?: boolean;
}

export const TIMELINE: TimelineEvent[] = [
  { year: 1980, id: 'reform', title: '改革开放初期', text: '包产到户在农村铺开，个体经济刚刚松绑，大学生是天之骄子。' },
  { year: 1984, id: 'city-reform', title: '城市经济体制改革', text: '国企改革启动，第一批个体户和乡镇企业冒头，"万元户"成为新词。' },
  { year: 1989, id: 'inflation', title: '物价闯关与治理整顿', text: '通胀高企，抢购潮过后经济收紧，就业机会减少。', duration: 2 },
  { year: 1992, id: 'southern-tour', title: '南方谈话，下海潮', text: '市场经济方向确立，大批干部和知识分子辞职下海，深圳速度成为传奇。', duration: 4 },
  { year: 1997, id: 'laid-off', title: '国企下岗潮', text: '国企改革进入深水区，数千万工人下岗，"从头再来"唱遍全国。', duration: 4 },
  { year: 1998, id: 'housing-reform', title: '住房商品化', text: '福利分房终结，商品房市场启动，房子从单位分配变成要自己买。' },
  { year: 1999, id: 'expansion', title: '高校扩招', text: '大学录取人数大幅增加，上大学更容易，但文凭含金量开始稀释。' },
  { year: 2001, id: 'wto', title: '加入 WTO', text: '世界工厂全速运转，沿海制造业用工需求爆发，进城务工成为潮流。', duration: 7 },
  { year: 2003, id: 'sars', title: '非典', text: '疫情肆虐数月，城市停摆，医护人员走上前线。' },
  { year: 2008, id: 'crisis', title: '金融危机与四万亿', text: '出口订单骤减，沿海工厂倒闭潮；随后大规模刺激，基建与房地产狂飙。', duration: 3 },
  { year: 2010, id: 'mobile', title: '移动互联网元年', text: '智能手机普及，互联网公司高薪抢人，程序员成为高收入职业。', duration: 8 },
  { year: 2015, id: 'stock-crash', title: '股灾与双创', text: '股市暴涨暴跌，"大众创业、万众创新"口号下创业公司遍地开花。', duration: 3 },
  { year: 2016, id: 'two-child', title: '全面二孩', text: '独生子女政策终结，允许生育两个孩子；同年一二线房价暴涨。' },
  { year: 2018, id: 'trade-war', title: '中美贸易摩擦', text: '出口企业承压，互联网红利见顶，"内卷"开始流行。', duration: 3 },
  { year: 2020, id: 'covid', title: '新冠疫情', text: '封控、核酸、远程办公成为日常，服务业与小企业受创最重。', duration: 3 },
  { year: 2021, id: 'double-reduction', title: '双减与三孩', text: '校外培训行业一夜归零，互联网大厂开始裁员，35 岁成为职场隐形门槛；同年放开三孩。', duration: 3 },
  { year: 2023, id: 'post-covid', title: '疫情后复苏乏力', text: '青年失业率高企，考公考编人数创纪录，房价开始下行。', duration: 3 },
  { year: 2026, id: 'ai-wave', title: 'AI 浪潮', text: 'AI 能写代码、做设计、记账、写稿，程序员、文员、会计、设计师的岗位大量消失，留下的工资也在跌；只有极少数做 AI 的人收入暴涨。', duration: 10, speculative: true },
  { year: 2030, id: 'aging', title: '深度老龄化', text: '60 岁以上人口超过三成，延迟退休全面落地，养老成为家庭核心议题，护士和养老护理员成了最缺人的行业。', duration: 30, speculative: true },
  { year: 2032, id: 'driverless', title: '无人驾驶普及', text: '无人车和无人配送铺开，司机和外卖骑手的单子越来越少。', duration: 15, speculative: true },
  { year: 2040, id: 'silver', title: '银发经济时代', text: '机器人护理与社区养老普及，年轻劳动力稀缺，工资持续上涨。', duration: 20, speculative: true },
];

export function money(n: number): string {
  if (Math.abs(n) >= 1e8) return `${(n / 1e8).toFixed(1)}亿元`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e4).toFixed(1)}万元`;
  return `${Math.round(n)}元`;
}
