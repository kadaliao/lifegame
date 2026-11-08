import { describe, expect, it } from 'vitest';
import type { DecisionNode } from '@lifegame/schema';
import { World } from './engine.js';
import { chinaModern } from '../../eras/src/index.js';

const cfg = { seed: 7, eraId: 'china-modern', population: 60, startYear: 1980, endYear: 2040, birthSpan: 10 };

/** 驱动层：把所有还没答案的决策答掉 */
function answerAll(w: World, pick: (d: DecisionNode) => string, by: 'user' | 'llm' = 'llm', onEach?: (d: DecisionNode) => void) {
  for (const d of w.pending) {
    onEach?.(d);
    w.resolveDecision(d.id, pick(d), by, by === 'llm' ? 'm' : undefined);
  }
}

function runAll(w: World, pick: (d: DecisionNode) => string = (d) => d.options[0].id, onEach?: (d: DecisionNode) => void) {
  let guard = 0;
  while (!w.finished && guard++ < 10_000) {
    w.step();
    answerAll(w, pick, 'llm', onEach);
  }
}

/** 挑一个能活到要拿主意的年纪的人当主角：同样的种子先按规则跑一遍（第一个决定之前的人生与智能设定无关） */
function survivor(c = cfg): string {
  const w = World.create(chinaModern, c);
  runAll(w);
  const decided = new Set(Object.values(w.state.decisions).filter((d) => d.options.length > 1).map((d) => d.botId));
  return w.state.botOrder.find((id) => w.state.bots[id].generation === 0 && decided.has(id))!;
}

