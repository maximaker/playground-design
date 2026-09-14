/**
 * Pointer interaction logic for the canvas, kept out of the component so the
 * geometry is testable and readable on its own.
 */

import {
  type CanvasDocument, type CanvasNode, type NodeId, type Op,
  getArtboardPosition, getArtboardSize, isAncestorOf,
} from '@canvas/shared';
import { nodeRect, nodeInnerRect, hitTest } from './registry.ts';
import { parsePx } from './styles.ts';
import { type Box, type SnapGuide, boxOf, computeSnap, snapResize } from '@canvas/shared';

/** Snap strength in screen pixels; converted to working units by the caller. */
export const SNAP_THRESHOLD_PX = 6;

export interface Viewport { x: number; y: number; zoom: number }

/** Screen point -> canvas-space point. */
export function toCanvasSpace(clientX: number, clientY: number, vp: Viewport): { x: number; y: number } {
  return { x: (clientX - vp.x) / vp.zoom, y: (clientY - vp.y) / vp.zoom };
}

/** Canvas-space point -> screen point. */
export function toScreen(x: number, y: number, vp: Viewport): { x: number; y: number } {
  return { x: x * vp.zoom + vp.x, y: y * vp.zoom + vp.y };
}

export const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
export type Handle = (typeof HANDLES)[number];

// ---------------------------------------------------------------------------
// Snap candidate collection
// ---------------------------------------------------------------------------

/** Artboards on the page, in canvas space — what a dragged artboard snaps to. */
export function artboardBoxes(doc: CanvasDocument, artboards: NodeId[], exclude: NodeId[] = []): Box[] {
  return artboards.flatMap((id) => {
    if (exclude.includes(id)) return [];
    const node = doc.nodes[id];
    if (!node) return [];
    const pos = getArtboardPosition(node);
    const size = getArtboardSize(node);
    return [boxOf(id, pos.x, pos.y, size.width, size.height)];
  });
}

/**
 * Siblings of an absolutely-positioned node, in the parent's local CSS pixels.
 * Measured from the rendered DOM rather than style values, because a hugging or
 * wrapping element has no authored size at all.
 */
export function siblingBoxes(
  doc: CanvasDocument,
  nodeId: NodeId,
  exclude: NodeId[],
): { boxes: Box[]; container: Box | null } {
  const node = doc.nodes[nodeId];
  const parentId = node?.parent;
  if (!parentId) return { boxes: [], container: null };

  const parentRect = nodeInnerRect(parentId);
  if (!parentRect) return { boxes: [], container: null };

  const boxes = (doc.nodes[parentId]?.children ?? []).flatMap((childId) => {
    if (exclude.includes(childId)) return [];
    const rect = nodeInnerRect(childId);
    if (!rect) return [];
    return [boxOf(childId, rect.left - parentRect.left, rect.top - parentRect.top, rect.width, rect.height)];
  });

  return {
    boxes,
    container: boxOf(parentId, 0, 0, parentRect.width, parentRect.height),
  };
}

export function snapMove(
  moving: Box,
  candidates: Box[],
  zoom: number,
  container: Box | null = null,
): { dx: number; dy: number; guides: SnapGuide[] } {
  return computeSnap(moving, candidates, SNAP_THRESHOLD_PX / zoom, { container });
}

export function snapResizeEdges(
  moving: Box,
  candidates: Box[],
  handle: Handle,
  zoom: number,
  container: Box | null = null,
): { dx: number; dy: number; guides: SnapGuide[] } {
  return snapResize(moving, candidates, handle, SNAP_THRESHOLD_PX / zoom, container);
}

// ---------------------------------------------------------------------------
// Drop targeting
// ---------------------------------------------------------------------------

export interface DropTarget {
  parentId: NodeId;
  index: number;
  /** Screen-space line to draw showing where the node will land. */
  indicator: { x: number; y: number; length: number; horizontal: boolean } | null;
}

/**
 * Works out where a dragged node would land.
 *
 * The rule that matches what people expect: hovering a *sibling* inserts beside
 * it, hovering a different container drops inside it. Without the sibling case,
 * dragging one card past another nests it inside that card instead of
 * reordering the row — technically a valid move, never the intended one.
 */
