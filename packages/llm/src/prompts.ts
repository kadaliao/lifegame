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

export function decisionMessages(world: World, bot: Bot, node: DecisionNode): LlmMessage[] {
  const era = world.era;
  const ctx = ctxOf(world);
  const mem = recentMemories(world, bot);
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
    `以这个人的性格、处境和过往，他/她会怎么选？请只输出一个 JSON 对象，不要输出其他任何文字：`,
    `{"choice": "<选项 id，必须是上面方括号里的一个>", "monologue": "<一两句话的内心独白，口语化，带着这个人的性格和这个年代的气息，不超过 60 字>", "goal": "<可选，一句话写下接下来几年最想做成的事>"}`,
  ].filter((l) => l !== undefined).join('\n');
  return [
    { role: 'system', content: systemPrompt(world, bot) },
    { role: 'user', content: user },
  ];
}

export function reflectionMessages(world: World, bot: Bot, endedStage: LifeStage): LlmMessage[] {
  const era = world.era;
  const ctx = ctxOf(world);
  const log = world.state.log;
  const startYear = world.state.config.startYear;
  // 本阶段内的全部重要事件
  const stageEvents = bot.memory
    .map((m) => log[m.eventSeq])
    .filter((e) => e && e.importance >= 4)
    .slice(-25)
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
    `${stageName(endedStage)}结束了。请以这个人的口吻，用两三句话回顾这个阶段：什么让你骄傲，什么让你遗憾，你变成了一个怎样的人。不要总结式的套话，要有具体的人和事。`,
    `只输出 JSON：{"reflection": "<两三句话，不超过 120 字>", "goal": "<一句话，下一阶段最想做成的事>"}`,
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
