/**
 * Canvas preferences: the dot grid, the edge rulers and snapping.
 *
 * Per-person and local, like theme and interface scale — two people editing the
 * same document should be able to disagree about whether they want rulers, and
 * turning snapping off must not turn it off for everyone else.
 *
 * Snapping also has a per-drag escape hatch (hold ⌘/Ctrl). The preference is for
 * the other case: laying out something freehand, where every drag catching on a
 * neighbour is the wrong default and holding a modifier for minutes is not a
 * fix.
 */

export interface CanvasPrefs {
  /** The dot grid under the artboards. */
  grid: boolean;
  /** Rulers along the top and left edges, in canvas pixels. */
  rulers: boolean;
  /** Snap to the edges and centres of neighbouring boxes while dragging. */
  snap: boolean;
  /**
   * Comment pins on the canvas.
   *
   * Off is for looking at the work: a design under review collects pins over
   * the thing they are about, and there was no way to see it without them.
   * Hiding them changes nothing about the comments themselves, which are still
   * in the panel.
   */
  comments: boolean;
}

const KEY = 'playground.canvas';

export const DEFAULT_CANVAS_PREFS: CanvasPrefs = {
  grid: true, rulers: false, snap: true, comments: true,
};

export function loadCanvasPrefs(): CanvasPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_CANVAS_PREFS };
    const parsed = JSON.parse(raw) as Partial<CanvasPrefs>;
    // Each key falls back on its own, so a stored value written by an older
    // build that did not have rulers still keeps the grid setting it did have.
    return {
      grid: typeof parsed.grid === 'boolean' ? parsed.grid : DEFAULT_CANVAS_PREFS.grid,
      rulers: typeof parsed.rulers === 'boolean' ? parsed.rulers : DEFAULT_CANVAS_PREFS.rulers,
      snap: typeof parsed.snap === 'boolean' ? parsed.snap : DEFAULT_CANVAS_PREFS.snap,
      comments: typeof parsed.comments === 'boolean' ? parsed.comments : DEFAULT_CANVAS_PREFS.comments,
    };
  } catch {
    // Private mode, blocked storage, corrupt value — the defaults are fine.
    return { ...DEFAULT_CANVAS_PREFS };
  }
}

export function saveCanvasPrefs(prefs: CanvasPrefs): void {
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* not critical */ }
}
