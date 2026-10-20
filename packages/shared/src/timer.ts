/**
 * Countdown timers on slides.
 *
 * A slide's HTML is sanitized — no scripts — so a timer cannot be a little
 * program on the page. It is an element the renderers understand instead: a
 * `<div data-timer="180">` whose settings are attributes and whose face is an
 * SVG generated here. Export, thumbnails, the headless screenshot and the
 * canvas all draw that face at full duration; presentation mode redraws it
 * every tick from the timing state below. The face uses currentColor, so it
 * takes the colour of the text around it, and the last 30 seconds switch to
 * the Tempo "now" orange.
 */

import { type CanvasNode, getArtboardSize, makeNode } from './model.ts';

export const TIMER_ATTR = 'data-timer';
export const TIMER_START_ATTR = 'data-timer-start';
export const TIMER_STYLE_ATTR = 'data-timer-style';
export const TIMER_END_ATTR = 'data-timer-end';
export const TIMER_CHIME_ATTR = 'data-timer-chime';
export const TIMER_LABEL_ATTR = 'data-timer-label';
/** "live": live results embeds on the same slide stay hidden until the timer ends. */
export const TIMER_REVEAL_ATTR = 'data-timer-reveal';

export type TimerStart = 'slide' | 'click';
export type TimerVariant = 'ring' | 'pill' | 'bar';
export type TimerEnd = 'message' | 'pulse';
export type TimerReveal = 'live' | 'none';

export interface TimerSpec {
  /** Whole seconds, 1..5999 (99:59). */
  seconds: number;
  start: TimerStart;
  variant: TimerVariant;
  end: TimerEnd;
  chime: boolean;
  label: string;
  /**
   * "live": in Present, live results on the same slide are withheld until the
   * timer ends, and the timer shows big until its last 10%. Defaults to "live"
   * for a timer that starts with the slide, "none" for one started by click.
   */
  reveal: TimerReveal;
}

export const TIMER_MAX_SECONDS = 99 * 60 + 59;
export const TIMER_LABEL_MAX = 60;
/** The stretch at the end drawn in the "now" accent. */
export const TIMER_URGENT_MS = 30_000;
/** Tempo's "now" orange; slides do not carry the app's tokens, so it is literal. */
export const TIMER_NOW_COLOR = '#e2531e';

export const DEFAULT_TIMER: TimerSpec = { seconds: 180, start: 'slide', variant: 'ring', end: 'message', chime: false, label: '', reveal: 'live' };

export function clampSeconds(raw: unknown): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(TIMER_MAX_SECONDS, n);
}

/** Minutes and seconds as an author writes them, to whole seconds. */
export function durationFrom(minutes: unknown, seconds: unknown): number {
  const m = Number(minutes ?? 0) || 0;
  const s = Number(seconds ?? 0) || 0;
  return clampSeconds(m * 60 + s);
}

export function isTimer(node: Pick<CanvasNode, 'attrs'> | undefined | null): boolean {
  return !!node && node.attrs[TIMER_ATTR] !== undefined;
}

/** The spec from a node's attributes; anything unknown falls back to the default. */
export function readTimer(attrs: Record<string, string | undefined>): TimerSpec {
  const start = attrs[TIMER_START_ATTR] === 'click' ? 'click' : 'slide';
  const v = attrs[TIMER_STYLE_ATTR];
  const variant: TimerVariant = v === 'pill' || v === 'bar' ? v : 'ring';
  const end: TimerEnd = attrs[TIMER_END_ATTR] === 'pulse' ? 'pulse' : 'message';
  return {
    seconds: clampSeconds(attrs[TIMER_ATTR] ?? DEFAULT_TIMER.seconds),
    start, variant, end,
    chime: attrs[TIMER_CHIME_ATTR] === 'true',
    label: (attrs[TIMER_LABEL_ATTR] ?? '').slice(0, TIMER_LABEL_MAX),
    reveal: readReveal(attrs[TIMER_REVEAL_ATTR], start),
  };
}

function readReveal(raw: string | undefined, start: TimerStart): TimerReveal {
  if (raw === 'live' || raw === 'none') return raw;
  return start === 'slide' ? 'live' : 'none';
}

export function timerAttrs(spec: Partial<TimerSpec>): Record<string, string> {
  const s = { ...DEFAULT_TIMER, ...spec };
  const out: Record<string, string> = {
    [TIMER_ATTR]: String(clampSeconds(s.seconds)),
    [TIMER_START_ATTR]: s.start,
    [TIMER_STYLE_ATTR]: s.variant,
    [TIMER_END_ATTR]: s.end,
    [TIMER_REVEAL_ATTR]: spec.reveal ?? (s.start === 'slide' ? 'live' : 'none'),
  };
  if (s.chime) out[TIMER_CHIME_ATTR] = 'true';
  if (s.label) out[TIMER_LABEL_ATTR] = s.label.slice(0, TIMER_LABEL_MAX);
  return out;
}

