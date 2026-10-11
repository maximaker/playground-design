/**
 * "View as": a page-wide theme preview.
 *
 * Reviewing dark mode used to mean duplicating every screen and setting
 * data-theme on the copies. This renders every artboard in the chosen theme
 * instead, without touching the document — it is a way of looking, like zoom,
 * so it is per-person and never synced. Artboards that pin a theme of their own
 * keep it: that is a design decision, and the preview should not paper over it.
 */

import { create } from 'zustand';
import type { CanvasDocument, NodeId } from '@playground/shared';
import { artboardTheme } from '@playground/shared';

interface ViewThemeState {
  /** The theme to preview, or null for each artboard as designed. */
  theme: string | null;
  setTheme: (theme: string | null) => void;
}

export const useViewTheme = create<ViewThemeState>((set) => ({
  theme: null,
  setTheme: (theme) => set({ theme }),
}));

/** Whether an artboard pins its own theme, so the preview leaves it alone. */
export function pinnedTheme(doc: CanvasDocument, artboardId: NodeId): string | null {
  const t = doc.nodes[artboardId]?.attrs['data-theme'];
  return t && doc.themes.includes(t) ? t : null;
}

/** The theme an artboard renders in, given the page-wide preview. */
export function effectiveTheme(doc: CanvasDocument, artboardId: NodeId, preview: string | null): string {
  if (preview && doc.themes.includes(preview) && !pinnedTheme(doc, artboardId)) return preview;
  return artboardTheme(doc, artboardId);
}
