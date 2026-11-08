import type { EraPack } from '@lifegame/core';
import { chinaModern } from './china-modern/index.js';

export { chinaModern };
export const ERAS: Record<string, EraPack> = { [chinaModern.id]: chinaModern };
export function getEra(id: string): EraPack {
  const era = ERAS[id];
  if (!era) throw new Error(`未知时代 ${id}`);
  return era;
}
