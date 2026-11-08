import { useEffect, useMemo, useRef } from 'react';
import { Application, Container, Graphics, TextStyle } from 'pixi.js';
import { getEra } from '@lifegame/eras';
import type { WorldEvent } from '@lifegame/schema';
import { caughtUp, fmtMoney, nowOf, useStore, type BotDetail, type BranchData } from '../store.js';
import { eduLabel } from '../util.js';
import { SES_COLOR, SES_LABEL, STAGES, STAGE_COLOR, STAGE_LABEL, TextPool, clamp, css, hashId, hex, stageStarts, stageTable } from './pixi-util.js';

/** 资产纵轴：对称对数，1 万以内近似线性 */
const fv = (v: number) => Math.sign(v) * Math.log10(1 + Math.abs(v) / 1e4);
const FMIN = -2.1;
const FMAX = 4.5;
const REF_YEAR = 2025;
const Y_TICKS: Array<[number, string]> = [[-1e6, '-100万'], [-1e5, '-10万'], [0, '0'], [1e5, '10万'], [1e6, '100万'], [1e7, '1000万'], [1e8, '1亿']];
const MAX_AGE = 100;

interface Props {
  branch: BranchData;
  viewTick?: number;
  selected?: string;
  thinking: Record<string, string>;
  detail?: BotDetail;
  startYear: number;
  eraId: string;
  paper: number;
  ink: number;
  accent: number;
  worldEvents: WorldEvent[];
  frameKeys: number[];
}

const NO_THINKING: Record<string, string> = {};

interface Pt { x: number; y: number; a: number }

