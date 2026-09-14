/**
 * Appearance: theme and interface scale.
 *
 * Kept out of the document store because it is a per-person preference, not
 * part of the design — two people editing the same file should be able to
 * disagree about dark mode.
 */

export type Theme = 'dark' | 'light' | 'system';

export interface Appearance {
  theme: Theme;
  /** Multiplier on the base UI size. Everything is rem-based, so this scales all of it. */
  scale: number;
  /** Base UI size in px, before scaling — a density preference. */
  base: number;
}

const KEY = 'playground.appearance';

export const DEFAULT_APPEARANCE: Appearance = { theme: 'system', scale: 1, base: 13 };

export const SCALE_RANGE = { min: 0.85, max: 1.6, step: 0.05 };

export function loadAppearance(): Appearance {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_APPEARANCE };
    const parsed = JSON.parse(raw) as Partial<Appearance>;
    return {
      theme: parsed.theme === 'dark' || parsed.theme === 'light' ? parsed.theme : 'system',
      scale: clamp(Number(parsed.scale) || 1, SCALE_RANGE.min, SCALE_RANGE.max),
      base: clamp(Number(parsed.base) || 13, 11, 18),
    };
  } catch {
    // Private mode, blocked storage, corrupt value — the defaults are fine.
    return { ...DEFAULT_APPEARANCE };
  }
}

export function saveAppearance(appearance: Appearance): void {
  try { localStorage.setItem(KEY, JSON.stringify(appearance)); } catch { /* not critical */ }
}

/** Writes the appearance onto the document element, where the CSS reads it. */
export function applyAppearance(appearance: Appearance): void {
  const root = document.documentElement;
  const resolved = appearance.theme === 'system' ? systemTheme() : appearance.theme;
  root.dataset.theme = resolved;
  root.style.setProperty('--ui-scale', String(appearance.scale));
  root.style.setProperty('--ui-base', `${appearance.base}px`);
}

export function systemTheme(): 'dark' | 'light' {
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** Re-applies when the OS theme changes, while the preference is "system". */
export function watchSystemTheme(onChange: () => void): () => void {
  const media = window.matchMedia?.('(prefers-color-scheme: light)');
  if (!media) return () => {};
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
