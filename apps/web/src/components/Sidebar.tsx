import { useMemo, useState } from 'react';
import { useStore, type BranchData } from '../store.js';
import { avatarColor } from '../views/LifeScroll.js';

export function Sidebar({ branch }: { branch: BranchData }) {
  const selected = useStore((s) => s.selectedBot);
  const selectBot = useStore((s) => s.selectBot);
  const thinking = useStore((s) => s.thinking);
  const branches = useStore((s) => s.branches);
  const active = useStore((s) => s.activeBranch);
  const compare = useStore((s) => s.compareBranch);
  const setActive = useStore((s) => s.setActiveBranch);
  const setCompare = useStore((s) => s.setCompareBranch);
  const startYear = useStore((s) => s.config?.startYear ?? 1980);
  const [q, setQ] = useState('');
  const tick = branch.summary?.tick ?? 0;

  const heroes = useMemo(() => branch.botOrder.map((id) => branch.bots[id]).filter((b) => b.intelligence === 'llm'), [branch]);
  const others = useMemo(() => {
    if (!q) return [];
    return branch.botOrder.map((id) => branch.bots[id]).filter((b) => b.name.includes(q) || (b.jobTitle ?? '').includes(q) || b.city.includes(q)).slice(0, 30);
  }, [branch, q]);

  const row = (b: typeof heroes[number]) => {
    const alive = b.deathTick === undefined;
    const age = Math.floor((Math.min(tick, b.deathTick ?? tick) - b.birthTick) / 12);
    return (
      <li key={b.id} className={`${selected === b.id ? 'sel' : ''} ${alive ? '' : 'dead'}`} onClick={() => selectBot(b.id)}>
        <span className="avatar sm" style={{ background: avatarColor(b.id) }}>{b.name.slice(-1)}</span>
        <div>
          <b>{b.name}</b> <span className="muted">{b.birthTick > tick ? `${startYear + Math.floor(b.birthTick / 12)}年生` : alive ? `${age}岁` : `卒 ${startYear + Math.floor(b.deathTick! / 12)}`}</span>
          <div className="muted small">{b.jobTitle ?? b.city}{thinking[b.id] ? <span className="think"> · 沉思中…</span> : ''}</div>
        </div>
      </li>
    );
  };

  const list = Object.values(branches);
  return (
    <aside className="sidebar">
      {list.length > 1 && (
        <section>
          <h4>分支</h4>
          <ul className="branches">
            {list.map((br) => (
              <li key={br.info.id} className={br.info.id === active ? 'sel' : ''}>
                <button onClick={() => setActive(br.info.id)}>{br.info.label}{br.info.forkedAtTick !== undefined && <span className="muted"> · {startYear + Math.floor(br.info.forkedAtTick / 12)}</span>}</button>
                {br.info.id !== active && <button className="link" onClick={() => setCompare(compare === br.info.id ? undefined : br.info.id)}>{compare === br.info.id ? '取消对比' : '对比'}</button>}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section>
        <h4>智能人格 <span className="muted">{heroes.length}</span></h4>
        <ul className="bots">{heroes.map(row)}</ul>
        {heroes.length === 0 && <p className="muted small">还没有人被赋予智能。点开任何人的卷轴，按「赋予智能」。</p>}
      </section>
      <section>
        <h4>找人</h4>
        <input className="search" placeholder="姓名 / 职业 / 城市" value={q} onChange={(e) => setQ(e.target.value)} />
        <ul className="bots">{others.map(row)}</ul>
      </section>
    </aside>
  );
}
