/**
 * Selection rules for the canvas marquee and for dragging a group of
 * artboards, kept apart from the DOM so they can be tested.
 */
import type { CanvasDocument, NodeId } from './model.ts';

/**
 * What a marquee selects, given the design layers and board items it caught.
 *
 * Layers and board items cannot be selected together, so one wins:
 * - any fully enclosed artboard wins outright, and only artboards are kept —
 *   a marquee across three slides and the edge of a fourth means "these three
 *   slides", not "three slides and the title layer of the fourth";
 * - otherwise layers win over board items, as before;
 * - a marquee that only reaches the board takes the board items.
 */
export function marqueePick(
  doc: CanvasDocument,
  hits: NodeId[],
  boardHits: string[],
): { nodes: NodeId[]; board: string[] } {
  const artboards = hits.filter((id) => doc.nodes[id]?.parent === null);
  if (artboards.length) return { nodes: artboards, board: [] };
  if (hits.length || !boardHits.length) return { nodes: hits, board: [] };
  return { nodes: [], board: boardHits };
}

/**
 * The artboards a drag that starts on `pressed` should move.
 *
 * Pressing an artboard that is part of a multi-artboard selection moves the
 * whole selection, the way Figma moves a group of frames; pressing one that
 * is not selected moves just that one. Only top-level artboards are returned.
 */
export function artboardsToMove(doc: CanvasDocument, selection: NodeId[], pressed: NodeId): NodeId[] {
  if (!selection.includes(pressed)) return [pressed];
  const group = selection.filter((id) => doc.nodes[id]?.parent === null);
  return group.length ? group : [pressed];
}

/** Within this many pixels of the canvas edge, a drag scrolls the canvas. */
export const AUTO_PAN_EDGE = 48;
/** Scroll speed at the very edge, in screen pixels per frame. */
export const AUTO_PAN_MAX = 18;

/**
 * How far to scroll the view this frame for a pointer at `pos` on an axis
 * whose visible span is `min`..`max`: positive near the start edge (the view
 * moves right/down, revealing what is left/above), negative near the end, and
 * zero outside the edge band. Speed grows with closeness and is capped.
 */
export function edgeSpeed(pos: number, min: number, max: number): number {
  if (pos < min + AUTO_PAN_EDGE) return Math.round(AUTO_PAN_MAX * Math.min(1, (min + AUTO_PAN_EDGE - pos) / AUTO_PAN_EDGE));
  if (pos > max - AUTO_PAN_EDGE) return -Math.round(AUTO_PAN_MAX * Math.min(1, (pos - (max - AUTO_PAN_EDGE)) / AUTO_PAN_EDGE));
  return 0;
}
