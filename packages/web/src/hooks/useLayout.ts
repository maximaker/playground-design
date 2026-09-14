/**
 * Viewport-driven layout mode.
 *
 * A design tool wants three columns and rarely gets the width for them. Rather
 * than scattering media queries through components, one hook decides the mode
 * and the shell reacts: below `compact` the side panels become overlay drawers,
 * and below `narrow` the chrome condenses to icons.
 */

import { useEffect, useState } from 'react';

export type LayoutMode = 'wide' | 'compact' | 'narrow';

/** Kept in sync with the breakpoints in styles.css. */
export const BREAKPOINTS = { compact: 1024, narrow: 700 } as const;

function modeFor(width: number): LayoutMode {
  // `<=` because the CSS uses max-width, which is inclusive. Off by one here
  // and at exactly 1024px the panels are absolutely positioned by CSS while
  // React still thinks they are docked.
  if (width <= BREAKPOINTS.narrow) return 'narrow';
  if (width <= BREAKPOINTS.compact) return 'compact';
  return 'wide';
}

export function useLayoutMode(): LayoutMode {
  const [mode, setMode] = useState<LayoutMode>(() =>
    typeof window === 'undefined' ? 'wide' : modeFor(window.innerWidth),
  );

  useEffect(() => {
    const update = () => setMode((prev) => {
      const next = modeFor(window.innerWidth);
      return next === prev ? prev : next;
    });
    update();
    window.addEventListener('resize', update);
    // Rotating a tablet fires resize late on some browsers.
    window.addEventListener('orientationchange', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);

  return mode;
}

/** True when panels overlay the canvas rather than sitting beside it. */
export function panelsOverlay(mode: LayoutMode): boolean {
  return mode !== 'wide';
}

export function isTouch(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true;
}
