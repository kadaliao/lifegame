import { useMemo, useState } from 'react';
import { stageName } from '@lifegame/core';
import type { DecisionNode, LifeStage, WorldEvent } from '@lifegame/schema';
import { fmtMoney, useStore, type BotDetail, type BranchData } from '../store.js';
import { eduLabel } from '../util.js';

const STAGES: LifeStage[] = ['infant', 'child', 'teen', 'youth', 'adult', 'middle', 'senior'];
const STAGE_AGE: Record<LifeStage, number> = { infant: 0, child: 3, teen: 12, youth: 18, adult: 30, middle: 45, senior: 60 };

export function LifeScroll({ detail, branch, compact, highlightAfter }: { detail?: BotDetail; branch: BranchData; compact?: boolean; highlightAfter?: number }) {
  const startYear = useStore((s) => s.config?.startYear ?? 1980);
  const viewTick = useStore((s) => s.viewTick);
  const selected = useStore((s) => s.selectedBot);
  const summary = selected ? branch.bots[selected] : undefined;
  const shownTick = viewTick ?? branch.summary?.tick ?? 0;

  const events = useMemo(() => {
    if (!selected) return [];
    return branch.events.filter((e) => e.botId === selected && e.tick <= shownTick && e.importance >= 3 && e.type !== 'stage');
  }, [branch.events, selected, shownTick]);

  if (!summary) return <div className="scroll empty">点一条生命线，看看这个人的一生。</div>;
  const bot = detail?.bot;
  const birthYear = startYear + Math.floor(summary.birthTick / 12);
  const age = Math.floor((Math.min(shownTick, summary.deathTick ?? shownTick) - summary.birthTick) / 12);
  const decisions = new Map((detail?.decisions ?? []).map((d) => [d.id, d]));

  // 按阶段分章
  const chapters = STAGES.map((st) => {
    const from = summary.birthTick + STAGE_AGE[st] * 12;
    const next = STAGES[STAGES.indexOf(st) + 1];
    const to = next ? summary.birthTick + STAGE_AGE[next] * 12 : Infinity;
    const evs = events.filter((e) => e.tick >= from && e.tick < to);
    const reflection = bot?.reflections.find((r) => r.stage === st);
    return { stage: st, from, evs, reflection };
  }).filter((c) => c.from <= shownTick && (c.evs.length || c.reflection));

  return (
    <div className={`scroll ${compact ? 'compact' : ''}`}>
      <header className="scroll-head">
        <div className="avatar" style={{ background: avatarColor(summary.id) }}>{summary.name.slice(-1)}</div>
        <div>
          <h2>{summary.name} {summary.intelligence === 'llm' && <span className="hero-tag">✦ {summary.model?.split('/').pop() ?? '智能'}</span>}</h2>
          <div className="muted">
            {summary.sex === 'male' ? '男' : '女'} · {birthYear}年生 · {summary.deathTick !== undefined && summary.deathTick <= shownTick ? `享年${Math.floor((summary.deathTick - summary.birthTick) / 12)}岁` : `${age}岁`} · {summary.city}
          </div>
        </div>
        <HeroToggle id={summary.id} mode={summary.intelligence} />
      </header>
      {bot && (
        <section className="persona">
          {bot.portrait && <p className="portrait">「{bot.portrait}」</p>}
          <div className="stats">
            <Stat label="健康" v={bot.state.health} />
            <Stat label="心情" v={bot.state.happiness} />
            <div className="stat"><span className="muted">资产</span><b>{fmtMoney(bot.state.wealth + (bot.state.vars.assets ?? 0) - (bot.state.vars.debt ?? 0))}</b></div>
            <div className="stat"><span className="muted">学历</span><b>{eduLabel(bot.state.education)}</b></div>
            <div className="stat"><span className="muted">职业</span><b>{bot.state.job?.title ?? (bot.state.tags.includes('student') ? '学生' : bot.state.tags.includes('retired') ? '退休' : '无')}</b></div>
          </div>
          {detail && detail.samples.length > 2 && <Sparklines samples={detail.samples} shownTick={shownTick} />}
          <p className="muted small">
            {bot.origin.hometown}{['赤贫', '贫寒', '普通', '小康', '富裕'][bot.origin.ses - 1]}之家 · 父{bot.origin.fatherJob} 母{bot.origin.motherJob}
            {bot.goal && <><br />心愿：{bot.goal}</>}
          </p>
        </section>
      )}
      <div className="chapters">
        {chapters.map((c) => (
          <section key={c.stage} className="chapter">
            <h3>{stageName(c.stage)}<span className="muted"> · {startYear + Math.floor(c.from / 12)}年起</span></h3>
            <ol>
              {c.evs.map((e) => (
                <EventRow key={e.seq} e={e} birthTick={summary.birthTick} startYear={startYear} decision={e.decisionId ? decisions.get(e.decisionId) ?? branch.decided[e.decisionId] : undefined} dim={highlightAfter !== undefined && e.tick < highlightAfter} branchId={branch.info.id} />
              ))}
            </ol>
            {c.reflection && <blockquote className="reflection">{c.reflection.text}</blockquote>}
          </section>
        ))}
      </div>
    </div>
  );
}