describe('World', () => {
  it('同种子两次运行事件日志完全一致', () => {
    const a = World.create(chinaModern, cfg);
    const b = World.create(chinaModern, cfg);
    runAll(a);
    runAll(b);
    expect(a.state.log.length).toBeGreaterThan(1000);
    expect(JSON.stringify(a.state.log)).toBe(JSON.stringify(b.state.log));
  });

  it('不同种子得到不同世界', () => {
    const a = World.create(chinaModern, cfg);
    const b = World.create(chinaModern, { ...cfg, seed: 8 });
    runAll(a);
    runAll(b);
    expect(JSON.stringify(a.state.log)).not.toBe(JSON.stringify(b.state.log));
  });

  it('犹豫期里世界照常前进，到期还没答案才停下', () => {
    const w = World.create(chinaModern, cfg);
    const hero = survivor();
    w.setIntelligence(hero, 'llm');
    let first: DecisionNode | undefined;
    while (!first && !w.finished) {
      const r = w.step();
      first = r.pending[0];
    }
    expect(first).toBeDefined();
    expect(first!.botId).toBe(hero);
    expect(first!.dueTick).toBeGreaterThan(first!.tick);
    // 不答复也能前进到到期之前
    while (w.tick < first!.dueTick) expect(w.step().blocked).toHaveLength(0);
    // 到期了：停住，tick 不变
    const before = w.tick;
    const r = w.step();
    expect(r.blocked.map((n) => n.id)).toContain(first!.id);
    expect(w.tick).toBe(before);
    // 答复后继续，并在到期时落地
    w.resolveDecision(first!.id, first!.options[first!.options.length - 1].id, 'llm', '想好了');
    w.step();
    expect(w.tick).toBe(before + 1);
    expect(w.state.decisions[first!.id].applied).toBe(true);
    expect(w.state.log.some((e) => e.decisionId === first!.id)).toBe(true);
  });

  it('答复的快慢不影响结果：同样的答案得到同样的世界', () => {
    const run = (eager: boolean) => {
      const w = World.create(chinaModern, cfg);
      for (const id of w.state.botOrder.slice(0, 5)) w.setIntelligence(id, 'llm');
      let guard = 0;
      while (!w.finished && guard++ < 10_000) {
        const r = w.step();
        // eager：一出现就答；lazy：拖到被挡住才答
        if (eager || r.blocked.length) answerAll(w, (d) => d.options[d.options.length - 1].id);
      }
      return JSON.stringify(w.state.log);
    };
    expect(run(true)).toBe(run(false));
  });

  it('分叉：改选一个决策后，分叉前的历史一致，之后分歧，原分支不受影响', () => {
    const w = World.create(chinaModern, cfg);
    const hero = survivor();
    w.setIntelligence(hero, 'llm');
    const asked: string[] = [];
    runAll(w, (d) => d.options[0].id, (d) => asked.push(d.id));
    const before = JSON.stringify(w.state.log);
    const target = asked.map((id) => w.state.decisions[id]).find((d) => d.options.length > 1)!;
    const alt = target.options[1].id;
    const child = w.fork(target.id, alt, 'alt');
    expect(JSON.stringify(w.state.log)).toBe(before);
    expect(child.state.decisions[target.id].chosen).toBe(alt);
    expect(child.state.decisions[target.id].resolvedBy).toBe('user');
    // 改选落地之前的日志一致
    const prefixLen = w.state.log.findIndex((e) => e.decisionId === target.id);
    expect(prefixLen).toBeGreaterThan(0);
    runAll(child);
    const pa = w.state.log.slice(0, prefixLen).map((e) => e.text).join('|');
    const pb = child.state.log.slice(0, prefixLen).map((e) => e.text).join('|');
    expect(pb).toBe(pa);
    expect(JSON.stringify(child.state.log)).not.toBe(before);
    expect(child.state.branchId).toBe('alt');
    expect(child.state.parentBranchId).toBe('main');
  });

  it('回退：画面之前的历史原样保留，被改设定的人之后重新做决定', () => {
    const w = World.create(chinaModern, { ...cfg, population: 120 });
    runAll(w);
    // 挑一个 2000 年之后才有决策的人，在 2000 年给他赋予智能
    const at = (2000 - 1980) * 12;
    const later = Object.values(w.state.decisions).filter((d) => d.tick >= at + 12);
    const botId = later[0].botId;
    const r = w.rewind(at, botId);
    r.setIntelligence(botId, 'llm');
    const asked: DecisionNode[] = [];
    runAll(r, (d) => d.options[0].id, (d) => asked.push(d));
    expect(asked.some((d) => d.botId === botId && d.tick >= at)).toBe(true);
    expect(asked.every((d) => d.botId === botId)).toBe(true);
    // 回退点之前的日志一致
    const cut = w.state.log.findIndex((e) => e.tick >= at);
    expect(r.state.log.slice(0, cut).map((e) => e.text)).toEqual(w.state.log.slice(0, cut).map((e) => e.text));
  });

  it('序列化后恢复可继续运行且结果一致', () => {
    const a = World.create(chinaModern, cfg);
    a.run(200);
    const json = a.toJSON();
    const b = World.fromJSON(chinaModern, json);
    runAll(a);
    runAll(b);
    expect(JSON.stringify(a.state.log)).toBe(JSON.stringify(b.state.log));
  });

  it('每个决策都随机选，冷门路径也不崩溃', () => {
    for (const seed of [1, 2, 3, 4]) {
      const w = World.create(chinaModern, { ...cfg, seed, population: 200, endYear: 2060 });
      for (const id of w.state.botOrder.slice(0, 60)) w.setIntelligence(id, 'llm');
      let n = 0;
      runAll(w, (d) => d.options[(seed * 7919 + n++) % d.options.length].id);
      expect(w.state.log.length).toBeGreaterThan(500);
    }
  }, 30_000);

  it('局部性：改选一个人的决定，无关的人生大多逐字不变', () => {
    const w = World.create(chinaModern, { ...cfg, population: 150 });
    for (const id of w.state.botOrder.slice(0, 10)) w.setIntelligence(id, 'llm');
    const asked: DecisionNode[] = [];
    runAll(w, (d) => d.options[0].id, (d) => asked.push(d));
    const target = asked.find((d) => d.options.length > 1)!;
    const hero = target.botId;
    const child = w.fork(target.id, target.options[1].id, 'alt');
    runAll(child);
    const lifeOf = (x: World, id: string) => x.state.log.filter((e) => e.botId === id).map((e) => e.text).join('|');
    const others = w.state.botOrder.filter((id) => id !== hero && w.state.bots[id].generation === 0);
    const same = others.filter((id) => lifeOf(w, id) === lifeOf(child, id)).length;
    expect(lifeOf(w, hero)).not.toBe(lifeOf(child, hero));
    expect(same / others.length).toBeGreaterThan(0.85);
  });

  it('投胎：新分支里多出这个人，退回点之前的历史不变，重放与存档都能还原', () => {
    const w = World.create(chinaModern, { ...cfg, population: 80 });
    w.setFlags({ inherit: true });
    for (const id of w.state.botOrder.slice(0, 3)) w.setIntelligence(id, 'llm');
    runAll(w);
    const spec = { name: '林小满', sex: 'female' as const, region: 'rural' as const, hometown: '甘肃定西某村', ses: 1, bio: '母亲早逝，跟着奶奶长大，喜欢画画。', intelligence: 'llm' as const, model: 'mock/mock', personality: { openness: 90, neuroticism: 20 } };
    const at = (1990 - 1980) * 12;
    const { world: b, botId } = w.withBirth(spec, at + 3, at, 'reborn');
    const before = (x: World) => x.state.log.filter((e) => e.tick < at).map((e) => e.text);
    expect(before(b)).toEqual(before(w));
    runAll(b);
    const kid = b.bot(botId)!;
    expect(kid.name).toBe('林小满');
    expect(kid.origin.hometown).toBe('甘肃定西某村');
    expect(kid.personality.openness).toBe(90);
    expect(kid.intelligence).toBe('llm');
    expect(kid.lead).toBe(true);
    expect(kid.birthTick).toBe(at + 3);
    expect(b.state.log.some((e) => e.botId === botId && e.type === 'decision')).toBe(true);
    // 存档重放：同样的配置、时间线、出生名单与答案
    const r = World.replay(chinaModern, { config: b.state.config, flags: b.state.flags, intelChanges: b.state.intelChanges, births: b.state.births, answers: b.exportAnswers(b.tick) }, b.tick);
    runAll(r);
    expect(r.state.log.map((e) => e.text)).toEqual(b.state.log.map((e) => e.text));
  });
});
