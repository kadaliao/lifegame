import { Container, Text, type TextStyle } from 'pixi.js';
import type { LifeStage } from '@lifegame/schema';

export const STAGES: LifeStage[] = ['infant', 'child', 'teen', 'youth', 'adult', 'middle', 'senior'];
export const STAGE_COLOR: Record<LifeStage, number> = {
  infant: 0xdccbab, child: 0x9cc08f, teen: 0x5fa8a0, youth: 0x4f7fbf, adult: 0x7466b8, middle: 0xc98a3d, senior: 0x9a8f83,
};
export const STAGE_LABEL: Record<LifeStage, string> = {
  infant: '婴幼', child: '童年', teen: '少年', youth: '青年', adult: '成年', middle: '中年', senior: '老年',
};
/** 出身阶层 1~5，暖到冷 */
export const SES_COLOR = [0xb5523b, 0xd08b45, 0x9aa36b, 0x4f8a8b, 0x3d5a80];
export const SES_LABEL = ['赤贫', '贫寒', '普通', '小康', '富裕'];

export const hex = (s: string): number => parseInt(s.replace('#', ''), 16);
export const css = (n: number): string => `#${n.toString(16).padStart(6, '0')}`;
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** 年龄 → 阶段序号 的查表 */
export function stageTable(stageOf: (age: number) => LifeStage): Uint8Array {
  const t = new Uint8Array(131);
  for (let a = 0; a <= 130; a++) t[a] = STAGES.indexOf(stageOf(a));
  return t;
}

/** 每个阶段开始的年龄 */
export function stageStarts(table: Uint8Array): Array<{ si: number; age: number }> {
  const out: Array<{ si: number; age: number }> = [{ si: table[0], age: 0 }];
  for (let a = 1; a < table.length; a++) if (table[a] !== table[a - 1]) out.push({ si: table[a], age: a });
  return out;
}

export function hashId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** 复用 Text 对象，避免每帧新建 */
export class TextPool {
  private items = new Map<string, Text>();
  private used = new Set<string>();
  constructor(private parent: Container) {}

  begin(): void {
    this.used.clear();
  }

  get(key: string, text: string, style: TextStyle): Text {
    let t = this.items.get(key);
    if (!t) {
      t = new Text({ text, style });
      this.items.set(key, t);
      this.parent.addChild(t);
    } else {
      if (t.text !== text) t.text = text;
      if (t.style !== style) t.style = style;
    }
    t.visible = true;
    t.alpha = 1;
    t.rotation = 0;
    this.used.add(key);
    return t;
  }

  end(): void {
    for (const [k, t] of this.items) if (!this.used.has(k)) t.visible = false;
    if (this.items.size > 1500) {
      for (const [k, t] of this.items) {
        if (!this.used.has(k)) { t.destroy(); this.items.delete(k); }
      }
    }
  }
}
