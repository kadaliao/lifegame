import { useRef, useState } from 'react';
import { useStore } from '../store.js';
import { AUTOSAVE_ID } from '../saves.js';

export function SavesPanel() {
  const open = useStore((s) => s.savesOpen);
  const setOpen = useStore((s) => s.setSavesOpen);
  const saves = useStore((s) => s.saves);
  const saveWorld = useStore((s) => s.saveWorld);
  const loadSave = useStore((s) => s.loadSave);
  const removeSave = useStore((s) => s.removeSave);
  const exportSave = useStore((s) => s.exportSave);
  const importSave = useStore((s) => s.importSave);
  const year = useStore((s) => {
    const br = s.branches[s.activeBranch];
    return br && s.config ? s.config.startYear + Math.floor(Math.min(br.displayTick, br.frontier) / 12) : undefined;
  });
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState<string>();
  const fileRef = useRef<HTMLInputElement>(null);
  if (!open) return null;

  const doSave = async () => {
    setBusy(true);
    try { await saveWorld(name.trim() || `${year ?? ''}年的世界`); setName(''); } finally { setBusy(false); }
  };

  return (
    <div className="modal-bg" onClick={() => setOpen(false)}>
      <div className="modal saves" onClick={(e) => e.stopPropagation()}>
        <h2>存档</h2>
        <p className="muted small">存档只记种子、谁有智能、以及每个人生节点上的答案。读档时整个世界从头重放到存档那一刻，不会再调用模型，几秒就好。</p>
        <div className="save-new">
          <input placeholder={`${year ?? ''}年的世界`} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void doSave(); }} />
          <button className="primary" disabled={busy || year === undefined} onClick={() => void doSave()}>{busy ? '保存中…' : '保存当前世界'}</button>
          <button className="ghost" onClick={() => fileRef.current?.click()}>导入存档文件</button>
          <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importSave(f); e.target.value = ''; }} />
        </div>
        <ul className="save-list">
          {saves.length === 0 && <li className="muted small">还没有存档。</li>}
          {saves.map((sv) => (
            <li key={sv.id}>
              <div className="save-main">
                <b>{sv.id === AUTOSAVE_ID ? '自动存档' : sv.name}</b>
                <span className="muted small">
                  {sv.meta.year} 年 · {sv.meta.eraName}{sv.meta.branches > 1 ? ` · ${sv.meta.branches} 个分支` : ''}
                  {sv.meta.heroes.length ? ` · 主角 ${sv.meta.heroes.slice(0, 4).join('、')}${sv.meta.heroes.length > 4 ? ' 等' : ''}` : ''}
                </span>
                <span className="muted small">{new Date(sv.savedAt).toLocaleString('zh-CN', { hour12: false })} · {(sv.size / 1024).toFixed(0)} KB</span>
              </div>
              <div className="save-actions">
                <button className="primary" onClick={() => void loadSave(sv.id)}>读取</button>
                <button className="ghost" onClick={() => void exportSave(sv.id)} title="下载成 JSON 文件，可以发给别人导入">导出</button>
                {confirmDel === sv.id
                  ? <button className="danger" onClick={() => { void removeSave(sv.id); setConfirmDel(undefined); }}>确认删除</button>
                  : <button className="ghost" onClick={() => setConfirmDel(sv.id)}>删除</button>}
              </div>
            </li>
          ))}
        </ul>
        <div className="modal-foot">
          <button className="ghost" onClick={() => setOpen(false)}>关闭</button>
        </div>
      </div>
    </div>
  );
}
