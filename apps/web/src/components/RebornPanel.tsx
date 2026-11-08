import { useMemo, useState } from 'react';
import { getEra } from '@lifegame/eras';
import type { BirthSpec, Personality, Region, Sex, Talents, Values } from '@lifegame/schema';
import { nowOf, useStore } from '../store.js';

type Num<T> = Partial<Record<keyof T, number>>;

const PERSONALITY: Array<[keyof Personality, string, string, string]> = [
  ['openness', '好奇心', '保守务实', '爱新鲜、想得多'],
  ['conscientiousness', '自律', '散漫随性', '有条理、能吃苦'],
  ['extraversion', '外向', '内向安静', '外向健谈'],
  ['agreeableness', '随和', '有主见、不迁就', '温和、乐于助人'],
  ['neuroticism', '敏感', '心大', '容易焦虑'],
];
const TALENTS: Array<[keyof Talents, string]> = [['intellect', '智力'], ['physique', '体质'], ['charm', '魅力'], ['luck', '运气']];
const VALUES: Array<[keyof Values, string]> = [['ambition', '事业心'], ['family', '家庭观念'], ['security', '求稳'], ['adventure', '冒险'], ['tradition', '传统']];

type Mode = 'lead' | 'user' | 'rules';

export function RebornPanel() {
  const open = useStore((s) => s.rebornOpen);
  const setOpen = useStore((s) => s.setRebornOpen);
  const reborn = useStore((s) => s.reborn);
  const config = useStore((s) => s.config);
  const brain = useStore((s) => s.brain);
  const nowYear = useStore((s) => {
    const br = s.branches[s.activeBranch];
    return br && s.config ? s.config.startYear + Math.floor(nowOf(br) / 12) : 1980;
  });
  const opts = useMemo(() => (config ? getEra(config.eraId).birthOptions?.() : undefined), [config]);

  const [name, setName] = useState('');
  const [sex, setSex] = useState<Sex>('female');
  const [year, setYear] = useState<number | undefined>();
  const [region, setRegion] = useState<Region>('rural');
  const [hometown, setHometown] = useState('');
  const [ses, setSes] = useState(2);
  const [fatherJob, setFatherJob] = useState('');
  const [motherJob, setMotherJob] = useState('');
  const [personality, setPersonality] = useState<Num<Personality>>({});
  const [talents, setTalents] = useState<Num<Talents>>({});
  const [values, setValues] = useState<Num<Values>>({});
  const [bio, setBio] = useState('');
  const [mode, setMode] = useState<Mode>('lead');
  const [model, setModel] = useState('');
  const [more, setMore] = useState(false);

  if (!open || !config || !opts) return null;
  const by = year ?? nowYear;
  const models = brain.providers.flatMap((p) => p.models.map((m) => `${p.id}/${m}`));
  const usedModel = model || brain.defaultModel;
  const places = opts.places.filter((p) => p.region === region);
  const past = by < nowYear;

  const shuffle = () => {
    const r = () => Math.round(10 + Math.random() * 80);
    setPersonality(Object.fromEntries(PERSONALITY.map(([k]) => [k, r()])));
    setTalents(Object.fromEntries(TALENTS.map(([k]) => [k, r()])));
  };

  const go = () => {
    const spec: BirthSpec = {
      name: name.trim() || undefined, sex, region, hometown: hometown || undefined, ses,
      fatherJob: fatherJob || undefined, motherJob: motherJob || undefined,
      personality, talents, values, bio: bio.trim() || undefined,
      intelligence: mode === 'rules' ? 'rules' : 'llm',
      model: mode === 'rules' ? undefined : usedModel,
      lead: mode !== 'rules',
    };
    reborn(spec, by, mode === 'user');
  };

  const slider = <T,>(state: Num<T>, setState: (v: Num<T>) => void, key: keyof T, label: string, low?: string, high?: string) => {
    const v = state[key];
    return (
      <div className="rb-slider" key={String(key)}>
        <span className="rb-label">{label}</span>
        <input type="range" min={1} max={99} value={v ?? 50} className={v === undefined ? 'unset' : ''}
          onChange={(e) => setState({ ...state, [key]: Number(e.target.value) })} />
        <span className="rb-val">
          {v === undefined ? <span className="muted">随机</span> : <>{v}<button className="link" onClick={() => { const n = { ...state }; delete n[key]; setState(n); }}>×</button></>}
        </span>
        {low && <span className="rb-hint muted">{v === undefined ? '' : v < 35 ? low : v > 65 ? high : ''}</span>}
      </div>
    );
  };

  return (
    <div className="modal-bg" onClick={() => setOpen(false)}>
      <div className="modal reborn" onClick={(e) => e.stopPropagation()}>
        <h2>投胎</h2>
        <p className="muted small">设计一个人，投进这个世界活一遍。会开一条新分支，原来的世界不受影响。没填的项按那个年代、那种家庭的常理随机。</p>

        <section className="rb-grid">
          <label>名字<input placeholder="不填就按年代起名" value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label>性别
            <div className="seg">
              <button className={sex === 'female' ? 'on' : ''} onClick={() => setSex('female')}>女</button>
              <button className={sex === 'male' ? 'on' : ''} onClick={() => setSex('male')}>男</button>
            </div>
          </label>
          <label>出生年份
            <input type="number" min={config.startYear} max={config.endYear - 10} value={by} onChange={(e) => setYear(Number(e.target.value))} />
          </label>
          <label>家境
            <div className="seg">
              {opts.sesLabels.map((l, i) => <button key={l} className={ses === i + 1 ? 'on' : ''} onClick={() => setSes(i + 1)}>{l}</button>)}
            </div>
          </label>
          <label>出生在
            <div className="seg">
              {opts.regions.map((r) => <button key={r.id} className={region === r.id ? 'on' : ''} onClick={() => { setRegion(r.id); setHometown(''); }}>{r.label}</button>)}
            </div>
          </label>
          <label>具体地方
            <select value={hometown} onChange={(e) => setHometown(e.target.value)}>
              <option value="">随机</option>
              {places.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
          </label>
          <label>父亲的职业
            <select value={fatherJob} onChange={(e) => setFatherJob(e.target.value)}>
              <option value="">随机</option>
              {[...new Set(opts.parentJobs[region])].map((j) => <option key={j}>{j}</option>)}
            </select>
          </label>
          <label>母亲的职业
            <select value={motherJob} onChange={(e) => setMotherJob(e.target.value)}>
              <option value="">随机</option>
              {[...new Set([...opts.parentJobs[region], region === 'rural' ? '农民' : '家庭主妇'])].map((j) => <option key={j}>{j}</option>)}
            </select>
          </label>
        </section>
        <p className="muted small rb-when">
          {past ? `${by} 年早于画面上的 ${nowYear} 年：新分支会回到 ${by} 年，从 TA 出生开始。那之前的历史不变。` : `新分支从现在（${nowYear} 年）开始，世界继续往前走，等到 ${by} 年 TA 出生。`}
        </p>

        <h3>性格 <button className="link" onClick={shuffle}>随手捏一个</button> <button className="link" onClick={() => { setPersonality({}); setTalents({}); setValues({}); }}>全部随机</button></h3>
        <div className="rb-sliders">{PERSONALITY.map(([k, l, lo, hi]) => slider(personality, setPersonality, k, l, lo, hi))}</div>
        <h3>天赋</h3>
        <div className="rb-sliders">{TALENTS.map(([k, l]) => slider(talents, setTalents, k, l))}</div>
        {more ? (
          <>
            <h3>最看重</h3>
            <div className="rb-sliders">{VALUES.map(([k, l]) => slider(values, setValues, k, l))}</div>
          </>
        ) : <button className="link" onClick={() => setMore(true)}>设定 TA 最看重什么…</button>}

        <h3>身世</h3>
        <textarea rows={3} maxLength={400} placeholder="写几句 TA 的来历，模型做决定时会读到。比如：母亲早逝，跟着奶奶长大；从小爱画画，最怕让人失望。" value={bio} onChange={(e) => setBio(e.target.value)} />

        <h3>谁来过这一生</h3>
        <div className="rb-modes">
          <label className={mode === 'lead' ? 'on' : ''}><input type="radio" checked={mode === 'lead'} onChange={() => setMode('lead')} />让模型以 TA 的人格去活（主角）</label>
          <label className={mode === 'user' ? 'on' : ''}><input type="radio" checked={mode === 'user'} onChange={() => setMode('user')} />我亲自替 TA 做每个人生决定，也可以随时交给模型</label>
          <label className={mode === 'rules' ? 'on' : ''}><input type="radio" checked={mode === 'rules'} onChange={() => setMode('rules')} />按规则活，不调用模型</label>
        </div>
        {mode !== 'rules' && (
          <label className="rb-model">模型
            <select value={usedModel} onChange={(e) => setModel(e.target.value)}>
              {models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
        )}

        <div className="modal-foot">
          <button className="ghost" onClick={() => setOpen(false)}>取消</button>
          <button className="primary" onClick={go}>投胎</button>
        </div>
      </div>
    </div>
  );
}
