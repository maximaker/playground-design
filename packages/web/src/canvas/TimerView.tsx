/**
 * A countdown on a slide.
 *
 * The canvas, thumbnails and export draw the static face (full duration). Only
 * a timer rendered inside the presented frame runs: Present wraps its frame in
 * PresentingTimers, so the editor canvas behind the presentation never ticks
 * or chimes. The frame is remounted for every slide, so going back to a slide
 * starts its timer over.
 */

import { createContext, createElement, useContext, useEffect, useRef, useState } from 'react';
import {
  IDLE, type TimerSpec, type TimerState, isUrgent, pauseTimer, readTimer, remainingMs, resetTimer, startTimer,
  tickTimer, timerSvg, toggleTimer,
} from '@playground/shared';

/** True inside the presented frame. */
export const PresentingTimers = createContext(false);

export type TimerAction = 'toggle' | 'reset' | 'start' | 'pause';

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
  const [state, setState] = useState<TimerState>(() => (spec.start === 'slide' ? startTimer(IDLE, Date.now()) : IDLE));
  const [now, setNow] = useState(() => Date.now());
  const ref = useRef<Element | null>(null);
  const reduced = useRef(prefersReducedMotion());

  useEffect(() => {
    const on = (e: Event) => {
      const { action, el } = (e as CustomEvent<{ action: TimerAction; el: Element | null }>).detail;
      if (el && el !== ref.current) return;
      const t = Date.now();
      setNow(t);
      setState((s) => {
        const now = tickTimer(s, duration, t);
        if (action === 'reset') return resetTimer();
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

  const left = remainingMs(state, duration, state.status === 'running' ? now : 0);
  const svg = timerSvg(spec, {
    remainingMs: left,
    fraction: left / duration,
    done: state.status === 'done',
    urgent: isUrgent(state, duration, now),
    paused: state.status === 'paused',
    reducedMotion: reduced.current,
  });
  return createElement(tag, {
    ...props,
    ref,
    'data-timer-status': state.status,
    title: state.status === 'running' ? 'Click or T to pause, R to reset' : 'Click or T to start, R to reset',
    dangerouslySetInnerHTML: { __html: svg },
  });
}
