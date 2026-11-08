import { useEffect, useRef } from 'react';
import { Application, Container, Graphics, TextStyle } from 'pixi.js';
import type { BotSummary } from '@lifegame/core';
import { getEra } from '@lifegame/eras';
import type { WorldEvent } from '@lifegame/schema';
import { useStore, type BranchData } from '../store.js';
import { eduLabel } from '../util.js';
import { STAGES, STAGE_COLOR, STAGE_LABEL, TextPool, clamp, css, hex, stageStarts, stageTable } from './pixi-util.js';

// ---------- 版面常量 ----------
const RULER_H = 24;
const EVENT_ROW_H = 19;
const EVENT_ROWS = 3;
const HEADER_H = RULER_H + EVENT_ROWS * EVENT_ROW_H + 8;
const LANE = 24;
const BLOCK_HEAD = 30;
const BLOCK_GAP = 22;
const COUPLE = 2.5;
const CROWD_HEAD = 30;
const STREAM_H = 180;
const CROWD_LANE = 6;
const STEP = 6;
const MARKER_SKIP = new Set(['marriage', 'child', 'birth', 'stage', 'death', 'move']);

// ---------- 事件索引（增量） ----------
interface Index {
  branchId: string;
  len: number;
  byBot: Map<string, WorldEvent[]>;
  marriages: Map<string, Array<{ id: string; tick: number }>>;
  world: WorldEvent[];
}

function updateIndex(idx: Index | undefined, branch: BranchData): Index {
  if (!idx || idx.branchId !== branch.info.id || branch.events.length < idx.len) {
    idx = { branchId: branch.info.id, len: 0, byBot: new Map(), marriages: new Map(), world: [] };
  }
  const evs = branch.events;
  for (let i = idx.len; i < evs.length; i++) {
    const e = evs[i];
    if (e.type === 'world') { idx.world.push(e); continue; }
    if (!e.botId) continue;
    let arr = idx.byBot.get(e.botId);
    if (!arr) idx.byBot.set(e.botId, (arr = []));
    arr.push(e);
    if (e.type === 'marriage' && e.relatedIds?.[0] && e.text.endsWith('结婚了。')) {
      let m = idx.marriages.get(e.botId);
      if (!m) idx.marriages.set(e.botId, (m = []));
      m.push({ id: e.relatedIds[0], tick: e.tick });
    }
  }
  idx.len = evs.length;
  return idx;
}

// ---------- 家族版面 ----------
interface Trans { t0: number; t1: number; from: number; to: number }
interface FocusLine { id: string; y0: number; start: number; trans: Trans[]; block: number }
interface Block { rootId: string; members: string[]; top: number }
interface Layout { lines: Map<string, FocusLine>; blocks: Block[]; crowdTop: number }

function yAt(f: FocusLine, t: number): number {
  let y = f.start;
  for (const tr of f.trans) {
    if (t >= tr.t1) { y = tr.to; continue; }
    if (t > tr.t0) {
      const k = (t - tr.t0) / (tr.t1 - tr.t0);
      return tr.from + (tr.to - tr.from) * k * k * (3 - 2 * k);
    }
    return y;
  }
  return y;
}

/**
 * 主角和选中者所在的家族各占一块：根是最上一代的父系祖先，
 * 往下依次是本人、配偶、子女（子女再带配偶和孙辈）。
 * 婚后两条线并成一股，孩子从母亲的线上分出来。
 */
