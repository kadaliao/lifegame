import type { Bot } from '@lifegame/schema';

/** 发给界面的精简 bot 信息 */
export interface BotSummary {
  id: string;
  name: string;
  sex: Bot['sex'];
  birthTick: number;
  deathTick?: number;
  familyId: string;
  parentIds: string[];
  spouseId?: string;
  childrenIds: string[];
  generation: number;
  stage: Bot['stage'];
  health: number;
  happiness: number;
  wealth: number;
  education: Bot['state']['education'];
  jobTitle?: string;
  city: string;
  ses: number;
  region: Bot['origin']['region'];
  intelligence: Bot['intelligence'];
  model?: string;
  lead?: boolean;
  portrait?: string;
}

export function summarize(b: Bot): BotSummary {
  return {
    id: b.id, name: b.name, sex: b.sex, birthTick: b.birthTick, deathTick: b.deathTick,
    familyId: b.familyId, parentIds: b.parentIds, spouseId: b.spouseId, childrenIds: b.childrenIds,
    generation: b.generation, stage: b.stage,
    health: Math.round(b.state.health), happiness: Math.round(b.state.happiness), wealth: Math.round(b.state.wealth),
    education: b.state.education, jobTitle: b.state.job?.title, city: b.state.city,
    ses: b.origin.ses, region: b.origin.region, intelligence: b.intelligence, model: b.model, lead: b.lead, portrait: b.portrait,
  };
}
