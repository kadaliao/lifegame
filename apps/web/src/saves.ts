/** 存档放在浏览器的 IndexedDB 里：每条记录是一份完整的 SaveFile，可以导出成 JSON 文件 */
import type { SaveFile } from './protocol.js';

export interface SaveRecord {
  id: string;
  name: string;
  savedAt: string;
  file: SaveFile;
}

export type SaveMeta = Omit<SaveRecord, 'file'> & { meta: SaveFile['meta']; size: number };

export const AUTOSAVE_ID = 'autosave';
const DB = 'lifegame';
const STORE = 'saves';

let dbp: Promise<IDBDatabase> | undefined;
function db(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = fn(d.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putSave(rec: SaveRecord): Promise<void> {
  await tx('readwrite', (s) => s.put(rec));
}

export async function getSave(id: string): Promise<SaveRecord | undefined> {
  return tx('readonly', (s) => s.get(id) as IDBRequest<SaveRecord | undefined>);
}

export async function deleteSave(id: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(id));
}

export async function listSaves(): Promise<SaveMeta[]> {
  const all = await tx('readonly', (s) => s.getAll() as IDBRequest<SaveRecord[]>);
  return all
    .map((r) => ({ id: r.id, name: r.name, savedAt: r.savedAt, meta: r.file.meta, size: JSON.stringify(r.file).length }))
    .sort((a, b) => (a.id === AUTOSAVE_ID ? -1 : b.id === AUTOSAVE_ID ? 1 : b.savedAt.localeCompare(a.savedAt)));
}

export function isSaveFile(x: unknown): x is SaveFile {
  const f = x as SaveFile;
  return !!f && f.format === 'lifegame-save' && f.version === 1 && Array.isArray(f.branches) && !!f.config;
}

export function downloadSave(rec: SaveRecord): void {
  const blob = new Blob([JSON.stringify(rec.file)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `人生游戏-${rec.file.meta.year}年-${rec.name.replace(/[\\/:*?"<>|]/g, '_')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