function buildLayout(bots: Record<string, BotSummary>, order: string[], idx: Index, selected: string | undefined, shown: number): Layout {
  const spousesOf = (id: string) => (idx.marriages.get(id) ?? []).filter((m) => m.tick <= shown && bots[m.id]).sort((a, b) => a.tick - b.tick);
  const rootOf = (id: string) => {
    let cur = id;
    for (let i = 0; i < 12; i++) {
      const p = bots[cur]?.parentIds.find((x) => bots[x]);
      if (!p) break;
      cur = p;
    }
    return cur;
  };
  const visited = new Set<string>();
  const collect = (root: string): string[] => {
    const out: string[] = [];
    const dfs = (id: string, isRoot: boolean) => {
      const b = bots[id];
      if (!b || visited.has(id)) return;
      if (!isRoot && b.birthTick > shown) return;
      visited.add(id);
      out.push(id);
      const sps = spousesOf(id);
      for (const s of sps) {
        if (!visited.has(s.id)) { visited.add(s.id); out.push(s.id); }
      }
      const kids = new Set(b.childrenIds);
      for (const s of sps) for (const k of bots[s.id]?.childrenIds ?? []) kids.add(k);
      [...kids].filter((k) => bots[k]).sort((a, c) => bots[a].birthTick - bots[c].birthTick).forEach((k) => dfs(k, false));
    };
    dfs(root, true);
    return out;
  };

  const groups: Array<{ root: string; members: string[] }> = [];
  const addGroup = (id: string, front: boolean) => {
    let root = rootOf(id);
    let m = collect(root);
    if (!m.length) { root = id; m = collect(id); }
    if (m.length) {
      if (front) groups.unshift({ root, members: m });
      else groups.push({ root, members: m });
    }
  };
  // 已经出现在别家块里的主角（如外孙）不再另开一块
  for (const id of order) {
    if (bots[id]?.intelligence === 'llm' && !visited.has(id)) addGroup(id, false);
  }
  if (selected && bots[selected] && !visited.has(selected)) addGroup(selected, true);

  const lines = new Map<string, FocusLine>();
  const blocks: Block[] = [];
  let y = 8;
  for (const [bi, g] of groups.entries()) {
    const top = y;
    y += BLOCK_HEAD;
    for (const id of g.members) {
      lines.set(id, { id, y0: y + LANE / 2, start: y + LANE / 2, trans: [], block: bi });
      y += LANE;
    }
    blocks.push({ rootId: g.root, members: g.members, top });
    y += BLOCK_GAP;
  }
  // 成员顺序保证父母先于子女，配偶紧随本人
  for (const g of groups) {
    for (const id of g.members) {
      const f = lines.get(id)!;
      const b = bots[id];
      // 只在同一块里画出生和婚姻的连接，跨块的曲线会穿过别人家
      const mom = [lines.get(b.parentIds[1]), lines.get(b.parentIds[0])].find((x) => x && x.block === f.block);
      if (mom) {
        const s = yAt(mom, b.birthTick);
        f.start = s;
        f.trans.push({ t0: b.birthTick, t1: b.birthTick + 30, from: s, to: f.y0 });
      }
      for (const m of spousesOf(id)) {
        const p = lines.get(m.id);
        if (!p || p.block !== f.block) continue;
        const to = (f.y0 + p.y0) / 2 + (f.y0 < p.y0 ? -COUPLE : COUPLE);
        f.trans.push({ t0: m.tick, t1: m.tick + 12, from: yAt(f, m.tick), to });
      }
    }
  }
  return { lines, blocks, crowdTop: y + 4 };
}

// ---------- 人群之河 ----------
interface Stream {
  key: string;
  n: number;
  counts: Float32Array[];
  totals: Float32Array;
  max: number;
}

function computeStream(bots: Record<string, BotSummary>, order: string[], shown: number, table: Uint8Array): Omit<Stream, 'key'> {
  const n = Math.floor(shown / STEP) + 1;
  const counts = STAGES.map(() => new Float32Array(n));
  const totals = new Float32Array(n);
  for (const id of order) {
    const b = bots[id];
    if (b.birthTick > shown) continue;
    const death = b.deathTick ?? Infinity;
    for (let k = Math.ceil(b.birthTick / STEP); k < n && k * STEP < death; k++) {
      const age = Math.floor((k * STEP - b.birthTick) / 12);
      counts[table[Math.min(130, age)]][k]++;
      totals[k]++;
    }
  }
  let max = 1;
  for (let k = 0; k < n; k++) if (totals[k] > max) max = totals[k];
  return { n, counts, totals, max };
}

// ---------- 组件 ----------
interface Props {
  branch: BranchData;
  playing: boolean;
  viewTick?: number;
  selected?: string;
  thinking: Record<string, string>;
  startYear: number;
  endYear: number;
  eraId: string;
  paper: number;
  ink: number;
  accent: number;
}

interface Styles {
  key: string;
  year: TextStyle; pill: TextStyle; pillSpec: TextStyle;
  blockTitle: TextStyle; meta: TextStyle;
  name: TextStyle; nameHero: TextStyle; nameSel: TextStyle; nameMuted: TextStyle;
  stage: TextStyle;
}

function makeStyles(ink: number, accent: number): Styles {
  const sans = 'Noto Sans SC, PingFang SC, sans-serif';
  const serif = 'Noto Serif SC, Songti SC, serif';
  const muted = 0x8a8178;
  return {
    key: `${ink}-${accent}`,
    year: new TextStyle({ fontFamily: sans, fontSize: 11, fill: muted }),
    pill: new TextStyle({ fontFamily: serif, fontSize: 11, fill: accent, fontWeight: '600' }),
    pillSpec: new TextStyle({ fontFamily: serif, fontSize: 11, fill: muted, fontStyle: 'italic' }),
    blockTitle: new TextStyle({ fontFamily: serif, fontSize: 14, fill: ink, fontWeight: '700' }),
    meta: new TextStyle({ fontFamily: sans, fontSize: 11, fill: muted }),
    name: new TextStyle({ fontFamily: sans, fontSize: 11, fill: ink }),
    nameHero: new TextStyle({ fontFamily: sans, fontSize: 11.5, fill: ink, fontWeight: '700' }),
    nameSel: new TextStyle({ fontFamily: sans, fontSize: 12.5, fill: accent, fontWeight: '700' }),
    nameMuted: new TextStyle({ fontFamily: sans, fontSize: 11, fill: muted }),
    stage: new TextStyle({ fontFamily: sans, fontSize: 11, fill: ink, fontWeight: '500' }),
  };
}