export function computeDropTarget(
  doc: CanvasDocument,
  dragged: NodeId[],
  clientX: number,
  clientY: number,
): DropTarget | null {
  const hit = hitTest(clientX, clientY);
  if (!hit) return null;

  const isLegalContainer = (n: CanvasNode | undefined): boolean =>
    !!n &&
    n.type !== 'text' && n.type !== 'image' && n.type !== 'vector' && n.type !== 'embed' &&
    !dragged.includes(n.id) &&
    !dragged.some((d) => isAncestorOf(doc, d, n.id));

  // Walk up from whatever is under the cursor to the nearest legal container.
  let candidate: CanvasNode | undefined = doc.nodes[hit.nodeId];
  while (candidate !== undefined && !isLegalContainer(candidate)) {
    const parentId: NodeId | null = candidate.parent;
    candidate = parentId ? doc.nodes[parentId] : undefined;
  }
  if (candidate === undefined) return null;

  // If the cursor is over a sibling of what we are dragging, the gesture is a
  // reorder: target the shared parent and use the sibling as the anchor.
  const draggedParents = new Set(dragged.map((d) => doc.nodes[d]?.parent ?? null));
  let parent: CanvasNode = candidate;
  let anchorId: NodeId | null = null;

  if (candidate.parent && draggedParents.has(candidate.parent)) {
    const p = doc.nodes[candidate.parent];
    if (p && isLegalContainer(p)) { parent = p; anchorId = candidate.id; }
  }

  const siblings = parent.children.filter((c) => !dragged.includes(c));
  const horizontal = parent.styles.display?.includes('flex')
    ? (parent.styles['flex-direction'] ?? 'row').startsWith('row')
    : false;

  if (siblings.length === 0) {
    const rect = nodeRect(parent.id);
    return {
      parentId: parent.id,
      index: 0,
      indicator: rect
        ? { x: rect.left + 8, y: rect.top + 8, length: Math.max(0, (horizontal ? rect.height : rect.width) - 16), horizontal: !horizontal }
        : null,
    };
  }

  // Decide which gap the cursor is nearest, along the container's main axis.
  let index = siblings.length;
  if (anchorId) {
    const rect = nodeRect(anchorId);
    const pointer = horizontal ? clientX : clientY;
    const mid = rect ? (horizontal ? rect.left + rect.width / 2 : rect.top + rect.height / 2) : pointer;
    index = siblings.indexOf(anchorId) + (pointer < mid ? 0 : 1);
  } else {
    for (let i = 0; i < siblings.length; i++) {
      const rect = nodeRect(siblings[i]!);
      if (!rect) continue;
      const mid = horizontal ? rect.left + rect.width / 2 : rect.top + rect.height / 2;
      if ((horizontal ? clientX : clientY) < mid) { index = i; break; }
    }
  }

  const clamped = Math.max(0, Math.min(index, siblings.length));
  const anchor = siblings[Math.min(clamped, siblings.length - 1)]!;
  const anchorRect = nodeRect(anchor);
  const after = clamped >= siblings.length || siblings[clamped] !== anchor;

  return {
    // Index is expressed against the parent's real children list, which still
    // contains the dragged nodes until the move is applied.
    parentId: parent.id,
    index: parent.children.indexOf(anchor) + (after ? 1 : 0),
    indicator: anchorRect
      ? horizontal
        ? { x: after ? anchorRect.right : anchorRect.left, y: anchorRect.top, length: anchorRect.height, horizontal: false }
        : { x: anchorRect.left, y: after ? anchorRect.bottom : anchorRect.top, length: anchorRect.width, horizontal: true }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Resize
// ---------------------------------------------------------------------------

export interface ResizeStart {
  id: NodeId;
  handle: Handle;
  width: number;
  height: number;
  /** Authored left/top, only meaningful when `absolute`. */
  left: number;
  top: number;
  /** Rendered position in the parent's local space, used for snapping. */
  originLeft: number;
  originTop: number;
  absolute: boolean;
}

/** The box a resize would produce, before snapping, in working units. */
export function resizeBox(start: ResizeStart, dx: number, dy: number): Box {
  const h = start.handle;
  let left = 0;
  let top = 0;
  let width = start.width;
  let height = start.height;
  if (h.includes('e')) width = start.width + dx;
  if (h.includes('w')) { width = start.width - dx; left = dx; }
  if (h.includes('s')) height = start.height + dy;
  if (h.includes('n')) { height = start.height - dy; top = dy; }
  return boxOf(start.id, start.originLeft + left, start.originTop + top, width, height);
}

export function beginResize(doc: CanvasDocument, id: NodeId, handle: Handle): ResizeStart | null {
  const node = doc.nodes[id];
  // Measured in the node's own CSS pixels, not editor screen pixels: the drag
  // delta is converted to canvas space, so the starting size has to be too or
  // the resize is wrong by a factor of the zoom.
  const rect = nodeInnerRect(id);
  if (!node || !rect) return null;
  const absolute = node.styles.position === 'absolute' || node.styles.position === 'fixed';
  const parentRect = node.parent ? nodeInnerRect(node.parent) : null;
  return {
    id, handle,
    width: rect.width, height: rect.height,
    left: parsePx(node.styles.left), top: parsePx(node.styles.top),
    originLeft: parentRect ? rect.left - parentRect.left : 0,
    originTop: parentRect ? rect.top - parentRect.top : 0,
    absolute,
  };
}

/** Styles for a resize drag. `dx`/`dy` are in canvas space (zoom already removed). */
export function resizeStyles(start: ResizeStart, dx: number, dy: number, preserveRatio: boolean): Record<string, string> {
  const h = start.handle;
  let width = start.width;
  let height = start.height;
  let left = start.left;
  let top = start.top;

  if (h.includes('e')) width = start.width + dx;
  if (h.includes('w')) { width = start.width - dx; if (start.absolute) left = start.left + dx; }
  if (h.includes('s')) height = start.height + dy;
  if (h.includes('n')) { height = start.height - dy; if (start.absolute) top = start.top + dy; }

  if (preserveRatio && start.width > 0 && start.height > 0) {
    const ratio = start.width / start.height;
    if (h === 'e' || h === 'w') height = width / ratio;
    else if (h === 'n' || h === 's') width = height * ratio;
    else height = width / ratio;
  }

  const styles: Record<string, string> = {};
  if (h !== 'n' && h !== 's') styles.width = `${Math.max(1, Math.round(width))}px`;
  if (h !== 'e' && h !== 'w') styles.height = `${Math.max(1, Math.round(height))}px`;
  if (start.absolute) {
    if (h.includes('w')) styles.left = `${Math.round(left)}px`;
    if (h.includes('n')) styles.top = `${Math.round(top)}px`;
  }
  return styles;
}

// ---------------------------------------------------------------------------
// Marquee
// ---------------------------------------------------------------------------

/** Every node whose rendered box intersects a screen-space rect. */
export function nodesInRect(
  doc: CanvasDocument,
  page: { artboards: NodeId[] },
  rect: { left: number; top: number; right: number; bottom: number },
): NodeId[] {
  const hits: NodeId[] = [];
  for (const artboardId of page.artboards) {
    const artboard = doc.nodes[artboardId];
    if (!artboard) continue;
    // Select the artboard itself only when fully enclosed; otherwise look
    // inside it, so a marquee across a screen grabs elements, not the screen.
    const ar = nodeRect(artboardId);
    if (ar && ar.left >= rect.left && ar.right <= rect.right && ar.top >= rect.top && ar.bottom <= rect.bottom) {
      hits.push(artboardId);
      continue;
    }
    for (const child of artboardChildren(doc, artboardId)) {
      const r = nodeRect(child);
      if (!r) continue;
      if (r.right >= rect.left && r.left <= rect.right && r.bottom >= rect.top && r.top <= rect.bottom) {
        hits.push(child);
      }
    }
  }
  return hits;
}

/** Direct children of an artboard — marquee selects at one level, like Figma. */
function artboardChildren(doc: CanvasDocument, artboardId: NodeId): NodeId[] {
  return doc.nodes[artboardId]?.children ?? [];
}

// ---------------------------------------------------------------------------
// Artboard placement
// ---------------------------------------------------------------------------

/** A free spot to the right of everything on the page. */
export function nextArtboardPosition(doc: CanvasDocument, artboards: NodeId[]): { x: number; y: number } {
  let maxRight = 0;
  let top = 0;
  for (const id of artboards) {
    const n = doc.nodes[id];
    if (!n) continue;
    const pos = getArtboardPosition(n);
    const size = getArtboardSize(n);
    maxRight = Math.max(maxRight, pos.x + size.width);
    top = Math.min(top, pos.y);
  }
  return { x: artboards.length ? maxRight + 120 : 0, y: top };
}

export function buildMoveOps(
  doc: CanvasDocument,
  dragged: NodeId[],
  target: DropTarget,
): Op[] {
  const moves = dragged.map((id, i) => ({ id, parent: target.parentId, index: target.index + i }));
  return [{ t: 'move', moves }];
}
