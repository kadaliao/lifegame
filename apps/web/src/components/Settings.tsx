import { useState } from 'react';
import type { ProviderConfig } from '@lifegame/llm';
import { useStore } from '../store.js';

export function Settings() {
  const open = useStore((s) => s.settingsOpen);
  const setOpen = useStore((s) => s.setSettingsOpen);
  const brain = useStore((s) => s.brain);
  const world = useStore((s) => s.world);
  const setBrain = useStore((s) => s.setBrain);
  const setWorld = useStore((s) => s.setWorld);
  const restart = useStore((s) => s.restart);
  const [b, setB] = useState(brain);
  const [w, setW] = useState(world);
  if (!open) return null;

  const models = b.providers.flatMap((p) => p.models.map((m) => `${p.id}/${m}`));
  const updateProvider = (i: number, patch: Partial<ProviderConfig>) => {
    const providers = b.providers.map((p, j) => (j === i ? { ...p, ...patch } : p));
    setB({ ...b, providers });
  };
  const save = (andRestart: boolean) => {
    setBrain(b);
    setWorld(w);
    setOpen(false);
    if (andRestart) restart();
  };

  return (
    <div className="modal-bg" onClick={() => setOpen(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>设置</h2>
        <section>
          <h3>世界</h3>
          <div className="row">
            <label>种子<input type="number" value={w.seed} onChange={(e) => setW({ ...w, seed: Number(e.target.value) })} /></label>
            <label>初始人口<input type="number" min={10} max={2000} value={w.population} onChange={(e) => setW({ ...w, population: Number(e.target.value) })} /></label>
            <label>智能主角数<input type="number" min={0} max={50} value={w.heroCount} onChange={(e) => setW({ ...w, heroCount: Number(e.target.value) })} /></label>
            <label>结束年份<input type="number" min={1990} max={2100} value={w.endYear} onChange={(e) => setW({ ...w, endYear: Number(e.target.value) })} /></label>
          </div>
          <p className="muted small">同一种子 + 同样设置 = 完全相同的世界。主角由大模型驱动，其余人按规则生活，可随时为任何人开启智能。</p>
        </section>
        <section>
          <h3>智能</h3>
          <div className="row">
            <label>档位
              <select value={b.level} onChange={(e) => setB({ ...b, level: Number(e.target.value) as 0 | 1 | 2 })}>
                <option value={0}>0 · 纯规则（免费，秒出一生）</option>
                <option value={1}>1 · 人生节点问模型</option>
                <option value={2}>2 · 节点 + 阶段反思 + 命运旁白</option>
              </select>
            </label>
            <label>默认模型
              <select value={b.defaultModel} onChange={(e) => setB({ ...b, defaultModel: e.target.value })}>
                {models.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
          </div>
          <h3>模型服务</h3>
          <p className="muted small">密钥只存在本机浏览器 localStorage，直接从浏览器调用接口。Ollama 需设置 <code>OLLAMA_ORIGINS=*</code>。</p>
          {b.providers.map((p, i) => (
            <div key={p.id} className="provider">
              <b>{p.label ?? p.id}</b>
              {p.kind !== 'mock' && (
                <>
                  <input placeholder="Base URL" value={p.baseUrl ?? ''} onChange={(e) => updateProvider(i, { baseUrl: e.target.value })} />
                  <input placeholder="API Key" type="password" value={p.apiKey ?? ''} onChange={(e) => updateProvider(i, { apiKey: e.target.value })} />
                  <input placeholder="模型，逗号分隔" value={p.models.join(',')} onChange={(e) => updateProvider(i, { models: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
                </>
              )}
            </div>
          ))}
        </section>
        <div className="modal-foot">
          <button className="ghost" onClick={() => setOpen(false)}>取消</button>
          <button onClick={() => save(false)}>保存</button>
          <button className="primary" onClick={() => save(true)}>保存并重开世界</button>
        </div>
      </div>
    </div>
  );
}
