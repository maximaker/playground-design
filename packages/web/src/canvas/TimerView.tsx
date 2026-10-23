/**
 * A countdown on a slide.
 *
 * The canvas, thumbnails and export draw the static face (full duration). Only
 * a timer rendered inside the presented frame runs: Present wraps its frame in
 * PresentingTimers, so the editor canvas behind the presentation never ticks
 * or chimes. The frame is remounted for every slide, so going back to a slide
 * starts its timer over.
 */

import {
  type ReactNode, createContext, createElement, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import {
  IDLE, type TimerSpec, type TimerState, bigRingBox, isUrgent, ringShrinkTransform, timerOnShow, pauseTimer, readTimer, remainingMs, resetTimer,
  revealStage, startTimer, tickTimer, timerSvg, toggleTimer,
} from '@playground/shared';

/** True inside the presented frame. */
export const PresentingTimers = createContext(false);

export type TimerAction = 'toggle' | 'reset' | 'start' | 'pause' | 'reveal' | 'finish';

/**
 * Results withheld until time is up. Present wraps a slide that has both a
 * live results embed and a revealing timer in a RevealScope: the embeds start
 * withheld (so nothing flashes before a timer reports) and are shown once
 * every revealing timer says so: at zero, or on Shift+R.
 */
export interface RevealGateValue {
  /** The slide has live results and a timer that withholds them. */
  gated: boolean;
  board: { width: number; height: number };
  /** Live results must not render now. */
  withheld: boolean;
  report: (token: object, results: boolean | null) => void;
  /** The revealing timer's big face, drawn by the waiting panel inside the results area. */
  ring: BigRing | null;
  setRing: (ring: BigRing | null) => void;
  /** A waiting panel found room for the big ring (else the timer just stays small). */
  ringPlaced: boolean | null;
  setRingPlaced: (placed: boolean) => void;
}

export interface BigRing {
  /** The ring face, as SVG. */
  svg: string;
  /** Show it big now (else it shrinks away toward the authored timer). */
  big: boolean;
  /** The authored timer's box, slide px: where the ring shrinks to. */
  box: { x: number; y: number; width: number; height: number } | null;
  /** The authored timer's text colour, so the ring matches it. */
  color?: string;
}

export const RevealGate = createContext<RevealGateValue | null>(null);

export function RevealScope({ gated, board, children }: { gated: boolean; board: { width: number; height: number }; children: ReactNode }) {
  const [reports, setReports] = useState<Map<object, boolean>>(() => new Map());
  const report = useCallback((token: object, results: boolean | null) => {
    setReports((m) => {
      if (results === null ? !m.has(token) : m.get(token) === results) return m;
      const next = new Map(m);
      if (results === null) next.delete(token); else next.set(token, results);
      return next;
    });
  }, []);
  const [ring, setRing] = useState<BigRing | null>(null);
  const [ringPlaced, setRingPlaced] = useState<boolean | null>(null);
  const withheld = gated && (reports.size === 0 || [...reports.values()].some((r) => !r));
  const value = useMemo(
    () => ({ gated, board, withheld, report, ring, setRing, ringPlaced: withheld ? ringPlaced : false, setRingPlaced }),
    [gated, board.width, board.height, withheld, report, ring, ringPlaced],
  );
  return <RevealGate.Provider value={value}>{children}</RevealGate.Provider>;
}

/** Present's keys and clicks reach the timers through this. `el` targets one; absent means all. */
const bus = new EventTarget();

/** Timers on the presented slide that are running now, so T can pause them all or start them all. */
const running = new Set<object>();

/**
 * With `el`, one timer (a click): start, pause, resume, or start over when done.
 * Without, the T key: pause whatever runs, else start the ones waiting. A
 * finished timer is left showing "Time's up" — R or a click starts it over.
 */
export function sendTimer(action: TimerAction, el?: Element | null): void {
  if (action === 'toggle' && !el) action = running.size ? 'pause' : 'start';
  bus.dispatchEvent(new CustomEvent('timer', { detail: { action, el: el ?? null } }));
}

/** The timer under a point of the presented frame, in that frame's own pixels. */
export function timerAt(frameDoc: Document | null | undefined, x: number, y: number): Element | null {
  if (!frameDoc) return null;
  for (const el of frameDoc.querySelectorAll('[data-timer]')) {
    const r = el.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return el;
  }
  return null;
}

export function TimerView({ tag, props, attrs }: { tag: string; props: Record<string, unknown>; attrs: Record<string, string> }) {
  const live = useContext(PresentingTimers);
  const spec = readTimer(attrs);
  if (!live) return createElement(tag, { ...props, dangerouslySetInnerHTML: { __html: timerSvg(spec) } });
  // A change to the timer while presenting (an agent editing it) starts it fresh.
  return <LiveTimer key={`${spec.seconds}:${spec.start}`} tag={tag} props={props} spec={spec} />;
}

function prefersReducedMotion(): boolean {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

function chime(): void {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const t = ctx.currentTime;
    // Two soft notes, a falling fifth.
    for (const [i, f] of [880, 587.33].entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = f;
      gain.gain.setValueAtTime(0, t + i * 0.35);
      gain.gain.linearRampToValueAtTime(0.18, t + i * 0.35 + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, t + i * 0.35 + 0.9);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t + i * 0.35);
      osc.stop(t + i * 0.35 + 1);
    }
    window.setTimeout(() => void ctx.close(), 2000);
  } catch { /* sound is a nicety */ }
}