/** `<timer minutes="3" seconds="0" autostart="slide" ...>` as written by an agent. */
export function timerSpecFromTag(attrs: Record<string, string>): { spec: TimerSpec; warnings: string[] } {
  const warnings: string[] = [];
  const a = Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k.toLowerCase(), v]));
  const auto = (a.autostart ?? a.start ?? 'slide').toLowerCase();
  if (!['slide', 'click', 'true', 'false'].includes(auto)) warnings.push(`<timer autostart="${auto}">: use "slide" or "click"; used "slide".`);
  const variant = (a.variant ?? a.look ?? 'ring').toLowerCase();
  if (!['ring', 'pill', 'bar'].includes(variant)) warnings.push(`<timer variant="${variant}">: use ring, pill or bar; used ring.`);
  if (a.reveal !== undefined && a.reveal !== 'live' && a.reveal !== 'none') warnings.push(`<timer reveal="${a.reveal}">: use live or none.`);
  const end = (a.end ?? 'message').toLowerCase();
  if (!['message', 'pulse'].includes(end)) warnings.push(`<timer end="${end}">: use message or pulse; used message.`);
  const total = (Number(a.minutes ?? 0) || 0) * 60 + (Number(a.seconds ?? 0) || 0);
  if (total < 1) warnings.push('<timer> needs minutes and/or seconds; used 1 second.');
  if (total > TIMER_MAX_SECONDS) warnings.push('<timer> is capped at 99:59.');
  return {
    spec: readTimer({
      [TIMER_ATTR]: String(total),
      [TIMER_START_ATTR]: auto === 'click' || auto === 'false' ? 'click' : 'slide',
      [TIMER_STYLE_ATTR]: variant,
      [TIMER_END_ATTR]: end,
      [TIMER_CHIME_ATTR]: a.chime === '' || a.chime === 'true' ? 'true' : 'false',
      [TIMER_LABEL_ATTR]: a.label ?? '',
      ...(a.reveal === 'live' || a.reveal === 'none' ? { [TIMER_REVEAL_ATTR]: a.reveal } : {}),
    }),
    warnings,
  };
}

/** Natural aspect of each face, width / height. */
export const TIMER_ASPECT: Record<TimerVariant, number> = { ring: 1, pill: 2.5, bar: 5 };