export function PeopleView({ branch }: { branch: BranchData }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const propsRef = useRef<Props>();
  const drawnRef = useRef<Array<{ id: string; x: number; y: number; r: number }>>([]);

  const viewTick = useStore((s) => s.viewTick);
  const selected = useStore((s) => s.selectedBot);
  const thinking = useStore((s) => (caughtUp(s.branches[s.activeBranch]) ? s.thinking : NO_THINKING));
  const detail = useStore((s) => s.botDetail);
  const config = useStore((s) => s.config)!;
  const theme = useStore((s) => s.era?.theme);
  const selectBot = useStore((s) => s.selectBot);
  const worldEvents = useMemo(() => branch.events.filter((e) => e.type === 'world'), [branch.events]);
  const frameKeys = useMemo(() => Object.keys(branch.frames).map(Number).sort((a, b) => a - b), [branch.frames]);

  propsRef.current = {
    branch, viewTick, selected, thinking, detail, worldEvents, frameKeys,
    startYear: config.startYear, eraId: config.eraId,
    paper: hex(theme?.paper ?? '#f6f1e7'), ink: hex(theme?.ink ?? '#2b2622'), accent: hex(theme?.accent ?? '#c8362f'),
  };

  useEffect(() => {
    const host = hostRef.current!;
    let destroyed = false;
    let ready = false;
    const app = new Application();
    const pts = new Map<string, Pt>();
    let last = performance.now();

    app.init({ backgroundAlpha: 0, resizeTo: host, antialias: true, resolution: Math.min(2, window.devicePixelRatio || 1), autoDensity: true }).then(() => {
      if (destroyed) { app.destroy(true); return; }
      ready = true;
      host.appendChild(app.canvas);
      const bg = new Graphics();
      const trail = new Graphics();
      const dots = new Graphics();
      const texts = new Container();
      const bigTexts = new Container();
      app.stage.addChild(bigTexts, bg, trail, dots, texts);
      const pool = new TextPool(texts);
      const bigPool = new TextPool(bigTexts);
      const sans = 'Noto Sans SC, PingFang SC, sans-serif';
      const serif = 'Noto Serif SC, Songti SC, serif';
      let styles: Record<string, TextStyle> | undefined;
      let stylesKey = '';
      const era = getEra(propsRef.current!.eraId);
      const table = stageTable((a) => era.stageOf(a));
      const starts = stageStarts(table);
      const wi = era.wageIndex?.bind(era);
      const refIdx = wi ? wi(REF_YEAR) : 1;

      app.ticker.add(() => {
        const p = propsRef.current;
        if (!p) return;
        const now = performance.now();
        const dt = Math.min(100, now - last);
        last = now;
        const k = 1 - Math.pow(0.86, dt / 16.7);
        const W = app.screen.width;
        const H = app.screen.height;
        if (W < 100 || H < 100) return;
        if (stylesKey !== `${p.ink}-${p.accent}`) {
          stylesKey = `${p.ink}-${p.accent}`;
          styles = {
            axis: new TextStyle({ fontFamily: sans, fontSize: 11, fill: 0x8a8178 }),
            axisTitle: new TextStyle({ fontFamily: sans, fontSize: 11.5, fill: 0x6f665e, fontWeight: '500' }),
            stage: new TextStyle({ fontFamily: sans, fontSize: 11.5, fill: p.ink, fontWeight: '500' }),
            year: new TextStyle({ fontFamily: serif, fontSize: 168, fill: p.ink, fontWeight: '700' }),
            sub: new TextStyle({ fontFamily: serif, fontSize: 20, fill: p.ink, fontWeight: '600' }),
            stat: new TextStyle({ fontFamily: sans, fontSize: 12, fill: 0x6f665e }),
            name: new TextStyle({ fontFamily: sans, fontSize: 12, fill: p.ink, fontWeight: '700' }),
            nameSel: new TextStyle({ fontFamily: sans, fontSize: 13, fill: p.accent, fontWeight: '700' }),
          };
        }
        const S = styles!;
        const { branch, selected, thinking } = p;
        const bots = branch.bots;
        const nowTick = nowOf(branch);
        const simTick = branch.summary?.tick ?? 0;
        const t = Math.min(p.viewTick ?? nowTick, nowTick);
        const year = p.startYear + Math.floor(t / 12);
        const defl = (v: number, y: number) => (wi ? (v * refIdx) / wi(y) : v);

        const L = 84;
        const R = W - 36;
        const T = 40;
        const B = H - 92;
        const xA = (a: number) => L + (clamp(a, 0, MAX_AGE) / MAX_AGE) * (R - L);
        const yF = (f: number) => B - ((clamp(f, FMIN, FMAX) - FMIN) / (FMAX - FMIN)) * (B - T);

        // 回看时用历史帧，否则用实时数据
        let wealthOf: (id: string) => number = (id) => bots[id]?.wealth ?? 0;
        if (t < simTick && p.frameKeys.length) {
          let lo = 0;
          let hi = p.frameKeys.length - 1;
          while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (p.frameKeys[mid] <= t) lo = mid; else hi = mid - 1;
          }
          const fr = branch.frames[p.frameKeys[lo]];
          wealthOf = (id) => fr?.[id] ?? 0;
        }

        pool.begin();
        bigPool.begin();

        // ---- 背景：年份、阶段带、坐标 ----
        const big = bigPool.get('year', String(year), S.year);
        big.anchor.set(0.5, 0.5);
        big.x = (L + R) / 2;
        big.y = (T + B) / 2 - 10;
        big.alpha = 0.07;
        const recent = [...p.worldEvents].reverse().find((e) => e.tick <= t && e.tick > t - 36);
        if (recent) {
          const title = (recent.data?.title as string | undefined) ?? recent.text.replace(/^\d+年：/, '').split('。')[0];
          const sub = bigPool.get('sub', title, S.sub);
          sub.anchor.set(0.5, 0);
          sub.x = (L + R) / 2;
          sub.y = big.y + 92;
          sub.alpha = 0.28 * clamp(1 - (t - recent.tick) / 36, 0.3, 1);
        }

        bg.clear();
        for (let i = 0; i < starts.length; i++) {
          const a0 = starts[i].age;
          const a1 = i + 1 < starts.length ? starts[i + 1].age : MAX_AGE;
          if (a0 >= MAX_AGE) break;
          const x0 = xA(a0);
          const x1 = xA(Math.min(a1, MAX_AGE));
          if (i % 2 === 1) bg.rect(x0, T, x1 - x0, B - T).fill({ color: p.ink, alpha: 0.025 });
          bg.rect(x0, B + 1, x1 - x0, 4).fill({ color: STAGE_COLOR[STAGES[starts[i].si]], alpha: 0.9 });
          if (x1 - x0 > 26) {
            const lbl = pool.get(`st:${i}`, STAGE_LABEL[STAGES[starts[i].si]], S.stage);
            lbl.anchor.set(0.5, 0);
            lbl.x = (x0 + x1) / 2;
            lbl.y = B + 24;
            lbl.alpha = 0.75;
          }
        }
        for (let a = 0; a <= MAX_AGE; a += 10) {
          const x = xA(a);
          bg.moveTo(x, B + 5).lineTo(x, B + 9).stroke({ color: p.ink, alpha: 0.3, width: 1 });
          const lbl = pool.get(`ax:${a}`, String(a), S.axis);
          lbl.anchor.set(0.5, 0);
          lbl.x = x;
          lbl.y = B + 9;
        }
        const xt = pool.get('xtitle', '年龄', S.axisTitle);
        xt.anchor.set(1, 0);
        xt.x = R;
        xt.y = B + 42;
        for (const [v, label] of Y_TICKS) {
          const y = yF(fv(v));
          bg.moveTo(L, y).lineTo(R, y).stroke({ color: p.ink, alpha: v === 0 ? 0.22 : 0.07, width: 1 });
          const lbl = pool.get(`ay:${v}`, label, S.axis);
          lbl.anchor.set(1, 0.5);
          lbl.x = L - 8;
          lbl.y = y;
        }
        const yt = pool.get('ytitle', `净资产 · 折合${REF_YEAR}年收入水平`, S.axisTitle);
        yt.anchor.set(0, 1);
        yt.x = L - 70;
        yt.y = T - 14;

        // ---- 点 ----
        const order = branch.botOrder;
        const alive: number[] = [];
        let aliveCount = 0;
        const seen = new Set<string>();
        for (const id of order) {
          const b = bots[id];
          if (!b || b.birthTick > t) continue;
          const isAlive = b.deathTick === undefined || b.deathTick > t;
          const age = (Math.min(t, b.deathTick ?? t) - b.birthTick) / 12;
          const w = defl(wealthOf(id), year);
          const h = hashId(id);
          const tx = xA(age) + ((h & 0xff) / 255 - 0.5) * 3;
          const ty = yF(fv(w)) + (((h >> 8) & 0xff) / 255 - 0.5) * 7;
          let pt = pts.get(id);
          if (!pt) {
            if (!isAlive) continue;
            pt = { x: tx, y: ty, a: 0 };
            pts.set(id, pt);
          }
          seen.add(id);
          pt.x += (tx - pt.x) * k;
          pt.y += (ty - pt.y) * k;
          pt.a += ((isAlive ? 1 : 0) - pt.a) * k * 0.6;
          if (!isAlive && pt.a < 0.02) { pts.delete(id); continue; }
          if (isAlive) {
            aliveCount++;
            if (age >= 18) alive.push(w);
          }
        }
        for (const id of pts.keys()) if (!seen.has(id)) pts.delete(id);

        dots.clear();
        const drawn: Array<{ id: string; x: number; y: number; r: number }> = [];
        const layers: string[][] = [[], [], []];
        for (const id of pts.keys()) {
          const b = bots[id];
          layers[id === selected ? 2 : b.intelligence === 'llm' ? 1 : 0].push(id);
        }
        const pulse = (Math.sin(now / 220) + 1) / 2;
        for (let li = 0; li < 3; li++) {
          for (const id of layers[li]) {
            const pt = pts.get(id)!;
            const b = bots[id];
            const r = li === 2 ? 8 : li === 1 ? 6.5 : 4;
            const color = SES_COLOR[clamp(b.ses, 1, 5) - 1];
            if (li === 2) dots.circle(pt.x, pt.y, r + 5).fill({ color: p.accent, alpha: 0.15 * pt.a });
            dots.circle(pt.x, pt.y, r).fill({ color, alpha: (li === 0 ? 0.72 : 0.95) * pt.a }).stroke({ color: li === 2 ? p.accent : p.paper, width: li === 2 ? 2 : 1, alpha: pt.a });
            if (thinking[id]) dots.circle(pt.x, pt.y, r + 4 + pulse * 6).stroke({ color: p.accent, alpha: (0.6 - pulse * 0.5) * pt.a, width: 2 });
            drawn.push({ id, x: pt.x, y: pt.y, r });
            if (li > 0) {
              const lbl = pool.get(`n:${id}`, b.name, li === 2 ? S.nameSel : S.name);
              lbl.anchor.set(0, 0.5);
              lbl.x = pt.x + r + 5;
              lbl.y = pt.y;
              lbl.alpha = pt.a;
            }
          }
        }
        drawnRef.current = drawn;

        // ---- 选中者的人生轨迹 ----
        trail.clear();
        const d = p.detail;
        const sb = selected ? bots[selected] : undefined;
        if (d && sb && d.bot.id === selected && d.branchId === branch.info.id && d.samples.length > 1) {
          const h = hashId(sb.id);
          const jx = ((h & 0xff) / 255 - 0.5) * 3;
          const jy = (((h >> 8) & 0xff) / 255 - 0.5) * 7;
          const path: number[] = [];
          for (const s of d.samples) {
            if (s.tick > t) break;
            path.push(xA((s.tick - sb.birthTick) / 12) + jx, yF(fv(defl(s.netWorth, p.startYear + Math.floor(s.tick / 12)))) + jy);
          }
          const cur = pts.get(sb.id);
          if (cur) path.push(cur.x, cur.y);
          if (path.length >= 4) {
            trail.moveTo(path[0], path[1]);
            for (let i = 2; i < path.length; i += 2) trail.lineTo(path[i], path[i + 1]);
            trail.stroke({ color: p.accent, alpha: 0.5, width: 1.6, join: 'round', cap: 'round' });
            for (let i = 0; i < path.length - 2; i += 20) trail.circle(path[i], path[i + 1], 2).fill({ color: p.accent, alpha: 0.6 });
          }
        }

        // ---- 统计 ----
        alive.sort((a, b) => a - b);
        const median = alive.length ? alive[Math.floor(alive.length / 2)] : 0;
        const stat = pool.get('stat', `在世 ${aliveCount} 人 · 成年人净资产中位数 ${fmtMoney(median)}`, S.stat);
        stat.anchor.set(1, 1);
        stat.x = R;
        stat.y = T - 14;

        pool.end();
        bigPool.end();
      });
    });

    const nearest = (mx: number, my: number) => {
      let best: { id: string; d: number } | undefined;
      for (const p of drawnRef.current) {
        const d = Math.hypot(p.x - mx, p.y - my);
        if (d <= p.r + 5 && (!best || d <= best.d)) best = { id: p.id, d };
      }
      return best?.id;
    };
    const onMove = (ev: PointerEvent) => {
      const rect = host.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      const my = ev.clientY - rect.top;
      const id = nearest(mx, my);
      const tip = tipRef.current!;
      const p = propsRef.current;
      if (id && p) {
        const b = p.branch.bots[id];
        const nowTick = nowOf(p.branch);
        const t = Math.min(p.viewTick ?? nowTick, nowTick);
        const age = Math.floor((Math.min(t, b.deathTick ?? t) - b.birthTick) / 12);
        tip.style.display = 'block';
        tip.innerHTML = `<b>${b.name}</b> <span class="muted">${b.sex === 'male' ? '男' : '女'} · ${age}岁 · 出身${SES_LABEL[b.ses - 1]}</span><br/>${b.jobTitle ?? eduLabel(b.education)} · ${b.city}<br/>净资产 ${fmtMoney(b.wealth)}${b.intelligence === 'llm' ? '<br/><span class="hero-tag">✦ 智能人格</span>' : ''}`;
        tip.style.left = `${Math.min(mx + 14, rect.width - tip.offsetWidth - 8)}px`;
        tip.style.top = `${my + 16}px`;
        host.style.cursor = 'pointer';
      } else {
        tip.style.display = 'none';
        host.style.cursor = 'default';
      }
    };
    const onClick = (ev: MouseEvent) => {
      const rect = host.getBoundingClientRect();
      const id = nearest(ev.clientX - rect.left, ev.clientY - rect.top);
      if (id) selectBot(id);
    };
    const onLeave = () => { if (tipRef.current) tipRef.current.style.display = 'none'; };
    host.addEventListener('pointermove', onMove);
    host.addEventListener('click', onClick);
    host.addEventListener('pointerleave', onLeave);
    return () => {
      destroyed = true;
      host.removeEventListener('pointermove', onMove);
      host.removeEventListener('click', onClick);
      host.removeEventListener('pointerleave', onLeave);
      if (ready) app.destroy(true, { children: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="river" ref={hostRef}>
      <div className="tooltip" ref={tipRef} />
      <div className="river-legend">
        <span className="muted">出身</span>
        {SES_LABEL.map((l, i) => (
          <span key={l}><i className="round" style={{ background: css(SES_COLOR[i]) }} />{l}</span>
        ))}
        <span className="sep" />
        <span>大点 = 智能人格</span>
        <span><i style={{ background: 'var(--accent)' }} />选中者的人生轨迹</span>
      </div>
    </div>
  );
}
