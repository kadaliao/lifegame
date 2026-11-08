import { useEffect, useRef } from 'react';
import { Application, Container, Graphics, Text, TextStyle } from 'pixi.js';
import type { BotSummary } from '@lifegame/core';
import type { WorldEvent } from '@lifegame/schema';
import { useStore, type BranchData } from '../store.js';

const STAGE_COLORS: Record<string, number> = {
  infant: 0xd9c7a7, child: 0x8fb98b, teen: 0x5fa8a0, youth: 0x4f7fbf, adult: 0x6b5fb5, middle: 0xc98a3d, senior: 0x8c8378,
};
const STAGE_BOUNDS: Array<[number, string]> = [[0, 'infant'], [3, 'child'], [12, 'teen'], [18, 'youth'], [30, 'adult'], [45, 'middle'], [60, 'senior']];

interface View {
  pxPerTick: number;
  offsetX: number;
  offsetY: number;
}

export function TimeRiver({ branch }: { branch: BranchData }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<Application>();
  const layersRef = useRef<{ bg: Graphics; lines: Graphics; links: Graphics; markers: Container; cursor: Graphics; hover: Graphics }>();
  const viewRef = useRef<View>({ pxPerTick: 1.2, offsetX: 40, offsetY: 30 });
  const laneRef = useRef<{ ids: string[]; laneH: number }>({ ids: [], laneH: 6 });
  const dataRef = useRef<{ branch: BranchData; viewTick?: number; selected?: string; thinking: Record<string, string>; startYear: number }>();
  const tooltipRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const dirtyRef = useRef(true);

  const viewTick = useStore((s) => s.viewTick);
  const selected = useStore((s) => s.selectedBot);
  const thinking = useStore((s) => s.thinking);
  const startYear = useStore((s) => s.config?.startYear ?? 1980);
  const selectBot = useStore((s) => s.selectBot);
  const accent = useStore((s) => s.era?.theme.accent ?? '#c8362f');

  dataRef.current = { branch, viewTick, selected, thinking, startYear };
  dirtyRef.current = true;

  useEffect(() => {
    const host = hostRef.current!;
    let destroyed = false;
    const app = new Application();
    app.init({ background: 0x00000000, backgroundAlpha: 0, resizeTo: host, antialias: true, resolution: Math.min(2, window.devicePixelRatio || 1), autoDensity: true }).then(() => {
      if (destroyed) { app.destroy(true); return; }
      host.appendChild(app.canvas);
      const bg = new Graphics();
      const links = new Graphics();
      const lines = new Graphics();
      const markers = new Container();
      const cursor = new Graphics();
      const hover = new Graphics();
      app.stage.addChild(bg, markers, links, lines, hover, cursor);
      layersRef.current = { bg, lines, links, markers, cursor, hover };
      appRef.current = app;
      app.ticker.add(() => { if (dirtyRef.current) { dirtyRef.current = false; draw(); } });
      dirtyRef.current = true;
    });

    const draw = () => {
      const app = appRef.current;
      const L = layersRef.current;
      const d = dataRef.current;
      if (!app || !L || !d) return;
      const { branch, viewTick, selected, thinking, startYear } = d;
      const W = app.screen.width;
      const H = app.screen.height;
      const v = viewRef.current;
      const nowTick = branch.summary?.tick ?? 0;
      const shownTick = viewTick ?? nowTick;
      const accentNum = parseInt(accent.slice(1), 16);

      // lanes：按出生排序
      const ids = branch.botOrder.slice().sort((a, b) => branch.bots[a].birthTick - branch.bots[b].birthTick);
      const laneH = Math.max(2.5, Math.min(16, (H - v.offsetY - 10) / Math.max(1, ids.length)));
      laneRef.current = { ids, laneH };
      const yOf = (i: number) => v.offsetY + i * laneH + laneH / 2;
      const xOf = (t: number) => v.offsetX + t * v.pxPerTick;
      const laneOf: Record<string, number> = {};
      ids.forEach((id, i) => { laneOf[id] = i; });

      // 背景：年份刻度
      L.bg.clear();
      const yearStep = v.pxPerTick * 12 < 28 ? 10 : v.pxPerTick * 12 < 60 ? 5 : 1;
      L.markers.removeChildren();
      const labelStyle = new TextStyle({ fontFamily: 'Noto Sans SC, sans-serif', fontSize: 11, fill: 0x8a8178 });
      const maxTick = Math.max(nowTick, (W - v.offsetX) / v.pxPerTick);
      for (let y = 0; y * 12 <= maxTick + 12; y += yearStep) {
        const x = xOf(y * 12);
        if (x < -20 || x > W + 20) continue;
        L.bg.moveTo(x, v.offsetY - 6).lineTo(x, H).stroke({ color: 0x000000, alpha: y % 10 === 0 ? 0.08 : 0.04, width: 1 });
        const t = new Text({ text: String(startYear + y), style: labelStyle });
        t.x = x + 3; t.y = 4;
        L.markers.addChild(t);
      }
      // 世界事件
      const worldEvents = branch.events.filter((e) => e.type === 'world' && e.tick <= shownTick);
      const evStyle = new TextStyle({ fontFamily: 'Noto Serif SC, serif', fontSize: 11, fill: accentNum, fontWeight: '600' });
      for (const e of worldEvents) {
        const x = xOf(e.tick);
        if (x < -100 || x > W + 100) continue;
        L.bg.moveTo(x, v.offsetY - 4).lineTo(x, H).stroke({ color: accentNum, alpha: 0.18, width: 1 });
        const title = String(e.text).replace(/^\d+年：/, '').split('。')[0];
        const t = new Text({ text: title, style: evStyle });
        t.anchor.set(0, 0);
        t.rotation = Math.PI / 2;
        t.x = x + 12; t.y = v.offsetY - 2;
        t.alpha = 0.85;
        L.markers.addChild(t);
      }

      // 生命线
      L.lines.clear();
      L.links.clear();
      for (const id of ids) {
        const b = branch.bots[id];
        const lane = laneOf[id];
        if (b.birthTick > shownTick) continue;
        const end = Math.min(shownTick, b.deathTick ?? Infinity);
        const y = yOf(lane);
        const isHero = b.intelligence === 'llm';
        const isSel = id === selected;
        const width = isSel ? Math.max(3, laneH * 0.7) : isHero ? Math.max(2, laneH * 0.55) : Math.max(1, laneH * 0.42);
        const alpha = isSel ? 1 : isHero ? 0.95 : 0.55;
        // 按阶段分段
        let segStart = b.birthTick;
        for (let i = 0; i < STAGE_BOUNDS.length; i++) {
          const [ageStart, stage] = STAGE_BOUNDS[i];
          const nextAge = STAGE_BOUNDS[i + 1]?.[0];
          const s = b.birthTick + ageStart * 12;
          const e = nextAge === undefined ? end : Math.min(end, b.birthTick + nextAge * 12);
          if (s >= end) break;
          const x0 = xOf(Math.max(s, segStart));
          const x1 = xOf(e);
          if (x1 < 0 || x0 > W) { segStart = e; continue; }
          L.lines.moveTo(x0, y).lineTo(x1, y).stroke({ color: isSel ? accentNum : STAGE_COLORS[stage], width, alpha, cap: 'round' });
          segStart = e;
        }
        if (b.deathTick !== undefined && b.deathTick <= shownTick) {
          L.lines.circle(xOf(b.deathTick), y, Math.max(1.5, width * 0.9)).fill({ color: 0x2b2622, alpha: 0.9 });
        } else if (thinking[id]) {
          L.lines.circle(xOf(end), y, Math.max(3, width * 1.6)).fill({ color: accentNum, alpha: 0.9 });
          L.lines.circle(xOf(end), y, Math.max(5, width * 2.6)).stroke({ color: accentNum, alpha: 0.4, width: 1.5 });
        }
        // 婚姻连线
        if (b.spouseId && laneOf[b.spouseId] !== undefined && id < b.spouseId) {
          const sp = branch.bots[b.spouseId];
          const mt = marriageTick(branch.events, id, b.spouseId);
          if (mt !== undefined && mt <= shownTick) {
            const x = xOf(mt);
            const y2 = yOf(laneOf[b.spouseId]);
            const cx = x + Math.min(40, Math.abs(y2 - y) * 0.4);
            L.links.moveTo(x, y).quadraticCurveTo(cx, (y + y2) / 2, x, y2).stroke({ color: accentNum, alpha: 0.35, width: 1 });
            void sp;
          }
        }
        // 出生连线（母亲→孩子）
        if (b.parentIds.length) {
          const mom = b.parentIds.find((p) => branch.bots[p]?.sex === 'female') ?? b.parentIds[0];
          if (laneOf[mom] !== undefined) {
            const x = xOf(b.birthTick);
            L.links.moveTo(x, yOf(laneOf[mom])).lineTo(x, y).stroke({ color: 0x5fa8a0, alpha: 0.3, width: 1 });
          }
        }
      }

      // 时间光标
      L.cursor.clear();
      const cx = xOf(shownTick);
      L.cursor.moveTo(cx, v.offsetY - 8).lineTo(cx, H).stroke({ color: 0x2b2622, alpha: 0.5, width: 1 });
      if (viewTick !== undefined && viewTick < nowTick) {
        L.cursor.rect(cx, 0, Math.max(0, xOf(nowTick) - cx), H).fill({ color: 0xffffff, alpha: 0.35 });
      }
    };

    // 交互
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const v = viewRef.current;
      if (ev.ctrlKey || ev.metaKey) {
        const rect = host.getBoundingClientRect();
        const mx = ev.clientX - rect.left;
        const tickAt = (mx - v.offsetX) / v.pxPerTick;
        const factor = Math.exp(-ev.deltaY * 0.0015);
        v.pxPerTick = Math.min(30, Math.max(0.15, v.pxPerTick * factor));
        v.offsetX = mx - tickAt * v.pxPerTick;
      } else {
        v.offsetX -= ev.deltaX;
        v.offsetY -= ev.deltaY;
        v.offsetY = Math.min(30, v.offsetY);
      }
      dirtyRef.current = true;
    };
    const onDown = (ev: PointerEvent) => {
      dragRef.current = { x: ev.clientX, y: ev.clientY, ox: viewRef.current.offsetX, oy: viewRef.current.offsetY };
    };
    const onMove = (ev: PointerEvent) => {
      const rect = host.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      const my = ev.clientY - rect.top;
      if (dragRef.current) {
        const d = dragRef.current;
        viewRef.current.offsetX = d.ox + (ev.clientX - d.x);
        viewRef.current.offsetY = Math.min(30, d.oy + (ev.clientY - d.y));
        dirtyRef.current = true;
        return;
      }
      const hit = hitTest(mx, my);
      const tip = tooltipRef.current!;
      const L = layersRef.current;
      if (hit && L) {
        const d = dataRef.current!;
        const b = d.branch.bots[hit.id];
        const tick = Math.round((mx - viewRef.current.offsetX) / viewRef.current.pxPerTick);
        const age = Math.max(0, Math.floor((Math.min(tick, b.deathTick ?? tick) - b.birthTick) / 12));
        tip.style.display = 'block';
        tip.style.left = `${mx + 14}px`;
        tip.style.top = `${my + 14}px`;
        tip.innerHTML = `<b>${b.name}</b> <span class="muted">${b.sex === 'male' ? '男' : '女'} · ${d.startYear + Math.floor(b.birthTick / 12)}年生${b.deathTick !== undefined ? ` · 卒于${d.startYear + Math.floor(b.deathTick / 12)}` : ''}</span><br/>${age}岁 · ${b.jobTitle ?? eduLabel(b.education)} · ${b.city}${b.intelligence === 'llm' ? '<br/><span class="hero-tag">✦ 智能人格</span>' : ''}`;
        L.hover.clear();
        L.hover.rect(0, hit.y - laneRef.current.laneH / 2, app.screen.width, laneRef.current.laneH).fill({ color: 0x000000, alpha: 0.05 });
        host.style.cursor = 'pointer';
      } else {
        tip.style.display = 'none';
        L?.hover.clear();
        host.style.cursor = dragRef.current ? 'grabbing' : 'default';
      }
    };
    const onUp = (ev: PointerEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      if (d && Math.hypot(ev.clientX - d.x, ev.clientY - d.y) > 4) return;
      const rect = host.getBoundingClientRect();
      const hit = hitTest(ev.clientX - rect.left, ev.clientY - rect.top);
      if (hit) selectBot(hit.id);
    };
    const onLeave = () => { if (tooltipRef.current) tooltipRef.current.style.display = 'none'; layersRef.current?.hover.clear(); };
    const hitTest = (mx: number, my: number): { id: string; y: number } | undefined => {
      const { ids, laneH } = laneRef.current;
      const v = viewRef.current;
      const i = Math.floor((my - v.offsetY) / laneH);
      if (i < 0 || i >= ids.length) return undefined;
      const d = dataRef.current!;
      const b = d.branch.bots[ids[i]];
      const tick = (mx - v.offsetX) / v.pxPerTick;
      const shown = d.viewTick ?? d.branch.summary?.tick ?? 0;
      if (tick < b.birthTick - 6 || tick > Math.min(shown, b.deathTick ?? Infinity) + 6) return undefined;
      return { id: ids[i], y: v.offsetY + i * laneH + laneH / 2 };
    };

    host.addEventListener('wheel', onWheel, { passive: false });
    host.addEventListener('pointerdown', onDown);
    host.addEventListener('pointermove', onMove);
    host.addEventListener('pointerup', onUp);
    host.addEventListener('pointerleave', onLeave);
    const ro = new ResizeObserver(() => { dirtyRef.current = true; });
    ro.observe(host);
    return () => {
      destroyed = true;
      ro.disconnect();
      host.removeEventListener('wheel', onWheel);
      host.removeEventListener('pointerdown', onDown);
      host.removeEventListener('pointermove', onMove);
      host.removeEventListener('pointerup', onUp);
      host.removeEventListener('pointerleave', onLeave);
      appRef.current?.destroy(true);
      appRef.current = undefined;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 自动跟随当前时间
  useEffect(() => {
    const app = appRef.current;
    if (!app || viewTick !== undefined) return;
    const v = viewRef.current;
    const x = v.offsetX + (branch.summary?.tick ?? 0) * v.pxPerTick;
    if (x > app.screen.width - 80) v.offsetX -= x - (app.screen.width - 80);
    dirtyRef.current = true;
  }, [branch.summary?.tick, viewTick]);

  return (
    <div className="river" ref={hostRef}>
      <div className="tooltip" ref={tooltipRef} />
      <div className="river-legend">
        {Object.entries(STAGE_COLORS).map(([k, c]) => (
          <span key={k}><i style={{ background: `#${c.toString(16).padStart(6, '0')}` }} />{STAGE_NAME[k]}</span>
        ))}
        <span className="muted">滚轮平移 · ⌘/Ctrl+滚轮缩放 · 点击生命线查看</span>
      </div>
    </div>
  );
}

const STAGE_NAME: Record<string, string> = { infant: '婴幼', child: '童年', teen: '少年', youth: '青年', adult: '成年', middle: '中年', senior: '老年' };

function marriageTick(events: WorldEvent[], a: string, b: string): number | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'marriage' && e.botId === a && e.relatedIds?.includes(b) && e.text.includes('结婚')) return e.tick;
  }
  return undefined;
}

export function eduLabel(e: BotSummary['education']): string {
  return { none: '未上学', primary: '小学', junior: '初中', vocational: '职校', senior: '高中', college: '大专', bachelor: '本科', master: '硕士', phd: '博士' }[e];
}