function LiveTimer({ tag, props, spec }: { tag: string; props: Record<string, unknown>; spec: TimerSpec }) {
  const duration = spec.seconds * 1000;
  const [state, setState] = useState<TimerState>(() => timerOnShow(spec, Date.now()));
  const [now, setNow] = useState(() => Date.now());
  const ref = useRef<Element | null>(null);
  const reduced = useRef(prefersReducedMotion());
  const gate = useContext(RevealGate);
  const reveals = !!gate?.gated && spec.reveal === 'live';
  const [revealedEarly, setRevealedEarly] = useState(false);

  useEffect(() => {
    const on = (e: Event) => {
      const { action, el } = (e as CustomEvent<{ action: TimerAction; el: Element | null }>).detail;
      if (el && el !== ref.current) return;
      const t = Date.now();
      setNow(t);
      if (action === 'reveal') { setRevealedEarly(true); return; }
      if (action === 'reset') setRevealedEarly(false);
      setState((s) => {
        const now = tickTimer(s, duration, t);
        if (action === 'reset') return resetTimer();
        // Straight to zero: what time running out would have done, results included.
        if (action === 'finish') return { status: 'done', banked: duration, since: 0 };
        if (action === 'start') return startTimer(now, t);
        if (action === 'pause') return pauseTimer(now, t);
        return toggleTimer(now, t);
      });
    };
    bus.addEventListener('timer', on);
    return () => bus.removeEventListener('timer', on);
  }, [duration]);

  useEffect(() => {
    if (state.status !== 'running') return;
    const token = {};
    running.add(token);
    const id = window.setInterval(() => {
      const t = Date.now();
      setNow(t);
      setState((s) => {
        const next = tickTimer(s, duration, t);
        if (next.status === 'done' && s.status !== 'done' && spec.chime) chime();
        return next;
      });
    }, 200);
    return () => { window.clearInterval(id); running.delete(token); };
  }, [state.status, duration, spec.chime]);

  const stage = reveals ? revealStage(state, duration, now, revealedEarly) : { big: false, results: true };

  // Tell the slide whether its results may show.
  const token = useRef({}).current;
  // Depend on the stable setters, never on the gate value itself: it changes
  // with every ring update, and an effect keyed on it re-fires in a loop.
  const report = gate?.report;
  const setRing = gate?.setRing;
  useEffect(() => { if (reveals) report!(token, stage.results); }, [reveals, stage.results, report, token]);
  useEffect(() => () => report?.(token, null), [report, token]);

  // The authored box, in the slide's pixels: where the big ring shrinks to.
  const [box, setBox] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [color, setColor] = useState<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (!reveals) return;
    const el = ref.current as HTMLElement | null;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setBox({ x: r.left, y: r.top, width: r.width, height: r.height });
    try { setColor(getComputedStyle(el).color); } catch { /* inherit */ }
  }, [reveals]);

  const left = remainingMs(state, duration, state.status === 'running' ? now : 0);
  const face = {
    remainingMs: left,
    fraction: left / duration,
    done: state.status === 'done',
    urgent: isUrgent(state, duration, now),
    paused: state.status === 'paused',
    reducedMotion: reduced.current,
  };
  const svg = timerSvg(spec, face);
  // The big face is always a ring, whatever the authored look.
  const ringSvg = reveals ? timerSvg({ ...spec, variant: 'ring' }, face) : '';
  useEffect(() => {
    if (!reveals) return;
    setRing!(stage.results ? null : { svg: ringSvg, big: stage.big, box, color });
  }, [reveals, ringSvg, stage.big, stage.results, box, color, setRing]);
  useEffect(() => () => setRing?.(null), [setRing]);

  // The authored timer is out of sight while the ring stands in, and fades in as it shrinks.
  let style = props.style as Record<string, unknown> | undefined;
  if (reveals) {
    style = {
      ...style,
      // Hidden until the panel says it had no room for the ring, so the small one never flashes first.
      opacity: stage.big && gate!.ringPlaced !== false ? 0 : 1,
      transition: reduced.current ? 'none' : 'opacity 700ms ease 200ms',
    };
  }

  return createElement(tag, {
    ...props,
    style,
    ref,
    'data-timer-status': state.status,
    ...(reveals ? { 'data-timer-stage': stage.results ? 'revealed' : stage.big ? 'big' : 'small' } : {}),
    title: (state.status === 'running' ? 'Click or T to pause, R to reset' : 'Click or T to start, R to reset')
      + ', double-tap or E to end it now' + (reveals ? ', Shift+R to reveal results now' : ''),
    dangerouslySetInnerHTML: { __html: svg },
  });
}

/**
 * A live results embed under a revealing timer. While withheld the board is
 * not loaded at all (no iframe, so nothing can flash or leak) and a calm
 * panel stands in its place. On reveal the board fades in.
 */
