import { describe, expect, it } from 'vitest';
import { World } from '@lifegame/core';
import { chinaModern } from '../../eras/src/index.js';
import { Brain } from './brain.js';
import { Director } from './director.js';
import { MockProvider, type CompleteRequest, type CompleteResult } from './provider.js';

/** 内容确定、但回答时间随机的假模型 */
class JitteryMock extends MockProvider {
  async complete(req: CompleteRequest): Promise<CompleteResult> {
    await new Promise((r) => setTimeout(r, Math.random() * 25));
    return super.complete(req);
  }
}

function makeWorld(opts: { reflections?: boolean; inherit?: boolean } = {}): World {
  const w = World.create(chinaModern, { seed: 11, eraId: 'china-modern', population: 70, startYear: 1980, endYear: 2035, birthSpan: 10 });
  w.setFlags({ reflections: opts.reflections ?? false, inherit: opts.inherit ?? false });
  for (const id of w.state.botOrder.slice(0, 5)) w.setIntelligence(id, 'llm', 'mock/mock', true);
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
    const a = await drive(makeWorld({ reflections: true, inherit: true }), 'patient');
    const b = await drive(makeWorld({ reflections: true, inherit: true }), 'patient');
    const reflections = a.world.state.log.filter((e) => e.type === 'reflection');
    const heirs = Object.values(a.world.state.bots).filter((x) => x.generation > 0 && x.intelligence === 'llm');
    expect(reflections.length).toBeGreaterThan(3);
    expect(heirs.length).toBeGreaterThan(0);
    expect(heirs.every((x) => !x.lead)).toBe(true);
    expect(texts(b.world)).toEqual(texts(a.world));
  }, 60_000);
});
