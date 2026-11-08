import { nowOf, useStore } from '../store.js';

export function DecisionPanel() {
  const pending = useStore((s) => s.pendingUser);
  const resolve = useStore((s) => s.resolveUser);
  const ask = useStore((s) => s.askBrain);
  const branch = useStore((s) => (pending ? s.branches[pending.branchId] : undefined));
  if (!pending || !branch || nowOf(branch) < pending.node.tick) return null;
  const bot = branch.bots[pending.node.botId];
  return (
    <div className="decision-panel">
      <div className="dp-head">
        <span className="hero-tag">✎ 人生节点</span>
        <b>{bot?.name}</b>
        <span className="muted">{pending.node.situation}</span>
      </div>
      <div className="dp-options">
        {pending.node.options.map((o) => (
          <button key={o.id} onClick={() => resolve(o.id)}>
            <b>{o.label}</b>
            <span>{o.description}</span>
          </button>
        ))}
      </div>
      <div className="dp-foot">
        <button className="ghost" onClick={ask}>让 TA 自己决定（问模型）</button>
      </div>
    </div>
  );
}