export function LiveGateView({ tag, props, withQr }: { tag: string; props: Record<string, unknown>; withQr?: boolean }) {
  const gate = useContext(RevealGate);
  const [shown, setShown] = useState(false);
  const withheld = !!gate?.withheld;
  useEffect(() => {
    if (withheld) { setShown(false); return; }
    let id = requestAnimationFrame(() => { id = requestAnimationFrame(() => setShown(true)); });
    return () => cancelAnimationFrame(id);
  }, [withheld]);
  if (!gate?.gated) return createElement(tag, props);
  const base = (props.style ?? {}) as Record<string, unknown>;
  if (withheld) {
    return <WaitingPanel base={base} title={String(props.title ?? '')} src={String(props.src ?? '')} withQr={!!withQr} ring={gate.ring} onPlaced={gate.setRingPlaced} />;
  }
  const reduced = prefersReducedMotion();
  return createElement(tag, {
    ...props,
    style: { ...base, opacity: shown || reduced ? 1 : 0, transition: reduced ? 'none' : 'opacity 700ms ease' },
  });
}

/**
 * Stands in for withheld results: the question and a neutral line at the top
 * left, and the big ring in the free space of the results area, never over
 * the text. The QR lives on the scan slide before, unless the embed opts in
 * with data-live-waiting="qr".
 */
function WaitingPanel({ base, title, src, withQr, ring, onPlaced }: {
  base: Record<string, unknown>; title: string; src: string; withQr: boolean; ring: BigRing | null; onPlaced: (placed: boolean) => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const headRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);
  const [geo, setGeo] = useState<{
    rect: { left: number; top: number }; k: number; w: number; h: number; spot: { x: number; y: number; size: number } | null;
  } | null>(null);
  const reduced = prefersReducedMotion();
  useLayoutEffect(() => {
    const panel = panelRef.current, head = headRef.current, text = textRef.current;
    if (!panel || !head || !text) return;
    // Layout in the panel's own pixels: offset* ignore transforms, and decks
    // often scale live embeds (transform: scale(2)). The rect is only for
    // mapping the authored timer's slide position into those pixels.
    const w = panel.offsetWidth, h = panel.offsetHeight;
    const r = panel.getBoundingClientRect();
    const k = w ? r.width / w : 1;
    const spot = bigRingBox(
      { width: w, height: h },
      { width: head.offsetLeft + text.offsetLeft + text.offsetWidth, height: head.offsetTop + head.offsetHeight },
      { beside: !withQr },
    );
    const next = { rect: { left: r.left, top: r.top }, k, w, h, spot };
    setGeo((g) => (g && JSON.stringify(g) === JSON.stringify(next) ? g : next));
  });
  const placed = !!geo?.spot;
  // Every render, so a remounted frame cannot leave it stale.
  useLayoutEffect(() => { onPlaced(placed); });
  useEffect(() => () => onPlaced(false), [onPlaced]);
  const join = withQr ? src.replace(/\/board(\?.*)?$/, '') : '';
  const sans = "Inter, system-ui, -apple-system, 'Segoe UI', sans-serif";

  let ringEl: ReactNode = null;
  if (ring && geo?.spot) {
    const { spot } = geo;
    let transform = 'none';
    if (!ring.big && ring.box) {
      // Shrink toward the authored timer, fading as the timer fades in there.
      const t = ringShrinkTransform(spot, geo.rect, geo.k, ring.box);
      transform = `translate(${t.dx}px, ${t.dy}px) scale(${t.scale})`;
    }
    ringEl = (
      <div
        data-timer-big-ring="true"
        style={{
          position: 'absolute', left: spot.x, top: spot.y, width: spot.size, height: spot.size,
          transformOrigin: 'center center', transform, opacity: ring.big ? 1 : 0,
          transition: reduced ? 'none' : 'transform 900ms cubic-bezier(.2,.7,.2,1), opacity 700ms ease',
          fontFamily: sans, color: ring.color,
        }}
        dangerouslySetInnerHTML={{ __html: ring.svg }}
      />
    );
  }

  return (
    <div
      ref={panelRef}
      data-live-withheld="true"
      style={{ ...base, boxSizing: 'border-box', pointerEvents: 'none', fontFamily: sans, color: 'inherit' }}
    >
      <div ref={headRef} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 24, padding: '24px 28px 0' }}>
        <div ref={textRef} style={{ maxWidth: '60%' }}>
          <div style={{ fontSize: 30, fontWeight: 700, lineHeight: 1.2 }}>{title}</div>
          <div style={{ fontSize: 16, marginTop: 10, opacity: 0.6 }}>Answers are coming in · results at the end</div>
        </div>
        {join && (
          <div style={{ textAlign: 'center', flex: 'none' }}>
            <img src={`${join}/qr`} alt="" style={{ width: 110, height: 110, display: 'block', margin: '0 auto' }} />
            <div style={{ fontSize: 11, marginTop: 6, opacity: 0.6 }}>{join.replace(/^https?:\/\//, '')}</div>
          </div>
        )}
      </div>
      {ringEl}
    </div>
  );
}
