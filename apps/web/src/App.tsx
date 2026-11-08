import { useEffect, useState } from 'react';
import { DecisionPanel } from './components/DecisionPanel.js';
import { Settings } from './components/Settings.js';
import { Sidebar } from './components/Sidebar.js';
import { caughtUp, nowOf, useBranch, useStore } from './store.js';
import { LifeScroll } from './views/LifeScroll.js';
import { PeopleView } from './views/PeopleView.js';
import { TimeRiver } from './views/TimeRiver.js';

const SPEEDS: Array<[number, string]> = [[6, '慢'], [24, '2年/秒'], [96, '8年/秒'], [Infinity, '极速']];

export function App() {
  const boot = useStore((s) => s.boot);
  const era = useStore((s) => s.era);
  const branch = useBranch();
  const compareId = useStore((s) => s.compareBranch);
  const compareBranch = useStore((s) => (s.compareBranch ? s.branches[s.compareBranch] : undefined));
  const detail = useStore((s) => s.botDetail);
  const compareDetail = useStore((s) => s.compareDetail);
  const playing = useStore((s) => s.playing);
  const play = useStore((s) => s.play);
  const pause = useStore((s) => s.pause);
  const speed = useStore((s) => s.speed);
  const setSpeed = useStore((s) => s.setSpeed);
  const viewTick = useStore((s) => s.viewTick);
  const setViewTick = useStore((s) => s.setViewTick);
  const usage = useStore((s) => s.usage);
  const queue = useStore((s) => s.queue);
  const thinking = useStore((s) => s.thinking);
  const errors = useStore((s) => s.errors);
  const dismiss = useStore((s) => s.dismissError);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const restart = useStore((s) => s.restart);
  const config = useStore((s) => s.config);

  const [view, setView] = useState<'river' | 'people'>(() => {
    try { return localStorage.getItem('lifegame.view') === 'people' ? 'people' : 'river'; } catch { return 'river'; }
  });
  const switchView = (v: 'river' | 'people') => {
    setView(v);
    try { localStorage.setItem('lifegame.view', v); } catch { /* ignore */ }
  };

  useEffect(() => { boot(); }, [boot]);

  useEffect(() => {
    if (!era) return;
    const r = document.documentElement.style;
    r.setProperty('--accent', era.theme.accent);
    r.setProperty('--paper', era.theme.paper);
    r.setProperty('--ink', era.theme.ink);
  }, [era]);

  if (!branch || !config) return <div className="boot">世界正在成形…</div>;
  const s = branch.summary;
  const maxTick = (config.endYear - config.startYear) * 12;
  const simTick = s?.tick ?? 0;
  const nowTick = nowOf(branch);
  const shown = Math.min(viewTick ?? nowTick, nowTick);
  const atEnd = branch.finished && nowTick >= simTick;
  const year = config.startYear + Math.floor(shown / 12);
  const counts = shown >= simTick && s ? { alive: s.alive, dead: s.dead } : countAt(branch.bots, shown);
  const month = (shown % 12) + 1;

  return (
    <div className="app">
      <header className="top">
        <div className="brand"><h1>人生游戏</h1><span className="muted">{era?.name}</span></div>
        <div className="seg views">
          <button className={view === 'river' ? 'on' : ''} onClick={() => switchView('river')} title="每个家族的人生轨迹，和众人汇成的河">长河</button>
          <button className={view === 'people' ? 'on' : ''} onClick={() => switchView('people')} title="此刻每个人在年龄与财富上的位置">众生相</button>
        </div>
        <div className="clock">
          <b>{year}</b><span className="muted">年{month}月</span>
          {s && <span className="muted"> · 在世 {counts.alive} · 离世 {counts.dead}</span>}
          {branch.info.id !== 'main' && <span className="hero-tag">{branch.info.label}</span>}
          {caughtUp(branch) && Object.keys(thinking).length > 0 && (
            <span className="waiting" title="画面追上了模拟，世界在等这些人拿主意">
              ✦ {Object.keys(thinking).map((id) => branch.bots[id]?.name).filter(Boolean).slice(0, 3).join('、')}{Object.keys(thinking).length > 3 ? ` 等${Object.keys(thinking).length}人` : ''}在想…
            </span>
          )}
        </div>
        <div className="controls">
          {playing ? <button onClick={pause}>⏸ 暂停</button> : <button className="primary" onClick={play} disabled={atEnd}>{atEnd ? '已到尽头' : nowTick === 0 ? '▶ 开始' : '▶ 继续'}</button>}
          <div className="seg">
            {SPEEDS.map(([v, l]) => <button key={l} className={speed === v ? 'on' : ''} onClick={() => setSpeed(v)}>{l}</button>)}
          </div>
          <input className="scrub" type="range" min={0} max={Math.max(1, nowTick)} value={shown} onChange={(e) => { const t = Number(e.target.value); setViewTick(t >= nowTick ? undefined : t); }} title="回看时间" />
          <span className="muted small">{Math.round((nowTick / maxTick) * 100)}%</span>
        </div>
        <div className="right">
          {usage && <span className="muted small" title={Object.entries(usage.byModel).map(([k, v]) => `${k}: ${v.calls} 次`).join('\n')}>模型 {usage.calls} 次 · {fmtTokens(usage.input + usage.output)} tokens{usage.cacheHits ? ` · 缓存 ${usage.cacheHits}` : ''}{queue > 0 ? ` · 排队 ${queue}` : ''}{usage.errors ? ` · 重试 ${usage.errors}` : ''}</span>}
          <button className="ghost" onClick={restart} title="同样的设置重开">↺ 重开</button>
          <button className="ghost" onClick={() => setSettingsOpen(true)}>⚙ 设置</button>
        </div>
      </header>
      <main className={`body ${compareBranch ? 'compare' : ''}`}>
        <Sidebar branch={branch} />
        <section className="center">
          {view === 'river' ? <TimeRiver key={`r-${branch.info.id}`} branch={branch} /> : <PeopleView branch={branch} />}
        </section>
        <section className="side">
          {compareBranch && compareId ? (
            <div className="compare-wrap">
              <div className="col"><div className="col-head">{compareBranch.info.label}</div><LifeScroll detail={compareDetail} branch={compareBranch} compact highlightAfter={branch.info.forkedAtTick} /></div>
              <div className="col"><div className="col-head accent">{branch.info.label}</div><LifeScroll detail={detail} branch={branch} compact highlightAfter={branch.info.forkedAtTick} /></div>
            </div>
          ) : (
            <LifeScroll detail={detail} branch={branch} />
          )}
        </section>
      </main>
      <DecisionPanel />
      <Settings />
      {errors.length > 0 && (
        <div className="toasts">
          {errors.map((e, i) => <div key={i} className="toast" onClick={() => dismiss(i)}>{e}</div>)}
        </div>
      )}
    </div>
  );
}

function countAt(bots: Record<string, { birthTick: number; deathTick?: number }>, t: number): { alive: number; dead: number } {
  let alive = 0;
  let dead = 0;
  for (const id in bots) {
    const b = bots[id];
    if (b.birthTick > t) continue;
    if (b.deathTick !== undefined && b.deathTick <= t) dead++;
    else alive++;
  }
  return { alive, dead };
}

function fmtTokens(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}
