/**
 * Alignment, distribution and z-order.
 *
 * Alignment only means something for things that can be positioned
 * independently: artboards on the canvas, and absolutely-positioned children.
 * For a node in flex flow, the layout engine owns its position — so instead of
 * silently doing nothing (or worse, writing a left/top the engine ignores),
 * these operations tell the caller what they would need to change.
 */

import {
  type CanvasDocument, type NodeId, type Op,
  getArtboardPosition, getArtboardSize,
} from '@playground/shared';
import { nodeInnerRect } from './registry.ts';
import { parsePx } from './styles.ts';

export type AlignKind = 'left' | 'center-x' | 'right' | 'top' | 'center-y' | 'bottom';
export type DistributeKind = 'horizontal' | 'vertical';

interface Positionable {
  id: NodeId;
  kind: 'artboard' | 'absolute';
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ArrangeResult {
  ops: Op[];
  /** Ids that could not be moved because their parent's layout owns them. */
  skipped: NodeId[];
}

function positionables(doc: CanvasDocument, ids: NodeId[]): { items: Positionable[]; skipped: NodeId[] } {
  const items: Positionable[] = [];
  const skipped: NodeId[] = [];

  for (const id of ids) {
    const node = doc.nodes[id];
    if (!node) continue;

    if (node.parent === null) {
      const pos = getArtboardPosition(node);
      const size = getArtboardSize(node);
      items.push({ id, kind: 'artboard', left: pos.x, top: pos.y, width: size.width, height: size.height });
      continue;
    }

    const absolute = node.styles.position === 'absolute' || node.styles.position === 'fixed';
    if (!absolute) { skipped.push(id); continue; }

    const rect = nodeInnerRect(id);
    items.push({
      id, kind: 'absolute',
      left: parsePx(node.styles.left),
      top: parsePx(node.styles.top),
      width: rect?.width ?? 0,
      height: rect?.height ?? 0,
    });
  }

  return { items, skipped };
}

function toOps(items: Positionable[], next: Map<NodeId, { left: number; top: number }>): Op[] {
  const attrUpdates: { id: NodeId; attrs: Record<string, string> }[] = [];
  const styleUpdates: { id: NodeId; styles: Record<string, string> }[] = [];

  for (const item of items) {
    const target = next.get(item.id);
    if (!target) continue;
    if (Math.round(target.left) === Math.round(item.left) && Math.round(target.top) === Math.round(item.top)) continue;

    if (item.kind === 'artboard') {
      attrUpdates.push({ id: item.id, attrs: { 'data-x': String(Math.round(target.left)), 'data-y': String(Math.round(target.top)) } });
    } else {
      styleUpdates.push({ id: item.id, styles: { left: `${Math.round(target.left)}px`, top: `${Math.round(target.top)}px` } });
    }
  }

  const ops: Op[] = [];
  if (attrUpdates.length) ops.push({ t: 'attrs', updates: attrUpdates });
  if (styleUpdates.length) ops.push({ t: 'styles', updates: styleUpdates });
  return ops;
}

export function align(doc: CanvasDocument, ids: NodeId[], kind: AlignKind): ArrangeResult {
  const { items, skipped } = positionables(doc, ids);
  if (items.length === 0) return { ops: [], skipped };

  // One item has no bounding box of its own to align against, so it aligns
  // inside its container — which is what "align this left" means when there is
  // only one thing selected, and what every other design tool does.
  const bounds = items.length === 1 ? containerBounds(doc, items[0]!) : null;

  const minLeft = bounds ? bounds.left : Math.min(...items.map((i) => i.left));
  const maxRight = bounds ? bounds.left + bounds.width : Math.max(...items.map((i) => i.left + i.width));
  const minTop = bounds ? bounds.top : Math.min(...items.map((i) => i.top));
  const maxBottom = bounds ? bounds.top + bounds.height : Math.max(...items.map((i) => i.top + i.height));

  if (items.length === 1 && !bounds) return { ops: [], skipped };
  const midX = (minLeft + maxRight) / 2;
  const midY = (minTop + maxBottom) / 2;

  const next = new Map<NodeId, { left: number; top: number }>();
  for (const item of items) {
    let { left, top } = item;
    switch (kind) {
      case 'left': left = minLeft; break;
      case 'right': left = maxRight - item.width; break;
      case 'center-x': left = midX - item.width / 2; break;
      case 'top': top = minTop; break;
      case 'bottom': top = maxBottom - item.height; break;
      case 'center-y': top = midY - item.height / 2; break;
    }
    next.set(item.id, { left, top });
  }

  return { ops: toOps(items, next), skipped };
}

/**
 * The box a single item aligns inside.
 *
 * For an absolutely positioned child that is its parent's padding box, in the
 * parent's own coordinates — which is exactly what `left` and `top` are
 * relative to, so no conversion is needed. An artboard has no container, so it
 * has nothing to align against and says so by returning null.
 */
function containerBounds(doc: CanvasDocument, item: Positionable): { left: number; top: number; width: number; height: number } | null {
  if (item.kind === 'artboard') return null;
  const node = doc.nodes[item.id];
  const parentId = node?.parent;
  if (!parentId) return null;
  // `nodeInnerRect`, not `nodeRect`: `left`/`top` are CSS pixels inside the
  // artboard, and the screen-space rect is scaled by the canvas zoom.
  const rect = nodeInnerRect(parentId);
  if (!rect) return null;
  return { left: 0, top: 0, width: rect.width, height: rect.height };
}

export function distribute(doc: CanvasDocument, ids: NodeId[], kind: DistributeKind): ArrangeResult {
  const { items, skipped } = positionables(doc, ids);
  if (items.length < 3) return { ops: [], skipped };

  const horizontal = kind === 'horizontal';
  const sorted = [...items].sort((a, b) => (horizontal ? a.left - b.left : a.top - b.top));

  const start = horizontal ? sorted[0]!.left : sorted[0]!.top;
  const last = sorted[sorted.length - 1]!;
  const end = horizontal ? last.left + last.width : last.top + last.height;
  const totalSize = sorted.reduce((sum, i) => sum + (horizontal ? i.width : i.height), 0);
  // Equal gaps between items, leaving the outermost two where they are.
  const gap = (end - start - totalSize) / (sorted.length - 1);

  const next = new Map<NodeId, { left: number; top: number }>();
  let cursor = start;
  for (const item of sorted) {
    next.set(item.id, horizontal ? { left: cursor, top: item.top } : { left: item.left, top: cursor });
    cursor += (horizontal ? item.width : item.height) + gap;
  }

  return { ops: toOps(items, next), skipped };
}

/** Distance between the facing edges of the two nearest items, for the readout. */
export function measureGap(doc: CanvasDocument, ids: NodeId[], kind: DistributeKind): number | null {
  const { items } = positionables(doc, ids);
  if (items.length < 2) return null;
  const horizontal = kind === 'horizontal';
  const sorted = [...items].sort((a, b) => (horizontal ? a.left - b.left : a.top - b.top));
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    gaps.push(horizontal ? cur.left - (prev.left + prev.width) : cur.top - (prev.top + prev.height));
  }
  const first = Math.round(gaps[0] ?? 0);
  return gaps.every((g) => Math.round(g) === first) ? first : null;
}

// ---------------------------------------------------------------------------
// Z-order
// ---------------------------------------------------------------------------

export type ZOrder = 'front' | 'forward' | 'backward' | 'back';

/**
 * Reorders siblings. In a DOM tree "front" is last in document order, which is
 * the opposite of how layer panels read top-to-bottom — the panel shows children
 * in document order, so later siblings paint on top.
 */
export function reorder(doc: CanvasDocument, ids: NodeId[], where: ZOrder): Op[] {
  const moves: { id: NodeId; parent: NodeId | null; index: number }[] = [];

  for (const id of ids) {
    const node = doc.nodes[id];
    if (!node) continue;
    const siblings = node.parent
      ? doc.nodes[node.parent]?.children
      : doc.pages.find((p) => p.artboards.includes(id))?.artboards;
    if (!siblings) continue;

    const current = siblings.indexOf(id);
    if (current < 0) continue;

    const index =
      where === 'front' ? siblings.length - 1
      : where === 'back' ? 0
      : where === 'forward' ? Math.min(siblings.length - 1, current + 1)
      : Math.max(0, current - 1);

    if (index !== current) moves.push({ id, parent: node.parent, index });
  }

  return moves.length ? [{ t: 'move', moves }] : [];
}