/** A timer node, placed absolutely; centred on the artboard unless told where. */
export function makeTimerNode(spec: Partial<TimerSpec>, opts: {
  artboard?: CanvasNode; x?: number; y?: number; width?: number; height?: number; color?: string; font?: string;
} = {}): CanvasNode {
  const s = { ...DEFAULT_TIMER, ...spec };
  const board = opts.artboard ? getArtboardSize(opts.artboard) : { width: 1280, height: 720 };
  const aspect = TIMER_ASPECT[s.variant];
  const width = Math.round(opts.width ?? (s.variant === 'ring' ? Math.min(board.width, board.height) * 0.45 : s.variant === 'pill' ? board.width * 0.3 : board.width * 0.6));
  const height = Math.round(opts.height ?? width / aspect);
  const x = Math.round(opts.x ?? (board.width - width) / 2);
  const y = Math.round(opts.y ?? (board.height - height) / 2);
  return makeNode({
    type: 'frame',
    tag: 'div',
    name: `Timer ${formatClock(s.seconds * 1000)}`,
    attrs: timerAttrs(spec.reveal ? s : { ...s, reveal: s.start === 'slide' ? 'live' : 'none' }),
    styles: {
      position: 'absolute', left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px`,
      // Tempo's face: a clean sans with tabular figures reads across a room.
      'font-family': opts.font ?? "Inter, system-ui, -apple-system, 'Segoe UI', sans-serif",
      ...(opts.color ? { color: opts.color } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

export type TimerStatus = 'idle' | 'running' | 'paused' | 'done';

/**
 * Elapsed time is banked on pause and measured from `since` while running, so
 * a background tab that throttles ticks still shows the right number.
 */
export interface TimerState {
  status: TimerStatus;
  /** ms banked before the current run. */
  banked: number;
  /** When the current run started (running only). */
  since: number;
}

export const IDLE: TimerState = { status: 'idle', banked: 0, since: 0 };

export function elapsedMs(state: TimerState, now: number): number {
  return state.banked + (state.status === 'running' ? Math.max(0, now - state.since) : 0);
}

export function remainingMs(state: TimerState, durationMs: number, now: number): number {
  return Math.max(0, durationMs - elapsedMs(state, now));
}

export function startTimer(state: TimerState, now: number): TimerState {
  if (state.status === 'running' || state.status === 'done') return state;
  return { status: 'running', banked: state.banked, since: now };
}

export function pauseTimer(state: TimerState, now: number): TimerState {
  if (state.status !== 'running') return state;
  return { status: 'paused', banked: elapsedMs(state, now), since: 0 };
}

export function resetTimer(): TimerState {
  return IDLE;
}

/** Click or T: start, pause, resume; on a finished timer, start again from the top. */
export function toggleTimer(state: TimerState, now: number): TimerState {
  if (state.status === 'running') return pauseTimer(state, now);
  if (state.status === 'done') return startTimer(IDLE, now);
  return startTimer(state, now);
}

/** Moves a running timer to done once it has run out. */
export function tickTimer(state: TimerState, durationMs: number, now: number): TimerState {
  if (state.status === 'running' && elapsedMs(state, now) >= durationMs) return { status: 'done', banked: durationMs, since: 0 };
  return state;
}

/** In the last 30 seconds of a timer that has started. */
export function isUrgent(state: TimerState, durationMs: number, now: number): boolean {
  if (state.status === 'idle') return false;
  return remainingMs(state, durationMs, now) <= TIMER_URGENT_MS;
}

// ---------------------------------------------------------------------------
// Reveal: results withheld until time is up
// ---------------------------------------------------------------------------

/** The timer shows big, centred, for this share of its duration; then it shrinks to its place. */
export const TIMER_BIG_FRACTION = 0.9;

export interface RevealStage {
  /** Draw the timer big and centred on the slide (else at its authored box). */
  big: boolean;
  /** Live results on the slide may be shown. */
  results: boolean;
}

/**
 * Where a revealing timer is in its run. Results stay withheld until the timer
 * is done or the presenter reveals early; the timer is big while it waits or
 * runs through its first 90%, then sits small in its authored place.
 */
export function revealStage(state: TimerState, durationMs: number, now: number, revealedEarly = false): RevealStage {
  if (revealedEarly || state.status === 'done') return { big: false, results: true };
  if (state.status === 'idle') return { big: true, results: false };
  return { big: elapsedMs(state, now) < durationMs * TIMER_BIG_FRACTION, results: false };
}

/** Smallest big ring worth showing; below this the timer simply stays small. */
export const BIG_RING_MIN = 120;
/** A ring is "comfortably big" from here; space permitting it is never smaller. */
export const BIG_RING_TARGET_MIN = 240;

/**
 * Where the big ring goes inside a withheld results panel: the largest square
 * that fits below the panel's header (question and waiting line) or beside
 * it, with clear margins, so it never covers any text. Panel coordinates.
 * Null when there is no room for a useful ring.
 */
export function bigRingBox(
  panel: { width: number; height: number },
  header: { width: number; height: number },
  opts: { beside?: boolean } = {},
): { x: number; y: number; size: number } | null {
  const m = Math.max(24, Math.round(Math.min(panel.width, panel.height) * 0.05));
  const areas = [
    { x: m, y: header.height + m, w: panel.width - 2 * m, h: panel.height - header.height - 2 * m },
  ];
  if (opts.beside !== false) areas.push({ x: header.width + m, y: m, w: panel.width - header.width - 2 * m, h: panel.height - 2 * m });
  let best: { x: number; y: number; size: number } | null = null;
  for (const a of areas) {
    const size = Math.floor(Math.min(a.w, a.h));
    if (size < BIG_RING_MIN || (best && best.size >= size)) continue;
    best = { x: Math.round(a.x + (a.w - size) / 2), y: Math.round(a.y + (a.h - size) / 2), size };
  }
  return best;
}

/**
 * The transform that shrinks the big ring onto the authored timer. The panel
 * may itself be transformed (decks scale live embeds with `transform:
 * scale(2)`), so the ring lives in the panel's own pixels while the timer box
 * and the panel's rect are in slide pixels; `panelScale` converts between them.
 */
export function ringShrinkTransform(
  spot: { x: number; y: number; size: number },
  panelRect: { left: number; top: number },
  panelScale: number,
  target: { x: number; y: number; width: number; height: number },
): { dx: number; dy: number; scale: number } {
  const k = panelScale > 0 ? panelScale : 1;
  const cx = (target.x + target.width / 2 - panelRect.left) / k;
  const cy = (target.y + target.height / 2 - panelRect.top) / k;
  return {
    dx: cx - (spot.x + spot.size / 2),
    dy: cy - (spot.y + spot.size / 2),
    scale: Math.min(target.width, target.height) / k / spot.size,
  };
}

/** The state a timer starts in when its slide is shown: slide-start timers run from that moment. */
export function timerOnShow(spec: Pick<TimerSpec, 'start'>, shownAt: number): TimerState {
  return spec.start === 'slide' ? startTimer(IDLE, shownAt) : IDLE;
}

/** m:ss, rounding up so 0:00 means time is up and the first second shows the full duration. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Face
// ---------------------------------------------------------------------------

export interface TimerFace {
  remainingMs: number;
  /** 0..1 of the duration left. */
  fraction: number;
  done: boolean;
  urgent: boolean;
  paused?: boolean;
  /** No progress drawing, no pulse: just the numbers. */
  reducedMotion?: boolean;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The static face: the full duration, as export and the canvas show it. */
export function staticFace(spec: TimerSpec): TimerFace {
  return { remainingMs: spec.seconds * 1000, fraction: 1, done: false, urgent: false };
}

/**
 * The timer's SVG. Sized by its box (100% × 100%), coloured by currentColor,
 * numbers in tabular figures so they do not jitter as they change.
 */
export function timerSvg(spec: TimerSpec, face: TimerFace = staticFace(spec)): string {
  const fraction = face.reducedMotion ? 1 : Math.max(0, Math.min(1, face.fraction));
  const ended = face.done && spec.end === 'message';
  const clock = ended ? 'Time’s up' : formatClock(face.remainingMs);
  const label = spec.label ? esc(spec.label) : '';
  const pulse = face.done && spec.end === 'pulse' && !face.reducedMotion;
  const color = face.urgent || face.done ? `color:${TIMER_NOW_COLOR};` : '';
  const text = 'font-family:inherit;font-variant-numeric:tabular-nums;font-feature-settings:"tnum";';
  const css = pulse
    ? '<style>@keyframes pg-timer-pulse{0%,100%{opacity:1}50%{opacity:.35}}.pg-timer-pulse{animation:pg-timer-pulse 1.4s ease-in-out infinite}@media (prefers-reduced-motion: reduce){.pg-timer-pulse{animation:none}}</style>'
    : '';
  const open = (w: number, h: number) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" role="timer" aria-label="${esc(label ? `${spec.label}: ${clock}` : clock)}" style="display:block;overflow:visible;${color}">${css}<g${pulse ? ' class="pg-timer-pulse"' : ''}${face.paused ? ' opacity="0.55"' : ''}>`;
  const close = '</g></svg>';

  if (spec.variant === 'pill') {
    const size = ended ? 40 : 52;
    return open(250, 100)
      + '<rect x="3" y="3" width="244" height="94" rx="47" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.35" stroke-width="3"/>'
      + (fraction < 1 && fraction > 0 ? `<path d="M125 3 H200 A47 47 0 0 1 200 97 H50 A47 47 0 0 1 50 3 Z" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" pathLength="1" stroke-dasharray="${fraction.toFixed(4)} 1"/>` : '')
      + `<text x="125" y="${label ? 56 : 52}" text-anchor="middle" dominant-baseline="middle" fill="currentColor" font-size="${size}" font-weight="600" style="${text}">${esc(clock)}</text>`
      + (label ? `<text x="125" y="84" text-anchor="middle" fill="currentColor" fill-opacity="0.7" font-size="15" style="${text}">${label}</text>` : '')
      + close;
  }

  if (spec.variant === 'bar') {
    const w = 500, h = 100;
    return open(w, h)
      + `<text x="0" y="52" fill="currentColor" font-size="${ended ? 44 : 56}" font-weight="600" style="${text}">${esc(clock)}</text>`
      + (label ? `<text x="${w}" y="52" text-anchor="end" fill="currentColor" fill-opacity="0.7" font-size="20" style="${text}">${label}</text>` : '')
      + `<rect x="0" y="76" width="${w}" height="14" rx="7" fill="currentColor" fill-opacity="0.15"/>`
      + `<rect x="0" y="76" width="${(w * fraction).toFixed(1)}" height="14" rx="7" fill="currentColor"/>`
      + close;
  }

  // ring
  const r = 88;
  return open(200, 200)
    + `<circle cx="100" cy="100" r="${r}" fill="none" stroke="currentColor" stroke-opacity="0.15" stroke-width="10"/>`
    + `<circle cx="100" cy="100" r="${r}" fill="none" stroke="currentColor" stroke-width="10" stroke-linecap="round" pathLength="1" stroke-dasharray="${fraction.toFixed(4)} 1" transform="rotate(-90 100 100)"${fraction <= 0 ? ' stroke-opacity="0"' : ''}/>`
    + `<text x="100" y="${label ? 96 : 102}" text-anchor="middle" dominant-baseline="middle" fill="currentColor" font-size="${ended ? 28 : face.remainingMs >= 600_000 ? 50 : 56}" font-weight="600" style="${text}">${esc(clock)}</text>`
    + (label ? `<text x="100" y="138" text-anchor="middle" fill="currentColor" fill-opacity="0.7" font-size="15" style="${text}">${label}</text>` : '')
    + close;
}