function EventRow({ e, birthTick, startYear, decision, dim, branchId }: { e: WorldEvent; birthTick: number; startYear: number; decision?: DecisionNode; dim: boolean; branchId: string }) {
  const [open, setOpen] = useState(false);
  const fork = useStore((s) => s.fork);
  const age = Math.floor((e.tick - birthTick) / 12);
  const year = startYear + Math.floor(e.tick / 12);
  const cls = `ev ev-${e.type} imp-${Math.min(10, e.importance)} ${dim ? 'dim' : ''}`;
  if (decision) {
    const chosen = decision.options.find((o) => o.id === decision.chosen);
    return (
      <li className={cls + ' ev-decision'}>
        <span className="when">{year} · {age}岁</span>
        <div>
          <div className="situation">{decision.situation}</div>
          <div className="chosen">→ {chosen?.label ?? decision.chosen}<span className="by">{decision.resolvedBy === 'llm' ? '模型' : decision.resolvedBy === 'user' ? '你' : '规则'}</span></div>
          {decision.monologue && <blockquote className="monologue">{decision.monologue}</blockquote>}
          {decision.options.length > 1 && <button className="link" onClick={() => setOpen(!open)}>{open ? '收起' : `如果当时选了别的…（${decision.options.length - 1} 条路）`}</button>}
          {open && (
            <div className="alt-options">
              {decision.options.filter((o) => o.id !== decision.chosen).map((o) => (
                <button key={o.id} className="alt" onClick={() => { fork(decision.id, o.id); setOpen(false); }} title={o.description}>
                  <b>{o.label}</b><span className="muted">{o.description}</span>
                </button>
              ))}
              <div className="muted small">分叉会从这一刻复制整个世界，重跑另一条人生。（当前分支：{branchId}）</div>
            </div>
          )}
        </div>
      </li>
    );
  }
  return (
    <li className={cls}>
      <span className="when">{year} · {age}岁</span>
      <div>{e.text}</div>
    </li>
  );
}

function HeroToggle({ id, mode }: { id: string; mode: 'rules' | 'llm' }) {
  const setIntelligence = useStore((s) => s.setIntelligence);
  const brain = useStore((s) => s.brain);
  const userControl = useStore((s) => s.userControl);
  const setUserControl = useStore((s) => s.setUserControl);
  return (
    <div className="hero-toggle">
      <button className={mode === 'llm' ? 'on' : ''} onClick={() => setIntelligence(id, mode === 'llm' ? 'rules' : 'llm', brain.defaultModel)} title="开启后，这个人的重大抉择由大模型以其人格决定">
        {mode === 'llm' ? '✦ 智能中' : '赋予智能'}
      </button>
      <button className={userControl === id ? 'on' : ''} onClick={() => setUserControl(userControl === id ? null : id)} title="开启后，每到人生节点都停下来让你来选">
        {userControl === id ? '✎ 我在掌控' : '我来掌控'}
      </button>
    </div>
  );
}

function Stat({ label, v }: { label: string; v: number }) {
  return (
    <div className="stat">
      <span className="muted">{label}</span>
      <div className="bar"><i style={{ width: `${Math.round(v)}%`, background: v > 60 ? '#5fa8a0' : v > 35 ? '#c98a3d' : '#c8362f' }} /></div>
    </div>
  );
}

function Sparklines({ samples, shownTick }: { samples: { tick: number; health: number; happiness: number; netWorth: number }[]; shownTick: number }) {
  const pts = samples.filter((s) => s.tick <= shownTick);
  if (pts.length < 2) return null;
  const W = 320; const H = 46;
  const x = (i: number) => (i / (pts.length - 1)) * W;
  const line = (get: (s: typeof pts[number]) => number, max: number) => pts.map((s, i) => `${x(i).toFixed(1)},${(H - (Math.max(0, get(s)) / max) * H).toFixed(1)}`).join(' ');
  const maxNw = Math.max(1, ...pts.map((s) => s.netWorth));
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <polyline points={line((s) => s.netWorth, maxNw)} fill="none" stroke="#c98a3d" strokeWidth="1.5" />
      <polyline points={line((s) => s.health, 100)} fill="none" stroke="#5fa8a0" strokeWidth="1.2" />
      <polyline points={line((s) => s.happiness, 100)} fill="none" stroke="#4f7fbf" strokeWidth="1.2" strokeDasharray="3 2" />
    </svg>
  );
}

export function avatarColor(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 35% 55%)`;
}
