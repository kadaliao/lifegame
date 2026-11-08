import { describe, expect, it } from 'vitest';
import { World } from '@lifegame/core';
import { chinaModern } from '../../eras/src/index.js';
import { Brain } from './brain.js';
import { Director } from './director.js';
import { LlmHttpError, MockProvider, type CompleteRequest, type CompleteResult, type Provider } from './provider.js';

/** 内容确定、但回答时间随机的假模型 */
class JitteryMock extends MockProvider {
  async complete(req: CompleteRequest): Promise<CompleteResult> {
    await new Promise((r) => setTimeout(r, Math.random() * 25));
    return super.complete(req);
  }
}

function makeWorld(opts: { reflections?: boolean; inherit?: boolean; heroes?: number } = {}): World {
  const w = World.create(chinaModern, { seed: 11, eraId: 'china-modern', population: 70, startYear: 1980, endYear: 2035, birthSpan: 10 });
  w.setFlags({ reflections: opts.reflections ?? false, inherit: opts.inherit ?? false });
  for (const id of w.state.botOrder.slice(0, opts.heroes ?? 5)) w.setIntelligence(id, 'llm', 'mock/mock', true);
  return w;
}

async function drive(world: World, mode: 'patient' | 'tight'): Promise<Director> {
  const brain = new Brain({ providers: { mock: new JitteryMock() }, defaultModel: { providerId: 'mock', model: 'mock' }, concurrency: 3 });
  // tight：画面紧贴模拟，主角一到期就只能推测
  const d: Director = new Director(world, brain, {
    display: () => (mode === 'patient' ? -Infinity : d.world.tick),
    ahead: () => 24,
  });
  let guard = 0;
  while ((!d.world.finished || d.unsettled) && guard++ < 100_000) {
    if (d.world.finished || d.world.tick >= d.target) { await d.whenAnswer(30); continue; }
    const r = d.step();
    if (!r.advanced) await d.whenAnswer(30);
  }
  return d;
}

const texts = (w: World) => w.state.log.map((e) => e.text);

async function finish(d: Director): Promise<void> {
  let guard = 0;
  while ((!d.world.finished || d.unsettled) && guard++ < 100_000) {
    if (d.world.finished || d.world.tick >= d.target) { await d.whenAnswer(30); continue; }
    const r = d.step();
    if (!r.advanced) await d.whenAnswer(30);
  }
}

const mkBrain = () => new Brain({ providers: { mock: new JitteryMock() }, defaultModel: { providerId: 'mock', model: 'mock' }, concurrency: 3 });

describe('Director', () => {
  it('推测执行的最终世界，与一个个老实等出来的世界逐字相同', async () => {
    const patient = await drive(makeWorld(), 'patient');
    const tight = await drive(makeWorld(), 'tight');
    expect(patient.stats.provisional).toBe(0);
    expect(tight.stats.provisional).toBeGreaterThan(3);
    expect(tight.stats.corrections).toBeGreaterThan(0);
    expect(tight.stats.rewinds).toBeGreaterThan(0);
    expect(texts(tight.world)).toEqual(texts(patient.world));
    const monos = (d: Director) => Object.values(d.world.state.decisions).filter((n) => n.applied).map((n) => `${n.id}:${n.chosen}:${n.monologue ?? ''}`).sort();
    expect(monos(tight)).toEqual(monos(patient));
  }, 60_000);

  it('反思与子女继承经由引擎生效：批量运行可重放', async () => {
    const a = await drive(makeWorld({ reflections: true, inherit: true, heroes: 12 }), 'patient');
    const b = await drive(makeWorld({ reflections: true, inherit: true, heroes: 12 }), 'patient');
    const reflections = a.world.state.log.filter((e) => e.type === 'reflection');
    const heirs = Object.values(a.world.state.bots).filter((x) => x.generation > 0 && x.intelligence === 'llm');
    expect(reflections.length).toBeGreaterThan(3);
    expect(heirs.length).toBeGreaterThan(0);
    expect(heirs.every((x) => !x.lead)).toBe(true);
    expect(texts(b.world)).toEqual(texts(a.world));
  }, 60_000);

  it('存档读档：重放到画面所在位置逐字一致，之后继续跑结果也相同', async () => {
    let display = 0;
    const d = new Director(makeWorld({ reflections: true, inherit: true }), mkBrain(), { display: () => display, ahead: () => 36 });
    const extra = d.world.state.botOrder[20];
    let changed = false;
    // 画面按 frontier 允许的速度前进；中途给一个路人赋予智能
    while (display < 330) {
      if (d.world.tick < d.target) {
        const r = d.step();
        if (!r.advanced) await d.whenAnswer(15);
      } else {
        await d.whenAnswer(5);
      }
      display = Math.min(display + 2, d.frontier);
      if (display >= 160 && !changed) {
        changed = true;
        d.change((w) => w.setIntelligence(extra, 'llm', 'mock/mock', true));
      }
    }
    const w = d.world;
    const save = { config: w.state.config, flags: w.state.flags, intelChanges: w.state.intelChanges, answers: w.exportAnswers(display) };
    const loaded = World.replay(chinaModern, JSON.parse(JSON.stringify(save)), display);
    // 画面所在这个月，原来的世界可能还停在月初等答案，只比较之前的
    const upTo = (x: World) => x.state.log.filter((e) => e.tick < display).map((e) => e.text);
    expect(upTo(loaded).length).toBeGreaterThan(500);
    expect(upTo(loaded)).toEqual(upTo(w));
    expect(loaded.bot(extra)!.intelligence).toBe('llm');

    // 两边都老实跑完
    display = -Infinity;
    await finish(d);
    const d2 = new Director(loaded, mkBrain(), { display: () => -Infinity, ahead: () => 36 });
    await finish(d2);
    expect(texts(d2.world)).toEqual(texts(d.world));
  }, 90_000);

  it('主角的请求失败时，已经落地的推测就此定下，不让画面干等', async () => {
    // 稍等一会儿才失败：主角到期时还没有答复，先推测着走了
    const failing: Provider = { id: 'mock', complete: async () => { await new Promise((r) => setTimeout(r, 15)); throw new LlmHttpError('LLM 400: bad', 400); } };
    const brain = new Brain({ providers: { mock: failing }, defaultModel: { providerId: 'mock', model: 'mock' }, concurrency: 3 });
    const d: Director = new Director(makeWorld({ heroes: 3 }), brain, { display: () => d.world.tick, ahead: () => 24 });
    const t0 = Date.now();
    await finish(d);
    expect(d.world.finished).toBe(true);
    expect(d.stats.provisional).toBeGreaterThan(0);
    expect(d.world.provisional).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(20_000);
  }, 30_000);
});
