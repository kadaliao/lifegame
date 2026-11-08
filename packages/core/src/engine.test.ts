import { describe, expect, it } from 'vitest';
import { World } from './engine.js';
import { chinaModern } from '../../eras/src/index.js';

const cfg = { seed: 7, eraId: 'china-modern', population: 60, startYear: 1980, endYear: 2040, birthSpan: 10 };

function runAll(w: World) {
  while (!w.finished) {
    const r = w.step();
    for (const d of r.pending) w.resolveDecision(d.id, d.options[0].id, 'user');
  }
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

  it('智能 bot 的决策会挂起，解决后继续', () => {
    const w = World.create(chinaModern, cfg);
    const hero = w.state.botOrder[0];
    w.setIntelligence(hero, 'llm', 'mock');
    let pendingSeen = 0;
    while (!w.finished) {
      const r = w.step();
      for (const d of r.pending) {
        expect(d.botId).toBe(hero);
        pendingSeen++;
        w.resolveDecision(d.id, d.options[d.options.length - 1].id, 'llm', '随便选一个');
      }
    }
    expect(pendingSeen).toBeGreaterThan(2);
    expect(() => {
      const w2 = World.create(chinaModern, cfg);
      w2.setIntelligence(hero, 'llm');
      while (true) {
        const r = w2.step();
        if (r.pending.length) { w2.step(); break; }
        if (r.finished) break;
      }
    }).toThrow();
  });

  it('分叉：改选一个决策后，分叉前的历史一致，之后分歧，原分支不受影响', () => {
    const w = World.create(chinaModern, cfg);
    const hero = w.state.botOrder[0];
    w.setIntelligence(hero, 'llm');
    const chosen: string[] = [];
    while (!w.finished) {
      const r = w.step();
      for (const d of r.pending) {
        chosen.push(d.id);
        w.resolveDecision(d.id, d.options[0].id, 'llm', 'm');
      }
    }
    const before = JSON.stringify(w.state.log);
    const target = w.state.decisions[chosen[1]];
    expect(target.options.length).toBeGreaterThan(1);
    const alt = target.options[1].id;
    const child = w.fork(target.id, alt, 'alt');
    expect(JSON.stringify(w.state.log)).toBe(before);
    const forkedNode = child.state.decisions[target.id];
    expect(forkedNode.chosen).toBe(alt);
    expect(forkedNode.resolvedBy).toBe('user');
    // 决策之前的日志前缀一致
    const prefixLen = w.state.log.findIndex((e) => e.decisionId === target.id);
    expect(prefixLen).toBeGreaterThan(0);
    const pa = w.state.log.slice(0, prefixLen).map((e) => e.text).join('|');
    const pb = child.state.log.slice(0, prefixLen).map((e) => e.text).join('|');
    expect(pb).toBe(pa);
    // 分叉后，改选引发的连锁决策会挂起，交给驱动层
    for (const d of child.pending) child.resolveDecision(d.id, d.options[0].id, 'llm', 'm');
    // 继续跑分支
    while (!child.finished) {
      const r = child.step();
      for (const d of r.pending) child.resolveDecision(d.id, d.options[0].id, 'llm', 'm');
    }
    expect(JSON.stringify(child.state.log)).not.toBe(before);
    expect(child.state.branchId).toBe('alt');
    expect(child.state.parentBranchId).toBe('main');
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
});
