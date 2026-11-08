import type { BotSummary } from '@lifegame/core';

export function eduLabel(e: BotSummary['education']): string {
  return { none: '未上学', primary: '小学', junior: '初中', vocational: '职校', senior: '高中', college: '大专', bachelor: '本科', master: '硕士', phd: '博士' }[e];
}
