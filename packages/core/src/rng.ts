/** xoshiro128**：状态 4 个 uint32，可序列化，保证同种子同序列 */
export class Rng {
  private s: Uint32Array;

  constructor(state: number[] | number) {
    if (typeof state === 'number') {
      this.s = Rng.seedState(state);
    } else {
      this.s = Uint32Array.from(state);
    }
  }

  static seedState(seed: number): Uint32Array {
    // splitmix32 扩展种子
    let a = seed >>> 0;
    const out = new Uint32Array(4);
    for (let i = 0; i < 4; i++) {
      a = (a + 0x9e3779b9) >>> 0;
      let z = a;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
      out[i] = (z ^ (z >>> 16)) >>> 0;
    }
    if (out.every((v) => v === 0)) out[0] = 1;
    return out;
  }

  getState(): number[] {
    return Array.from(this.s);
  }

  /** [0,1) */
  next(): number {
    const s = this.s;
    const result = (Math.imul(rotl(Math.imul(s[1], 5) >>> 0, 7), 9) >>> 0);
    const t = (s[1] << 9) >>> 0;
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = rotl(s[3], 11);
    return result / 4294967296;
  }

  /** [min,max] 整数 */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** [min,max) 浮点 */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** 标准正态，Box-Muller */
  gauss(mean = 0, sd = 1): number {
    let u = 0;
    let v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** 截断到 [lo,hi] 的正态 */
  gaussClamped(mean: number, sd: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, this.gauss(mean, sd)));
  }

  weighted<T>(items: readonly T[], weightOf: (item: T) => number): T {
    let total = 0;
    const ws = items.map((it) => {
      const w = Math.max(0, weightOf(it));
      total += w;
      return w;
    });
    if (total <= 0) return this.pick(items);
    let r = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      r -= ws[i];
      if (r < 0) return items[i];
    }
    return items[items.length - 1];
  }

  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