interface Marker { x: number; y: number; r: number; botId: string; html: string }
interface Pill { x0: number; y0: number; x1: number; y1: number; html: string }

interface Runtime {
  app: Application;
  content: Container;
  grid: Graphics;
  stream: Graphics;
  crowd: Graphics;
  lines: Graphics;
  marks: Graphics;
  header: Graphics;
  cursor: Graphics;
  pool: TextPool;
  hpool: TextPool;
  view: { px: number; ox: number; sy: number; fitted: boolean; userZoomed: boolean; lastW: number; minPx: number };
  idx?: Index;
  streamData?: Stream;
  styles?: Styles;
  table?: Uint8Array;
  lastSelected?: string;
  geom?: {
    layout: Layout;
    markers: Marker[];
    pills: Pill[];
    shown: number;
    streamTop: number;
    yc: number;
    scale: number;
    blend: number;
    crowdIds: string[];
  };
}

export function TimeRiver({ branch }: { branch: BranchData }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const rtRef = useRef<Runtime>();
  const dirtyRef = useRef(true);
  const propsRef = useRef<Props>();

  const viewTick = useStore((s) => s.viewTick);
  const playing = useStore((s) => s.playing);
  const selected = useStore((s) => s.selectedBot);
  const thinking = useStore((s) => s.thinking);
  const config = useStore((s) => s.config)!;
  const theme = useStore((s) => s.era?.theme);
  const selectBot = useStore((s) => s.selectBot);

  propsRef.current = {
    branch, playing, viewTick, selected, thinking,
    startYear: config.startYear, endYear: config.endYear, eraId: config.eraId,
    paper: hex(theme?.paper ?? '#f6f1e7'), ink: hex(theme?.ink ?? '#2b2622'), accent: hex(theme?.accent ?? '#c8362f'),
  };
  dirtyRef.current = true;

  useEffect(() => {
    const host = hostRef.current!;
    let destroyed = false;
    const app = new Application();
    app.init({ backgroundAlpha: 0, resizeTo: host, antialias: true, resolution: Math.min(2, window.devicePixelRatio || 1), autoDensity: true }).then(() => {
      if (destroyed) { app.destroy(true); return; }
      host.appendChild(app.canvas);
      const content = new Container();
      const grid = new Graphics();
      const stream = new Graphics();
      const crowd = new Graphics();
      const lines = new Graphics();
      const marks = new Graphics();
      const ctext = new Container();
      content.addChild(grid, stream, crowd, lines, marks, ctext);
      const headerC = new Container();
      const header = new Graphics();
      const htext = new Container();
      headerC.addChild(header, htext);
      const cursor = new Graphics();
      app.stage.addChild(content, headerC, cursor);
      rtRef.current = {
        app, content, grid, stream, crowd, lines, marks, header, cursor,
        pool: new TextPool(ctext), hpool: new TextPool(htext),
        view: { px: 1, ox: 20, sy: 0, fitted: false, userZoomed: false, lastW: 0, minPx: 0.2 },
      };
      app.ticker.add(() => {
        const p = propsRef.current;
        if (p && Object.keys(p.thinking).length) dirtyRef.current = true;
        if (dirtyRef.current && rtRef.current && p) {
          dirtyRef.current = false;
          draw(rtRef.current, p);
        }
      });
    });

    // ---------- 交互 ----------
    let drag: { x: number; y: number; ox: number; sy: number; moved: boolean } | null = null;
    const onWheel = (ev: WheelEvent) => {
      const rt = rtRef.current;
      if (!rt) return;
      ev.preventDefault();
      const v = rt.view;
      const rect = host.getBoundingClientRect();
      if (ev.ctrlKey || ev.metaKey) {
        const mx = ev.clientX - rect.left;
        const t = (mx - v.ox) / v.px;
        v.px = clamp(v.px * Math.exp(-ev.deltaY * 0.002), v.minPx, 40);
        v.ox = mx - t * v.px;
        v.userZoomed = true;
      } else {
        v.ox -= ev.deltaX;
        v.sy = Math.max(0, v.sy + ev.deltaY);
      }
      dirtyRef.current = true;
    };
    const onDown = (ev: PointerEvent) => {
      const rt = rtRef.current;
      if (!rt) return;
      drag = { x: ev.clientX, y: ev.clientY, ox: rt.view.ox, sy: rt.view.sy, moved: false };
    };
    const onMove = (ev: PointerEvent) => {
      const rt = rtRef.current;
      if (!rt) return;
      const rect = host.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      const my = ev.clientY - rect.top;
      if (drag && (ev.buttons & 1)) {
        const dx = ev.clientX - drag.x;
        const dy = ev.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        rt.view.ox = drag.ox + dx;
        rt.view.sy = Math.max(0, drag.sy - dy);
        dirtyRef.current = true;
        hideTip();
        return;
      }
      const hit = hitTest(rt, mx, my);
      const tip = tooltipRef.current!;
      if (hit) {
        tip.style.display = 'block';
        tip.innerHTML = hit.html;
        const tw = tip.offsetWidth;
        tip.style.left = `${Math.min(mx + 14, rect.width - tw - 8)}px`;
        tip.style.top = `${my + 16}px`;
        host.style.cursor = hit.botId ? 'pointer' : 'default';
      } else {
        hideTip();
        host.style.cursor = 'grab';
      }
    };
    const onUp = (ev: PointerEvent) => {
      const rt = rtRef.current;
      const d = drag;
      drag = null;
      if (!rt || (d && d.moved)) return;
      const rect = host.getBoundingClientRect();
      const hit = hitTest(rt, ev.clientX - rect.left, ev.clientY - rect.top);
      if (hit?.botId) selectBot(hit.botId);
    };
    const onDbl = () => {
      const rt = rtRef.current;
      if (!rt) return;
      rt.view.fitted = false;
      rt.view.userZoomed = false;
      dirtyRef.current = true;
    };
    const hideTip = () => { if (tooltipRef.current) tooltipRef.current.style.display = 'none'; };

    host.addEventListener('wheel', onWheel, { passive: false });
    host.addEventListener('pointerdown', onDown);
    host.addEventListener('pointermove', onMove);
    host.addEventListener('pointerup', onUp);
    host.addEventListener('pointerleave', hideTip);
    host.addEventListener('dblclick', onDbl);
    const ro = new ResizeObserver(() => { dirtyRef.current = true; });
    ro.observe(host);
    return () => {
      destroyed = true;
      ro.disconnect();
      host.removeEventListener('wheel', onWheel);
      host.removeEventListener('pointerdown', onDown);
      host.removeEventListener('pointermove', onMove);
      host.removeEventListener('pointerup', onUp);
      host.removeEventListener('pointerleave', hideTip);
      host.removeEventListener('dblclick', onDbl);
      rtRef.current?.app.destroy(true, { children: true });
      rtRef.current = undefined;
    };

    function hitTest(rt: Runtime, mx: number, my: number): { html: string; botId?: string } | undefined {
      const g = rt.geom;
      const p = propsRef.current;
      if (!g || !p) return undefined;
      const v = rt.view;
      const bots = p.branch.bots;
      if (my < HEADER_H) {
        for (const pl of g.pills) if (mx >= pl.x0 && mx <= pl.x1 && my >= pl.y0 && my <= pl.y1) return { html: pl.html };
        return undefined;
      }
      const cy = my - HEADER_H + v.sy;
      const t = (mx - v.ox) / v.px;
      for (const m of g.markers) {
        if (Math.hypot(m.x - mx, m.y - cy) <= m.r + 4) return { html: m.html, botId: m.botId };
      }
      let best: { id: string; d: number } | undefined;
      for (const [id, f] of g.layout.lines) {
        const b = bots[id];
        if (!b || t < b.birthTick - 3 || t > Math.min(g.shown, b.deathTick ?? Infinity) + 3) continue;
        const d = Math.abs(yAt(f, t) - cy);
        if (d < 8 && (!best || d < best.d)) best = { id, d };
      }
      if (best) return { html: botTip(bots[best.id], t, p.startYear), botId: best.id };
      if (cy >= g.streamTop) {
        if (g.blend >= 0.5) {
          const i = Math.floor((cy - g.streamTop) / CROWD_LANE);
          const id = g.crowdIds[i];
          const b = id ? bots[id] : undefined;
          if (b && t >= b.birthTick && t <= Math.min(g.shown, b.deathTick ?? Infinity)) return { html: botTip(b, t, p.startYear), botId: id };
        } else if (rt.streamData) {
          const k = Math.round(t / STEP);
          const s = rt.streamData;
          if (k >= 0 && k < s.n && s.totals[k] > 0) {
            let y = g.yc - (s.totals[k] * g.scale) / 2;
            for (let si = 0; si < STAGES.length; si++) {
              const c = s.counts[si][k];
              if (cy >= y && cy < y + c * g.scale) {
                return { html: `<b>${p.startYear + Math.floor((k * STEP) / 12)}年 · ${STAGE_LABEL[STAGES[si]]}</b> ${c} 人<br/><span class="muted">在世 ${s.totals[k]} 人 · 拉近可看到每个人</span>` };
              }
              y += c * g.scale;
            }
          }
        }
      }
      return undefined;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="river" ref={hostRef}>
      <div className="tooltip" ref={tooltipRef} />
      <div className="river-legend">
        {STAGES.map((k) => (
          <span key={k}><i style={{ background: css(STAGE_COLOR[k]) }} />{STAGE_LABEL[k]}</span>
        ))}
        <span className="sep" />
        <span><i className="diamond" />人生抉择</span>
        <span><i className="dot" />大事</span>
        <span className="muted">滚动浏览 · ⌘/Ctrl+滚轮缩放 · 双击复位</span>
      </div>
    </div>
  );
}

function botTip(b: BotSummary, t: number, startYear: number): string {
  const end = Math.min(t, b.deathTick ?? t);
  const age = Math.max(0, Math.floor((end - b.birthTick) / 12));
  const life = b.deathTick !== undefined ? ` · 卒于${startYear + Math.floor(b.deathTick / 12)}` : '';
  return `<b>${b.name}</b> <span class="muted">${b.sex === 'male' ? '男' : '女'} · ${startYear + Math.floor(b.birthTick / 12)}年生${life}</span><br/>${age}岁 · ${b.jobTitle ?? eduLabel(b.education)} · ${b.city}${b.intelligence === 'llm' ? '<br/><span class="hero-tag">✦ 智能人格</span>' : ''}`;
}

function eventTip(e: WorldEvent, startYear: number, birthTick?: number): string {
  const year = startYear + Math.floor(e.tick / 12);
  const age = birthTick !== undefined ? ` · ${Math.floor((e.tick - birthTick) / 12)}岁` : '';
  return `<span class="muted">${year}年${age}</span><br/>${e.text}`;
}

// ---------- 绘制 ----------
function draw(rt: Runtime, p: Props): void {
  const { app, view: v } = rt;
  const W = app.screen.width;
  const H = app.screen.height;
  if (W < 50 || H < 50) return;
  const { branch, selected, thinking } = p;
  const bots = branch.bots;
  const era = getEra(p.eraId);
  if (!rt.table) rt.table = stageTable((a) => era.stageOf(a));
  const table = rt.table;
  const starts = stageStarts(table);
  if (!rt.styles || rt.styles.key !== `${p.ink}-${p.accent}`) rt.styles = makeStyles(p.ink, p.accent);
  const S = rt.styles;

  const nowTick = branch.summary?.tick ?? 0;
  const shown = Math.min(p.viewTick ?? nowTick, nowTick);
  const maxTick = (p.endYear - p.startYear) * 12;

  // 水平：默认把整个时代铺满
  if (!v.fitted || (!v.userZoomed && v.lastW !== W)) {
    v.px = (W - 64) / maxTick;
    v.ox = 20;
    v.minPx = v.px * 0.8;
    v.fitted = true;
    v.lastW = W;
  }
  if (p.playing && p.viewTick === undefined && v.userZoomed) {
    const x = v.ox + nowTick * v.px;
    if (x > W - 60) v.ox -= x - (W - 60);
  }
  const xOf = (t: number) => v.ox + t * v.px;
  const tAt = (x: number) => (x - v.ox) / v.px;
  const tL = Math.max(0, Math.floor(tAt(-20)));
  const tR = Math.ceil(tAt(W + 20));
  const yearPx = v.px * 12;

  rt.idx = updateIndex(rt.idx, branch);
  const idx = rt.idx;
  const layout = buildLayout(bots, branch.botOrder, idx, selected, shown);

  // 选中的人进入视野
  if (selected !== rt.lastSelected) {
    rt.lastSelected = selected;
    const f = selected ? layout.lines.get(selected) : undefined;
    if (f && (f.y0 < v.sy + 30 || f.y0 > v.sy + H - HEADER_H - 40)) v.sy = Math.max(0, f.y0 - 90);
  }

  // 人群之河数据（缓存）
  const streamKey = `${branch.info.id}|${branch.botOrder.length}|${Math.floor(shown / STEP)}|${idx.len}`;
  if (!rt.streamData || rt.streamData.key !== streamKey) rt.streamData = { key: streamKey, ...computeStream(bots, branch.botOrder, shown, table) };
  const stream = rt.streamData;

  // 语义缩放：一年宽于 26px 开始展开成个人
  const blend = clamp((yearPx - 26) / 22, 0, 1);
  const crowdTop = layout.crowdTop;
  const streamTop = crowdTop + CROWD_HEAD;
  let crowdIds: string[] = [];
  if (blend > 0) {
    crowdIds = branch.botOrder
      .filter((id) => {
        const b = bots[id];
        if (layout.lines.has(id) || b.birthTick > shown) return false;
        const end = Math.min(b.deathTick ?? Infinity, shown);
        return b.birthTick <= tR && end >= tL;
      })
      .sort((a, c) => bots[a].birthTick - bots[c].birthTick);
  }
  const crowdH = Math.max(STREAM_H * (1 - blend), crowdIds.length * CROWD_LANE * blend) + 30;
  const contentH = streamTop + crowdH;
  const viewH = H - HEADER_H;
  v.sy = clamp(v.sy, 0, Math.max(0, contentH - viewH));
  rt.content.y = HEADER_H - v.sy;
  const visTop = v.sy - 20;
  const visBot = v.sy + viewH + 20;

  rt.pool.begin();
  rt.hpool.begin();

  // ---- 网格 ----
  const grid = rt.grid;
  grid.clear();
  const yearStep = yearPx < 6 ? 10 : yearPx < 14 ? 5 : yearPx < 40 ? 2 : 1;
  const firstYear = Math.max(0, Math.floor(tL / 12 / yearStep) * yearStep);
  for (let y = firstYear; y * 12 <= Math.min(tR, maxTick); y += yearStep) {
    const x = xOf(y * 12);
    const decade = (p.startYear + y) % 10 === 0;
    grid.moveTo(x, visTop).lineTo(x, visBot).stroke({ color: p.ink, alpha: decade ? 0.07 : 0.035, width: 1 });
  }
  for (const e of idx.world) {
    if (e.tick > shown || e.tick < tL || e.tick > tR) continue;
    const x = xOf(e.tick);
    grid.moveTo(x, visTop).lineTo(x, visBot).stroke({ color: p.accent, alpha: 0.07, width: 1 });
  }

  // ---- 家族块 ----
  const lg = rt.lines;
  const mg = rt.marks;
  lg.clear();
  mg.clear();
  const markers: Marker[] = [];
  for (const blk of layout.blocks) {
    if (blk.top > visBot || blk.top + BLOCK_HEAD + blk.members.length * LANE < visTop) continue;
    grid.moveTo(0, blk.top).lineTo(W, blk.top).stroke({ color: p.ink, alpha: 0.08, width: 1 });
    const root = bots[blk.rootId];
    const title = rt.pool.get(`bt:${blk.rootId}`, `${root.name}一家`, S.blockTitle);
    title.anchor.set(0, 0);
    title.x = 14;
    title.y = blk.top + 7;
    const gens = new Set(blk.members.map((id) => bots[id].generation)).size;
    const alive = blk.members.filter((id) => bots[id].birthTick <= shown && (bots[id].deathTick ?? Infinity) > shown).length;
    const meta = rt.pool.get(`bm:${blk.rootId}`, `${gens}代 · ${blk.members.length}人 · 在世${alive}`, S.meta);
    meta.anchor.set(0, 0);
    meta.x = 14 + title.width + 8;
    meta.y = blk.top + 9;
  }

  const pathStep = Math.max(1, Math.round(2.5 / v.px));
  const strokeRange = (f: FocusLine, a: number, b: number, style: Parameters<Graphics['stroke']>[0]) => {
    lg.moveTo(xOf(a), yAt(f, a));
    for (let t = a + pathStep; t < b; t += pathStep) lg.lineTo(xOf(t), yAt(f, t));
    lg.lineTo(xOf(b), yAt(f, b));
    lg.stroke(style);
  };
  const pulse = (Math.sin(performance.now() / 220) + 1) / 2;

  for (const [id, f] of layout.lines) {
    const b = bots[id];
    if (f.y0 < visTop - 40 || f.y0 > visBot + 40) {
      // 婚后可能离开自己的车道，但偏移只有几个像素，可以安全跳过
      continue;
    }
    const isSel = id === selected;
    const isHero = b.intelligence === 'llm';
    const style = isSel ? S.nameSel : isHero ? S.nameHero : S.name;
    if (b.birthTick > shown) {
      const x = xOf(b.birthTick);
      lg.circle(x, f.y0, 3).stroke({ color: p.ink, alpha: 0.35, width: 1 });
      const t = rt.pool.get(`n:${id}`, `${b.name} · ${p.startYear + Math.floor(b.birthTick / 12)}年出生`, S.nameMuted);
      t.anchor.set(0, 0.5);
      t.x = Math.max(8, x + 7);
      t.y = f.y0;
      continue;
    }
    const end = Math.min(shown, b.deathTick ?? Infinity);
    const t0 = Math.max(b.birthTick, tL);
    const t1 = Math.min(end, tR);
    if (t1 > t0) {
      const width = isSel ? 3.6 : isHero ? 2.6 : 1.7;
      const alpha = isSel || isHero ? 1 : 0.75;
      if (isSel) strokeRange(f, t0, t1, { color: p.accent, alpha: 0.16, width: 11, cap: 'round', join: 'round' });
      for (let i = 0; i < starts.length; i++) {
        const segA = Math.max(t0, b.birthTick + starts[i].age * 12);
        const segB = Math.min(t1, i + 1 < starts.length ? b.birthTick + starts[i + 1].age * 12 : Infinity);
        if (segB <= segA) continue;
        strokeRange(f, segA, segB, { color: STAGE_COLOR[STAGES[starts[i].si]], alpha, width, cap: 'round', join: 'round' });
      }
    }
    // 终点
    if (b.deathTick !== undefined && b.deathTick <= shown) {
      const x = xOf(b.deathTick);
      if (x > -10 && x < W + 10) {
        const y = yAt(f, b.deathTick);
        mg.circle(x, y, 3.6).fill({ color: p.ink });
        const death = idx.byBot.get(id)?.find((e) => e.type === 'death');
        if (death) markers.push({ x, y, r: 4, botId: id, html: eventTip(death, p.startYear, b.birthTick) });
      }
    } else if (thinking[id]) {
      const x = xOf(end);
      const y = yAt(f, end);
      mg.circle(x, y, 4).fill({ color: p.accent });
      mg.circle(x, y, 7 + pulse * 6).stroke({ color: p.accent, alpha: 0.5 - pulse * 0.4, width: 2 });
    }
    // 人生节点
    for (const e of idx.byBot.get(id) ?? []) {
      if (e.tick > shown || e.tick < tL || e.tick > tR || e.importance < 7 || MARKER_SKIP.has(e.type)) continue;
      const x = xOf(e.tick);
      const y = yAt(f, e.tick);
      if (e.type === 'decision') {
        const r = isSel ? 5 : 4;
        mg.poly([x, y - r, x + r, y, x, y + r, x - r, y]).fill({ color: p.accent }).stroke({ color: p.paper, width: 1 });
      } else {
        mg.circle(x, y, 2.8).fill({ color: p.paper }).stroke({ color: p.ink, width: 1.2, alpha: 0.8 });
      }
      markers.push({ x, y, r: 4, botId: id, html: eventTip(e, p.startYear, b.birthTick) });
    }
    // 名字：标在自己的车道上（孩子等曲线落定后再标），滚出视野时贴在左边
    const settled = f.start !== f.y0 && b.birthTick + 30 <= end ? b.birthTick + 30 : b.birthTick;
    const bx = xOf(settled);
    const lx = bx < 10 ? 10 : bx + 5;
    const lt = bx < 10 ? tAt(10) : settled;
    if (lt <= end) {
      const yNow = yAt(f, lt);
      const above = yNow >= f.y0 - 0.01;
      const name = rt.pool.get(`n:${id}`, isHero ? `${b.name} ✦` : b.name, style);
      name.anchor.set(0, above ? 1 : 0);
      name.x = lx;
      name.y = above ? yNow - 3 : yNow + 3;
    }
  }

  // ---- 众人 ----
  const sg = rt.stream;
  const cg = rt.crowd;
  sg.clear();
  cg.clear();
  grid.moveTo(0, crowdTop).lineTo(W, crowdTop).stroke({ color: p.ink, alpha: 0.08, width: 1 });
  const aliveNow = stream.n > 0 ? stream.totals[Math.min(stream.n - 1, Math.floor(shown / STEP))] : 0;
  const ct = rt.pool.get('crowd:title', '众人', S.blockTitle);
  ct.anchor.set(0, 0);
  ct.x = 14;
  ct.y = crowdTop + 7;
  const cm = rt.pool.get('crowd:meta', `在世 ${aliveNow} 人 · ${blend < 0.5 ? '按人生阶段汇成的河，拉近到十年可看到每个人' : '每条线是一个人，点击查看'}`, S.meta);
  cm.anchor.set(0, 0);
  cm.x = 14 + ct.width + 8;
  cm.y = crowdTop + 9;

  const yc = streamTop + STREAM_H / 2;
  const scale = (STREAM_H - 16) / stream.max;
  if (blend < 1 && stream.n > 1) {
    const kL = Math.max(0, Math.floor(tL / STEP));
    const kR = Math.min(stream.n - 1, Math.ceil(tR / STEP));
    const cum = new Float32Array(stream.n);
    for (let si = 0; si < STAGES.length; si++) {
      const c = stream.counts[si];
      const top: number[] = [];
      const bot: number[] = [];
      let best = -1;
      let bestC = 0;
      for (let k = kL; k <= kR; k++) {
        const base = yc - (stream.totals[k] * scale) / 2 + cum[k] * scale;
        const x = xOf(k * STEP);
        top.push(x, base);
        bot.push(x, base + c[k] * scale);
        if (c[k] > bestC && x > 60 && x < W - 60) { bestC = c[k]; best = k; }
      }
      if (bestC > 0) {
        const poly = top.slice();
        for (let i = bot.length - 2; i >= 0; i -= 2) poly.push(bot[i], bot[i + 1]);
        sg.poly(poly).fill({ color: STAGE_COLOR[STAGES[si]], alpha: 0.8 * (1 - blend) });
        if (bestC * scale >= 13 && blend < 0.5) {
          const lbl = rt.pool.get(`sl:${si}`, STAGE_LABEL[STAGES[si]], S.stage);
          lbl.anchor.set(0.5, 0.5);
          lbl.x = xOf(best * STEP);
          lbl.y = yc - (stream.totals[best] * scale) / 2 + (cum[best] + bestC / 2) * scale;
          lbl.alpha = 0.7 * (1 - blend * 2);
        }
      }
      for (let k = kL; k <= kR; k++) cum[k] += c[k];
    }
  }
  if (blend > 0) {
    for (let i = 0; i < crowdIds.length; i++) {
      const y = streamTop + i * CROWD_LANE + CROWD_LANE / 2;
      if (y < visTop || y > visBot) continue;
      const b = bots[crowdIds[i]];
      const end = Math.min(shown, b.deathTick ?? Infinity);
      const a0 = Math.max(b.birthTick, tL);
      const a1 = Math.min(end, tR);
      for (let s = 0; s < starts.length; s++) {
        const segA = Math.max(a0, b.birthTick + starts[s].age * 12);
        const segB = Math.min(a1, s + 1 < starts.length ? b.birthTick + starts[s + 1].age * 12 : Infinity);
        if (segB <= segA) continue;
        cg.moveTo(xOf(segA), y).lineTo(xOf(segB), y).stroke({ color: STAGE_COLOR[STAGES[starts[s].si]], alpha: 0.75 * blend, width: CROWD_LANE - 2 });
      }
      if (b.deathTick !== undefined && b.deathTick <= shown) cg.circle(xOf(b.deathTick), y, 1.8).fill({ color: p.ink, alpha: blend });
      if (b.id === selected) cg.rect(xOf(a0), y - CROWD_LANE / 2, xOf(a1) - xOf(a0), CROWD_LANE).stroke({ color: p.accent, width: 1.5, alpha: blend });
    }
  }

  // ---- 顶栏：年份与事件轨道 ----
  const hg = rt.header;
  hg.clear();
  hg.rect(0, 0, W, HEADER_H).fill({ color: p.paper, alpha: 0.97 });
  hg.moveTo(0, HEADER_H - 0.5).lineTo(W, HEADER_H - 0.5).stroke({ color: p.ink, alpha: 0.12, width: 1 });
  for (let y = firstYear; y * 12 <= Math.min(tR, maxTick); y += yearStep) {
    const x = xOf(y * 12);
    hg.moveTo(x, RULER_H - 5).lineTo(x, RULER_H).stroke({ color: p.ink, alpha: 0.3, width: 1 });
    const t = rt.hpool.get(`y:${y}`, String(p.startYear + y), S.year);
    t.anchor.set(0, 0);
    t.x = x + 3;
    t.y = 5;
  }
  const pills: Pill[] = [];
  const rowsEnd = new Array<number>(EVENT_ROWS).fill(-Infinity);
  for (const e of idx.world) {
    if (e.tick > shown) continue;
    const x = xOf(e.tick);
    if (x < -260 || x > W + 10) continue;
    const title = (e.data?.title as string | undefined) ?? e.text.replace(/^\d+年：/, '').split('。')[0];
    const spec = Boolean(e.data?.speculative);
    const html = `<b>${title}</b>${spec ? ' <span class="muted">· 推演</span>' : ''}<br/>${e.text.replace(/^\d+年：[^。]*。/, '')}`;
    const txt = rt.hpool.get(`e:${e.seq}`, title, spec ? S.pillSpec : S.pill);
    const w = txt.width + 14;
    const row = rowsEnd.findIndex((end) => x >= end + 5);
    if (row < 0) {
      txt.visible = false;
      hg.circle(x, HEADER_H - 6, 2.5).fill({ color: p.accent, alpha: 0.7 });
      pills.push({ x0: x - 5, y0: HEADER_H - 12, x1: x + 5, y1: HEADER_H, html });
      continue;
    }
    rowsEnd[row] = x + w;
    const y = RULER_H + 2 + row * EVENT_ROW_H;
    hg.moveTo(x, y + 16).lineTo(x, HEADER_H).stroke({ color: p.accent, alpha: 0.3, width: 1 });
    hg.roundRect(x, y, w, 16, 8).fill({ color: 0xffffff, alpha: spec ? 0.45 : 0.9 }).stroke({ color: p.accent, alpha: spec ? 0.25 : 0.5, width: 1 });
    txt.anchor.set(0, 0.5);
    txt.x = x + 7;
    txt.y = y + 8.5;
    txt.alpha = spec ? 0.8 : 1;
    pills.push({ x0: x, y0: y, x1: x + w, y1: y + 16, html });
  }

  // ---- 时间光标 ----
  const cur = rt.cursor;
  cur.clear();
  const cx = xOf(shown);
  if (cx > -5 && cx < W + 5) {
    cur.moveTo(cx, RULER_H).lineTo(cx, H).stroke({ color: p.ink, alpha: 0.35, width: 1 });
    cur.poly([cx - 5, RULER_H - 1, cx + 5, RULER_H - 1, cx, RULER_H + 5]).fill({ color: p.accent });
  }

  rt.pool.end();
  rt.hpool.end();
  rt.geom = { layout, markers, pills, shown, streamTop, yc, scale, blend, crowdIds };
}
