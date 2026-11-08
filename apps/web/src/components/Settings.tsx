import { useEffect, useMemo, useState } from 'react';
import {
  FREE_PRESET_ID, PRESETS, createProvider, endpointFor, fetchModels, presetById, presetProvider, probeFree, resolveBrain, serviceReady, siteProvider, splitModel,
  type LlmPrefs, type PresetGroup, type ProviderConfig, type ResolvedBrain, type ServicePrefs,
} from '@lifegame/llm';
import { SITE_SUFFIX, useStore, type WorldSettings } from '../store.js';

const GROUPS: PresetGroup[] = ['免费', '国内', '海外', '本地', '其他'];
const AUTO = '';

export function Settings() {
  const open = useStore((s) => s.settingsOpen);
  // 每次打开都从当前设置重新起草
  return open ? <SettingsModal /> : null;
}

function SettingsModal() {
  const setOpen = useStore((s) => s.setSettingsOpen);
  const prefs = useStore((s) => s.prefs);
  const brain = useStore((s) => s.brain);
  const brainSource = useStore((s) => s.brainSource);
  const exhausted = useStore((s) => s.exhausted);
  const site = useStore((s) => s.site);
  const freeOk = useStore((s) => s.freeOk);
  const world = useStore((s) => s.world);
  const setPrefs = useStore((s) => s.setPrefs);
  const setWorld = useStore((s) => s.setWorld);
  const restart = useStore((s) => s.restart);

  const [p, setP] = useState<LlmPrefs>(() => structuredClone(prefs));
  const [w, setW] = useState<WorldSettings>(world);
  /** 正在看的服务；空串 = 自动 */
  const [svc, setSvc] = useState<string>(() => (prefs.model ? splitModel(prefs.model)[0] : AUTO));
  const [freeSeen, setFreeSeen] = useState(freeOk ?? false);
  const [saving, setSaving] = useState(false);

  const preview = useMemo(() => resolveBrain(p, site, freeSeen, SITE_SUFFIX), [p, site, freeSeen]);
  const spent = exhausted.includes(splitModel(brain.defaultModel)[0]);
  const current = describe({ ...brain, source: brainSource }) + (spent ? ' · 额度已用完，暂时按性格决定' : '');

  // 看免费服务时，还不知道它能不能连上就探一下，"保存后"的预览才准
  useEffect(() => {
    if (svc !== FREE_PRESET_ID || freeSeen) return;
    let alive = true;
    void probeFree().then((ok) => { if (alive && ok) setFreeSeen(true); });
    return () => { alive = false; };
  }, [svc, freeSeen]);

  const pickService = (id: string) => {
    setSvc(id);
    if (id === AUTO) { setP({ ...p, model: undefined }); return; }
    const preset = presetById(id)!;
    const models = modelsFor(id, p.services[id], site);
    const keep = p.model && splitModel(p.model)[0] === id ? splitModel(p.model)[1] : '';
    const model = keep || models[0] || '';
    setP({ ...p, model: model ? `${id}/${model}` : `${preset.id}/` });
  };

  const save = async (andRestart: boolean) => {
    setSaving(true);
    // 选了服务却没填模型，就当自动
    const cleaned: LlmPrefs = { ...p, model: p.model && splitModel(p.model)[1] ? p.model : undefined };
    await setPrefs(cleaned);
    setWorld(w);
    setOpen(false);
    if (andRestart) restart();
  };

  return (
    <div className="modal-bg" onClick={() => setOpen(false)}>
      <div className="modal settings" onClick={(e) => e.stopPropagation()}>
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
              <select value={p.level} onChange={(e) => setP({ ...p, level: Number(e.target.value) as 0 | 1 | 2 })}>
                <option value={0}>0 · 纯规则（不调用模型，秒出一生）</option>
                <option value={1}>1 · 人生节点问模型</option>
                <option value={2}>2 · 节点 + 阶段反思 + 命运旁白</option>
              </select>
            </label>
            <label className="grow">模型服务
              <select value={svc} onChange={(e) => pickService(e.target.value)}>
                <option value={AUTO}>自动（有密钥用密钥，没有就用免费模型，再没有就按规则）</option>
                {GROUPS.map((g) => (
                  <optgroup key={g} label={g}>
                    {PRESETS.filter((x) => x.group === g).map((x) => (
                      <option key={x.id} value={x.id}>{x.label}{readyMark(x.id, p.services[x.id], site, freeSeen)}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
          </div>
          <p className="muted small">现在用的是：{current}</p>
          {svc !== AUTO && (
            <ServiceEditor
              key={svc} id={svc} prefs={p} setPrefs={setP} site={site.find((s) => s.id === svc)}
              onFreeOk={() => setFreeSeen(true)}
            />
          )}
          <p className={`small preview ${preview.source === 'rules' ? 'warn' : ''}`}>
            保存后：{p.level === 0 ? '纯规则，不调用模型' : describe(preview)}
          </p>
        </section>

        <div className="modal-foot">
          <button className="ghost" onClick={() => setOpen(false)}>取消</button>
          <button onClick={() => void save(false)} disabled={saving}>保存</button>
          <button className="primary" onClick={() => void save(true)} disabled={saving}>保存并重开世界</button>
        </div>
      </div>
    </div>
  );
}

function ServiceEditor({ id, prefs, setPrefs, site, onFreeOk }: {
  id: string; prefs: LlmPrefs; setPrefs: (p: LlmPrefs) => void;
  site?: { id: string; label: string; models: string[]; concurrency?: number }; onFreeOk: () => void;
}) {
  const preset = presetById(id)!;
  const sp = prefs.services[id] ?? {};
  const model = prefs.model && splitModel(prefs.model)[0] === id ? splitModel(prefs.model)[1] : '';
  const useSite = !!site && !sp.apiKey;
  const models = modelsFor(id, sp, site ? [site] : []);
  const [status, setStatus] = useState<{ ok?: boolean; text: string }>();
  const [busy, setBusy] = useState(false);

  const setSp = (patch: Partial<ServicePrefs>, nextModel = model) => {
    const next: ServicePrefs = { ...sp, ...patch };
    for (const k of Object.keys(next) as Array<keyof ServicePrefs>) if (next[k] === '' || next[k] === undefined) delete next[k];
    setPrefs({ ...prefs, services: { ...prefs.services, [id]: next }, model: `${id}/${nextModel}` });
  };
  const setModel = (m: string) => setPrefs({ ...prefs, model: `${id}/${m}` });

  /** 现在这些设置下，调用这个服务用的配置 */
  const config = (): ProviderConfig | undefined => {
    if (useSite) return siteProvider(site!, SITE_SUFFIX);
    if (!serviceReady(preset, sp)) return undefined;
    return presetProvider(preset, sp, model);
  };

  const refresh = async (key = sp.apiKey) => {
    if (useSite && !key) { setStatus({ ok: true, text: `本站提供 ${site!.models.length} 个模型` }); return; }
    if (preset.key === 'required' && !key) { setStatus({ ok: false, text: '先填密钥' }); return; }
    if (preset.id === 'mock') return;
    setBusy(true);
    setStatus({ text: '正在获取模型列表…' });
    try {
      const list = await fetchModels(preset, key, { baseUrl: endpointFor(preset, sp), signal: AbortSignal.timeout(15_000) });
      if (!list.length) { setStatus({ ok: false, text: '没拿到对话模型，可以直接填模型名' }); return; }
      setSp({ apiKey: key, models: list }, list.includes(model) ? model : list[0]);
      setStatus({ ok: true, text: `拿到 ${list.length} 个模型` });
      if (preset.id === FREE_PRESET_ID) onFreeOk();
    } catch (e) {
      setStatus({ ok: false, text: `获取失败：${explain(e)}` });
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    const cfg = config();
    if (!cfg) { setStatus({ ok: false, text: preset.editableUrl ? '先填地址' : '先填密钥' }); return; }
    if (!model) { setStatus({ ok: false, text: '先选一个模型' }); return; }
    setBusy(true);
    setStatus({ text: '正在问模型…' });
    const t0 = performance.now();
    try {
      const r = await createProvider(cfg).complete({
        model, json: true, maxTokens: 120, temperature: 0.9,
        messages: [
          { role: 'system', content: '你是人生模拟游戏里的一个普通人。只输出一个 JSON 对象。' },
          { role: 'user', content: '用一句话说说你此刻的心情，输出 {"say":"……"}' },
        ],
      });
      const said = r.text.match(/"say"\s*:\s*"([^"]*)"/)?.[1] ?? r.text.slice(0, 60);
      setStatus({ ok: true, text: `能用 · ${((performance.now() - t0) / 1000).toFixed(1)} 秒 · “${said}”` });
      if (preset.id === FREE_PRESET_ID) onFreeOk();
    } catch (e) {
      setStatus({ ok: false, text: explain(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="svc">
      <p className="muted small">
        {preset.note}
        {preset.keyUrl && <> <a href={preset.keyUrl} target="_blank" rel="noreferrer">{preset.key === 'optional' ? '领令牌' : '申请密钥'} ↗</a></>}
      </p>
      {site && <p className="small site-note">{sp.apiKey ? `本站也提供了 ${preset.label}，填了你自己的密钥就用你的。` : `本站已经提供了 ${preset.label} 的密钥，不填也能用。`}</p>}
      <div className="row">
        {preset.editableUrl && (
          <label className="grow">地址
            <input placeholder={preset.baseUrl || 'https://…/v1'} value={sp.baseUrl ?? ''} onChange={(e) => setSp({ baseUrl: e.target.value.trim() })} />
          </label>
        )}
        {preset.key !== 'none' && (
          <label className="grow">{preset.key === 'optional' ? 'API Key（可不填）' : 'API Key'}
            <input
              type="password" autoComplete="off" spellCheck={false} placeholder={useSite ? '不填就用本站的' : preset.key === 'optional' ? '不填也能用' : '粘贴密钥'}
              value={sp.apiKey ?? ''} onChange={(e) => setSp({ apiKey: e.target.value.trim() })}
              onBlur={(e) => { const k = e.target.value.trim(); if (k && !sp.models?.length) void refresh(k); }}
            />
          </label>
        )}
        <label className="grow">模型
          <input list={`models-${id}`} placeholder={models.length ? '选或填模型名' : '填模型名'} value={model} onChange={(e) => setModel(e.target.value.trim())} />
          <datalist id={`models-${id}`}>{models.map((m) => <option key={m} value={m} />)}</datalist>
        </label>
      </div>
      <div className="row svc-actions">
        {preset.id !== 'mock' && <button onClick={() => void refresh()} disabled={busy}>获取模型列表</button>}
        <button onClick={() => void test()} disabled={busy}>测试</button>
        {status && <span className={`small ${status.ok === false ? 'bad' : status.ok ? 'good' : 'muted'}`}>{status.text}</span>}
      </div>
      {preset.key !== 'none' && (
        <p className="muted small">
          {preset.cors
            ? `密钥只存在这个浏览器里，由浏览器直接发给 ${preset.label}。`
            : `密钥只存在这个浏览器里；${preset.label} 不允许网页直连，请求经本站的 /api/llm 转发，不做记录。`}
        </p>
      )}
    </div>
  );
}

/** 下拉里的模型：拉到过的 > 本站提供的 > 推荐的 */
function modelsFor(id: string, sp: ServicePrefs | undefined, site: Array<{ id: string; models: string[] }>): string[] {
  if (sp?.models?.length) return sp.models;
  const s = site.find((x) => x.id === id);
  if (s && !sp?.apiKey) return s.models;
  return presetById(id)?.models ?? [];
}

function readyMark(id: string, sp: ServicePrefs | undefined, site: Array<{ id: string }>, freeOk: boolean): string {
  const preset = presetById(id)!;
  if (preset.key !== 'none' && sp?.apiKey) return ' · 已填密钥';
  if (site.some((s) => s.id === id)) return `（${SITE_SUFFIX}）`;
  if (id === FREE_PRESET_ID) return freeOk ? ' · 免密钥' : ' · 免密钥（暂时连不上）';
  return '';
}

function describe(r: Pick<ResolvedBrain, 'providers' | 'defaultModel' | 'source' | 'level'>): string {
  if (r.source === 'rules' || !r.defaultModel) return '没有可用的模型，按规则运行';
  const [pid, model] = splitModel(r.defaultModel);
  const p = r.providers.find((x) => x.id === pid);
  const why = { chosen: '你选的', own: '你的密钥', site: SITE_SUFFIX, free: '免费，免密钥', rules: '' }[r.source];
  return `${p?.label ?? pid} · ${model}（${why}）${r.level === 0 ? ' · 但档位是纯规则' : ''}`;
}

function explain(e: unknown): string {
  const s = String((e as Error)?.message ?? e);
  if (/Failed to fetch|NetworkError|Load failed/i.test(s)) return '连不上（网络不通，或者这个服务不允许网页跨域访问）';
  if (/\b401\b|\b403\b|invalid.*key|Unauthorized|令牌|密钥/i.test(s)) return `密钥不对或没有权限：${s.slice(0, 120)}`;
  if (/\b404\b/.test(s)) return `地址或模型名不对：${s.slice(0, 120)}`;
  if (/\b429\b/.test(s)) return '太频繁了，被限流，稍后再试';
  if (/TimeoutError|timed out|超过/i.test(s)) return '等太久没有回应';
  return s.slice(0, 160);
}
