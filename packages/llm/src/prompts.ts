import type { World } from '@lifegame/core';
import { stageName } from '@lifegame/core';
import { tickToYearMonth, type Bot, type DecisionNode, type LifeStage } from '@lifegame/schema';
import type { LlmMessage } from './provider.js';

function ctxOf(world: World) {
  return (world as unknown as { ctx: Parameters<World['era']['personaCard']>[1] }).ctx;
}

/** 近期重要记忆：按重要度与新近度取 n 条 */
export function recentMemories(world: World, bot: Bot, n = 10): string[] {
  const log = world.state.log;
  const startYear = world.state.config.startYear;
  const scored = bot.memory
    .filter((m) => log[m.eventSeq]?.type !== 'decision' || log[m.eventSeq]?.importance >= 7)
    .map((m) => ({ m, score: m.importance + (m.eventSeq / Math.max(1, log.length)) * 6 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .sort((a, b) => a.m.eventSeq - b.m.eventSeq);
  return scored.map(({ m }) => {
    const e = log[m.eventSeq];
    const { year } = tickToYearMonth(e.tick, startYear);
    const age = Math.floor((e.tick - bot.birthTick) / 12);
    return `${year}年（${age}岁）：${e.text}`;
  });
}

export function systemPrompt(world: World, bot: Bot): string {
  const era = world.era;
  const ctx = ctxOf(world);
  const lines = [
    `你正在扮演一个真实的人，用第一人称思考。你不是助手，不要解释，不要说教，不要跳出角色。`,
    `世界背景：${era.eraCard(ctx)}`,
    ``,
    `【你是谁】`,
    era.personaCard(bot, ctx),
  ];
  if (bot.reflections.length) {
    lines.push('', '【你对自己过去的总结】');
    for (const r of bot.reflections.slice(-3)) lines.push(`- ${stageName(r.stage)}：${r.text}`);
  }
  if (bot.goal) lines.push('', `【你当前的心愿】${bot.goal}`);
  return lines.join('\n');
}

/** 这个人最近说过的独白，用来避免意象重复 */
function recentMonologues(world: World, bot: Bot, n = 4): string[] {
  return Object.values(world.state.decisions)
    .filter((d) => d.botId === bot.id && d.monologue && d.resolvedBy === 'llm')
    .sort((a, b) => a.tick - b.tick)
    .slice(-n)
    .map((d) => d.monologue!);
}

export function decisionMessages(world: World, bot: Bot, node: DecisionNode): LlmMessage[] {
  const era = world.era;
  const ctx = ctxOf(world);
  const mem = recentMemories(world, bot);
  const said = recentMonologues(world, bot);
  const user = [
    `【现状】`,
    era.situationCard(bot, ctx),
    '',
    mem.length ? `【记忆中印象最深的事】\n${mem.map((m) => `- ${m}`).join('\n')}` : '',
    '',
    `【眼下的处境】`,
    node.situation,
    '',
    `【可选的路】`,
    ...node.options.map((o) => `- [${o.id}] ${o.label}：${o.description}`),
    '',
    `以这个人的性格、处境和过往，他/她会怎么选？不一定选最稳妥的，要像这个人。`,
    `独白里可以有细节和情绪，但不要编造上面没有提到的重大经历。全部用中文，不要夹杂英文。`,
    said.length ? `你最近说过的话：${said.map((m) => `「${m}」`).join(' ')}\n这次换个说法，不要再用其中出现过的意象、物件和比喻。` : '',
    `请只输出一个 JSON 对象，不要输出其他任何文字：`,
    `{"choice": "<选项 id，必须是上面方括号里的一个>", "monologue": "<一两句话的内心独白，口语化，带着这个人的性格、此刻的年龄和这个年代的气息，不超过 60 字>", "goal": "<可选。只有当这个选择改变了你接下来几年的打算时才写，一句话>"}`,
  ].filter((l) => l !== undefined).join('\n');
  return [
    { role: 'system', content: systemPrompt(world, bot) },
    { role: 'user', content: user },
  ];
}

/** 某个阶段对应的年龄区间 [from, to) */
function stageAgeRange(world: World, stage: LifeStage): [number, number] {
  let from = -1;
  let to = 130;
  for (let a = 0; a < 130; a++) {
    const st = world.era.stageOf(a);
    if (st === stage && from < 0) from = a;
    else if (st !== stage && from >= 0) { to = a; break; }
  }
  return [Math.max(0, from), to];
}

export function reflectionMessages(world: World, bot: Bot, endedStage: LifeStage): LlmMessage[] {
  const era = world.era;
  const ctx = ctxOf(world);
  const log = world.state.log;
  const startYear = world.state.config.startYear;
  // 只取这个阶段之内发生的事
  const [fromAge, toAge] = stageAgeRange(world, endedStage);
  const t0 = bot.birthTick + fromAge * 12;
  const t1 = bot.birthTick + toAge * 12;
  const stageEvents = bot.memory
    .map((m) => log[m.eventSeq])
    .filter((e) => e && e.importance >= 4 && e.tick >= t0 && e.tick < t1 && e.type !== 'stage')
    .slice(-30)
    .map((e) => {
      const { year } = tickToYearMonth(e.tick, startYear);
      const age = Math.floor((e.tick - bot.birthTick) / 12);
      return `- ${year}年（${age}岁）：${e.text}`;
    });
  const user = [
    `【现状】`,
    era.situationCard(bot, ctx),
    '',
    `【${stageName(endedStage)}里发生的事】`,
    ...stageEvents,
    '',
    stageEvents.length ? '' : '（这几年平平淡淡，没有什么大事。）',
    '',
    `${stageName(endedStage)}（${fromAge}到${toAge}岁）结束了。请以这个人的口吻，用两三句话回顾这个阶段：什么让你骄傲，什么让你遗憾，你变成了一个怎样的人。`,
    `要求：`,
    `- 只依据上面列出的事来回顾，不要虚构没有列出的重大经历，比如亲人去世、发财、做生意、离婚、搬家。可以补充日常细节和心里的感受。`,
    `- 不要重复你之前的总结里的句子、意象和比喻，这是新的一段人生。`,
    `- 不要套话，要有具体的人和事。全部用中文，不要夹杂英文。`,
    bot.goal ? `- 你之前的心愿是「${bot.goal}」。想想它实现了没有、还适不适合现在的你。` : '',
    `只输出 JSON：{"reflection": "<两三句话，不超过 120 字>", "goal": "<一句话，接下来这个人生阶段最想做成的事。要符合你现在${toAge}岁上下的年龄和处境，旧心愿实现了或不合适了就换一个新的>"}`,
  ].join('\n');
  return [
    { role: 'system', content: systemPrompt(world, bot) },
    { role: 'user', content: user },
  ];
}

export function portraitMessages(world: World, bot: Bot): LlmMessage[] {
  const era = world.era;
  const ctx = ctxOf(world);
  const user = [
    era.personaCard(bot, ctx),
    '',
    `请用一句话（不超过 40 字）给这个刚出生的孩子写一句"命运的旁白"，像小说开头那样，有画面、不煽情。`,
    `只输出 JSON：{"portrait": "<一句话>"}`,
  ].join('\n');
  return [
    { role: 'system', content: `你是一位克制、细腻的小说家，熟悉${era.name}的中国社会。` },
    { role: 'user', content: user },
  ];
}
