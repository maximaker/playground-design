/**
 * The board: diagrams drawn on the canvas between artboards.
 *
 * Board items are not part of the design tree. They live on the page, in
 * canvas space, next to the artboards rather than inside them — an artboard is
 * real HTML laid out with flexbox, and a diagram is boxes placed by hand with
 * arrows between them, which is exactly the shape the design tree should not
 * take. They never export as part of a design and the linter never sees them.
 *
 * Everything that decides where something is drawn lives in this file, and both
 * the canvas and the SVG emitter call it, so the two cannot disagree about
 * where an arrow goes. See DIAGRAMS.md for the reasoning.
 */

import type { CanvasDocument, NodeId, Page } from './model.ts';
import { getArtboardPosition, getArtboardSize, newId } from './model.ts';

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export type BoardShapeKind = 'rect' | 'ellipse' | 'diamond' | 'text' | 'section';

export interface BoardShape {
  type: 'shape';
  id: string;
  kind: BoardShapeKind;
  /** Canvas space. */
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  color: BoardColor;
  /** Rounded corners on a rectangle, for Mermaid's `(rounded)` and `([stadium])`. */
  rounded?: boolean;
}

/**
 * Where one end of a connector is.
 *
 * An artboard is a first-class end: a user flow drawn between the real screens
 * stays attached as the screens move and change, which is the reason to draw
 * diagrams here rather than in a separate whiteboard.
 */
export type Endpoint =
  | { kind: 'shape'; id: string }
  | { kind: 'artboard'; id: NodeId }
  | { kind: 'point'; x: number; y: number };

export interface Connector {
  type: 'connector';
  id: string;
  from: Endpoint;
  to: Endpoint;
  route: 'straight' | 'elbow';
  arrow: 'end' | 'both' | 'none';
  label?: string;
  color: BoardColor;
  dashed?: boolean;
  /**
   * Which side each end leaves from, when it should not be worked out. Set for
   * the edges that loop back up a flow, so a "try again" arrow goes round the
   * outside instead of being drawn on top of the arrow it answers.
   */
  fromSide?: BoardSide;
  toSide?: BoardSide;
}

export type BoardSide = 'left' | 'right' | 'top' | 'bottom';

export type BoardItem = BoardShape | Connector;

/**
 * A small named palette rather than free colours.
 *
 * The same reason a design has tokens: a board drawn from six swatches stays
 * coherent however many hands are on it, and an agent picks a meaning ("this
 * step failed") instead of a hex value.
 */
export type BoardColor = 'neutral' | 'blue' | 'green' | 'yellow' | 'red' | 'purple';

export const BOARD_COLORS: Record<BoardColor, { fill: string; stroke: string; text: string }> = {
  neutral: { fill: '#ffffff', stroke: '#3f3f46', text: '#18181b' },
  blue: { fill: '#dbeafe', stroke: '#2563eb', text: '#1e3a8a' },
  green: { fill: '#dcfce7', stroke: '#16a34a', text: '#14532d' },
  yellow: { fill: '#fef9c3', stroke: '#ca8a04', text: '#713f12' },
  red: { fill: '#fee2e2', stroke: '#dc2626', text: '#7f1d1d' },
  purple: { fill: '#ede9fe', stroke: '#7c3aed', text: '#4c1d95' },
};

export const BOARD_COLOR_NAMES = Object.keys(BOARD_COLORS) as BoardColor[];

export const DEFAULT_SHAPE_SIZE: Record<BoardShapeKind, { width: number; height: number }> = {
  rect: { width: 160, height: 80 },
  ellipse: { width: 140, height: 90 },
  diamond: { width: 150, height: 100 },
  text: { width: 160, height: 32 },
  section: { width: 480, height: 320 },
};

export function makeBoardShape(partial: Partial<BoardShape> & { kind: BoardShapeKind }): BoardShape {
  const size = DEFAULT_SHAPE_SIZE[partial.kind];
  return {
    type: 'shape',
    id: partial.id ?? newId('bs'),
    kind: partial.kind,
    x: partial.x ?? 0,
    y: partial.y ?? 0,
    width: partial.width ?? size.width,
    height: partial.height ?? size.height,
    text: partial.text ?? (partial.kind === 'section' ? 'Section' : ''),
    color: partial.color ?? 'neutral',
    ...(partial.rounded ? { rounded: true } : {}),
  };
}

export function makeConnector(partial: Partial<Connector> & { from: Endpoint; to: Endpoint }): Connector {
  return {
    type: 'connector',
    id: partial.id ?? newId('bc'),
    from: partial.from,
    to: partial.to,
    route: partial.route ?? 'elbow',
    arrow: partial.arrow ?? 'end',
    color: partial.color ?? 'neutral',
    ...(partial.label ? { label: partial.label } : {}),
    ...(partial.dashed ? { dashed: true } : {}),
    ...(partial.fromSide ? { fromSide: partial.fromSide } : {}),
    ...(partial.toSide ? { toSide: partial.toSide } : {}),
  };
}

export function boardOf(page: Page | undefined): BoardItem[] {
  return page?.board ?? [];
}

export function isShape(item: BoardItem | undefined): item is BoardShape {
  return item?.type === 'shape';
}

export function isConnector(item: BoardItem | undefined): item is Connector {
  return item?.type === 'connector';
}

// ---------------------------------------------------------------------------
// Changes — the body of the `board` op
// ---------------------------------------------------------------------------

export type BoardChange =
  | { action: 'add'; item: BoardItem; index?: number }
  /** A field set to null is removed. */
  | { action: 'update'; id: string; patch: Partial<BoardShape> | Partial<Connector> | Record<string, unknown> }
  | { action: 'remove'; id: string };

export class BoardError extends Error {}

/**
 * Applies changes to a page's board in order and returns the changes that undo
 * them, already reversed.
 *
 * An update's inverse carries exactly the fields it touched, so undoing a text
 * edit does not also put back a position someone else set in the meantime. A
 * remove's inverse re-adds the item at the index it came from, so z-order
 * survives undo.
 */
export function applyBoardChanges(page: Page, changes: BoardChange[]): BoardChange[] {
  if (!page.board) page.board = [];
  const board = page.board;
  const inverse: BoardChange[] = [];

  for (const change of changes) {
    if (change.action === 'add') {
      if (board.some((i) => i.id === change.item.id)) throw new BoardError(`board item ${change.item.id} already exists`);
      const at = change.index === undefined ? board.length : Math.max(0, Math.min(board.length, change.index));
      board.splice(at, 0, structuredClone(change.item));
      inverse.unshift({ action: 'remove', id: change.item.id });
      continue;
    }

    const index = board.findIndex((i) => i.id === change.id);
    if (index < 0) throw new BoardError(`board item ${change.id} not found`);

    if (change.action === 'remove') {
      const [removed] = board.splice(index, 1);
      inverse.unshift({ action: 'add', item: removed!, index });
      continue;
    }

    const current = board[index]! as unknown as Record<string, unknown>;
    const before: Record<string, unknown> = {};
    for (const key of Object.keys(change.patch)) {
      if (key === 'id' || key === 'type') continue;
      // `null` in an inverse means "this field was not set", and applying it
      // deletes the field again, which is what restores the prior state. Null
      // rather than undefined because the inverse travels as JSON when it is
      // undone, and JSON drops undefined — the server would keep a label the
      // client had just taken away.
      before[key] = current[key] === undefined ? null : structuredClone(current[key]);
    }
    const next: Record<string, unknown> = { ...current };
    for (const [key, value] of Object.entries(change.patch)) {
      if (key === 'id' || key === 'type') continue;
      if (value === undefined || value === null) delete next[key];
      else next[key] = structuredClone(value);
    }
    board[index] = next as unknown as BoardItem;
    inverse.unshift({ action: 'update', id: change.id, patch: before as Partial<BoardShape> });
  }

  return inverse;
}

/**
 * The changes that delete board items without breaking the diagram around them.
 *
 * A connector attached to a deleted shape is kept, with that end turned into a
 * point where it used to meet the shape — the behaviour people expect from
 * Excalidraw, and the one that lets a half-drawn diagram survive an edit.
 * Connectors named in `ids` themselves are simply removed.
 */
export function deleteBoardItems(doc: CanvasDocument, page: Page, ids: string[]): BoardChange[] {
  const doomed = new Set(ids);
  const changes: BoardChange[] = [];
  for (const item of boardOf(page)) {
    if (!isConnector(item) || doomed.has(item.id)) continue;
    const patch: Partial<Connector> = {};
    const route = routeConnector(doc, page, item);
    if (item.from.kind === 'shape' && doomed.has(item.from.id) && route) {
      patch.from = { kind: 'point', x: Math.round(route.points[0]!.x), y: Math.round(route.points[0]!.y) };
    }
    if (item.to.kind === 'shape' && doomed.has(item.to.id) && route) {
      const last = route.points[route.points.length - 1]!;
      patch.to = { kind: 'point', x: Math.round(last.x), y: Math.round(last.y) };
    }
    if (Object.keys(patch).length) changes.push({ action: 'update', id: item.id, patch });
  }
  for (const id of ids) if (boardOf(page).some((i) => i.id === id)) changes.push({ action: 'remove', id });
  return changes;
}

/**
 * What a section contains: the shapes whose centre lies inside it.
 *
 * Computed when a drag starts rather than stored, so there is no membership
 * list to keep in sync with every move. Sections do not contain sections, which
 * keeps "drag the section" from dragging the one it happens to sit inside.
 */
export function sectionContents(page: Page, sectionId: string): string[] {
  const section = boardOf(page).find((i) => i.id === sectionId);
  if (!isShape(section) || section.kind !== 'section') return [];
  return boardOf(page).filter((i): i is BoardShape => isShape(i) && i.kind !== 'section' && i.id !== sectionId)
    .filter((s) => {
      const cx = s.x + s.width / 2;
      const cy = s.y + s.height / 2;
      return cx >= section.x && cx <= section.x + section.width && cy >= section.y && cy <= section.y + section.height;
    })
    .map((s) => s.id);
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export interface Point { x: number; y: number }
export interface BoardBox { x: number; y: number; width: number; height: number }

type Outline = 'rect' | 'ellipse' | 'diamond' | 'point';

interface ResolvedEnd { box: BoardBox; outline: Outline }

/** The box an endpoint occupies, or null when what it points at is gone. */
export function endpointBox(doc: CanvasDocument, page: Page, end: Endpoint): ResolvedEnd | null {
  if (end.kind === 'point') return { box: { x: end.x, y: end.y, width: 0, height: 0 }, outline: 'point' };
  if (end.kind === 'artboard') {
    const node = doc.nodes[end.id];
    if (!node || node.type !== 'artboard' || !page.artboards.includes(end.id)) return null;
    return { box: { ...getArtboardPosition(node), ...getArtboardSize(node) }, outline: 'rect' };
  }
  const shape = boardOf(page).find((i) => i.id === end.id);
  if (!isShape(shape)) return null;
  const outline: Outline = shape.kind === 'ellipse' ? 'ellipse' : shape.kind === 'diamond' ? 'diamond' : 'rect';
  return { box: { x: shape.x, y: shape.y, width: shape.width, height: shape.height }, outline };
}

const centre = (b: BoardBox): Point => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

/** Where a ray from the centre of `end` towards `toward` leaves its outline. */
function boundaryToward(end: ResolvedEnd, toward: Point): Point {
  const c = centre(end.box);
  if (end.outline === 'point') return c;
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (!dx && !dy) return c;
  const hw = end.box.width / 2;
  const hh = end.box.height / 2;
  let t: number;
  if (end.outline === 'ellipse') t = 1 / Math.sqrt((dx / hw) ** 2 + (dy / hh) ** 2);
  else if (end.outline === 'diamond') t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
  else t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
  return { x: c.x + dx * t, y: c.y + dy * t };
}

type Side = BoardSide;

function sidePoint(end: ResolvedEnd, side: Side): Point {
  const { x, y, width, height } = end.box;
  switch (side) {
    case 'left': return { x, y: y + height / 2 };
    case 'right': return { x: x + width, y: y + height / 2 };
    case 'top': return { x: x + width / 2, y };
    case 'bottom': return { x: x + width / 2, y: y + height };
  }
}

export interface Route {
  points: Point[];
  /** Where the label goes: halfway along the path by length. */
  label: Point;
}

/**
 * The path a connector takes, or null when either end no longer exists.
 *
 * Straight connectors run between the points where each outline faces the
 * other, intersected with the real shape — a diamond's arrow meets the diamond,
 * not its bounding box. Elbow connectors leave from the sides facing each other
 * along the axis the two ends are further apart on, and bend once or twice.
 * Nothing is routed around obstacles: this is right for flows laid out in rows
 * and columns, which is what `layoutDiagram` produces.
 */
export function routeConnector(doc: CanvasDocument, page: Page, connector: Connector): Route | null {
  const a = endpointBox(doc, page, connector.from);
  const b = endpointBox(doc, page, connector.to);
  if (!a || !b) return null;
  const ca = centre(a.box);
  const cb = centre(b.box);

  let points: Point[];
  if (connector.route === 'straight') {
    points = [
      connector.fromSide && a.outline !== 'point' ? sidePoint(a, connector.fromSide) : boundaryToward(a, cb),
      connector.toSide && b.outline !== 'point' ? sidePoint(b, connector.toSide) : boundaryToward(b, ca),
    ];
  } else if (connector.fromSide || connector.toSide) {
    points = elbowBetween(a, connector.fromSide ?? facing(a, b), b, connector.toSide ?? facing(b, a));
  } else {
    // Which way the gap between the two boxes runs decides the axis, measured
    // between the boxes' edges rather than their centres: a wide artboard next
    // to a small shape has centres that say "vertical" when the gap between
    // them is plainly horizontal.
    const gapX = Math.max(b.box.x - (a.box.x + a.box.width), a.box.x - (b.box.x + b.box.width));
    const gapY = Math.max(b.box.y - (a.box.y + a.box.height), a.box.y - (b.box.y + b.box.height));
    const horizontal = gapX >= gapY;
    if (horizontal) {
      const rightward = cb.x >= ca.x;
      points = elbowBetween(a, rightward ? 'right' : 'left', b, rightward ? 'left' : 'right');
    } else {
      const downward = cb.y >= ca.y;
      points = elbowBetween(a, downward ? 'bottom' : 'top', b, downward ? 'top' : 'bottom');
    }
  }
  return { points, label: pointAlong(points, 0.5) };
}

const NORMAL: Record<Side, Point> = { left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 } };

/** The side of `a` that faces `b`, for an end whose side was given only at the other. */
function facing(a: ResolvedEnd, b: ResolvedEnd): Side {
  const ca = centre(a.box);
  const cb = centre(b.box);
  const dx = cb.x - ca.x;
  const dy = cb.y - ca.y;
  return Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'right' : 'left') : (dy >= 0 ? 'bottom' : 'top');
}

/** How far an elbow runs straight out of a side before it may turn. */
const STUB = 24;

/**
 * An orthogonal path from a side of one box to a side of another.
 *
 * Each end first runs straight out of its side, so an arrow never turns while
 * still touching the shape. Facing sides meet in the middle; two sides that
 * face the same way (right to right) go round the outside of both, which is
 * what a loop back up a flow looks like.
 */
function elbowBetween(a: ResolvedEnd, sa: Side, b: ResolvedEnd, sb: Side): Point[] {
  const p0 = a.outline === 'point' ? centre(a.box) : sidePoint(a, sa);
  const p3 = b.outline === 'point' ? centre(b.box) : sidePoint(b, sb);
  const na = NORMAL[sa];
  const nb = NORMAL[sb];
  const horizontalA = na.x !== 0;
  const horizontalB = nb.x !== 0;
  const dedupe = (pts: Point[]) => pts.filter((p, i) => i === 0 || Math.abs(p.x - pts[i - 1]!.x) > 0.5 || Math.abs(p.y - pts[i - 1]!.y) > 0.5);

  if (horizontalA && horizontalB) {
    let x: number;
    if (na.x === -nb.x && (p3.x - p0.x) * na.x > 0) x = (p0.x + p3.x) / 2;          // facing, with room between
    else if (na.x === nb.x) x = na.x > 0 ? Math.max(p0.x, p3.x) + STUB : Math.min(p0.x, p3.x) - STUB; // same side: round the outside
    else x = p0.x + na.x * STUB;                                                       // facing, but overlapping
    return dedupe([p0, { x, y: p0.y }, { x, y: p3.y }, p3]);
  }
  if (!horizontalA && !horizontalB) {
    let y: number;
    if (na.y === -nb.y && (p3.y - p0.y) * na.y > 0) y = (p0.y + p3.y) / 2;
    else if (na.y === nb.y) y = na.y > 0 ? Math.max(p0.y, p3.y) + STUB : Math.min(p0.y, p3.y) - STUB;
    else y = p0.y + na.y * STUB;
    return dedupe([p0, { x: p0.x, y }, { x: p3.x, y }, p3]);
  }
  // One horizontal side and one vertical: a single corner where they cross,
  // when that corner is in front of both sides. Otherwise each end steps out
  // of its side first, so the path never runs back through its own shape.
  const corner = horizontalA ? { x: p3.x, y: p0.y } : { x: p0.x, y: p3.y };
  const aheadOfA = (corner.x - p0.x) * na.x + (corner.y - p0.y) * na.y > 0;
  const aheadOfB = (corner.x - p3.x) * nb.x + (corner.y - p3.y) * nb.y > 0;
  if (aheadOfA && aheadOfB) return dedupe([p0, corner, p3]);
  const p1 = { x: p0.x + na.x * STUB, y: p0.y + na.y * STUB };
  const p2 = { x: p3.x + nb.x * STUB, y: p3.y + nb.y * STUB };
  const mid = horizontalA ? { x: p1.x, y: p2.y } : { x: p2.x, y: p1.y };
  return dedupe([p0, p1, mid, p2, p3]);
}

/** The point a fraction of the way along a polyline, by length. */
export function pointAlong(points: Point[], fraction: number): Point {
  if (points.length === 1) return points[0]!;
  const lengths = points.slice(1).map((p, i) => Math.hypot(p.x - points[i]!.x, p.y - points[i]!.y));
  const total = lengths.reduce((s, l) => s + l, 0);
  let remaining = total * fraction;
  for (let i = 0; i < lengths.length; i++) {
    const len = lengths[i]!;
    if (remaining <= len || i === lengths.length - 1) {
      const t = len ? remaining / len : 0;
      const p = points[i]!;
      const q = points[i + 1]!;
      return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
    }
    remaining -= len;
  }
  return points[points.length - 1]!;
}

/** The three corners of an arrowhead whose tip is at `tip`, pointing away from `from`. */
export function arrowHead(tip: Point, from: Point, size = 10): Point[] {
  const angle = Math.atan2(tip.y - from.y, tip.x - from.x);
  const spread = Math.PI / 7;
  return [
    tip,
    { x: tip.x - size * Math.cos(angle - spread), y: tip.y - size * Math.sin(angle - spread) },
    { x: tip.x - size * Math.cos(angle + spread), y: tip.y - size * Math.sin(angle + spread) },
  ];
}

/** An SVG path for a polyline, in whatever units the points are in. */
export function pathData(points: Point[], scale = 1): string {
  return points.map((p, i) => `${i ? 'L' : 'M'}${(p.x * scale).toFixed(1)} ${(p.y * scale).toFixed(1)}`).join(' ');
}

/** The box around every board item on a page, and the artboards connectors reach. */
export function boardBounds(doc: CanvasDocument, page: Page): BoardBox | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const take = (b: BoardBox) => {
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width); maxY = Math.max(maxY, b.y + b.height);
  };
  for (const item of boardOf(page)) {
    if (isShape(item)) { take(item); continue; }
    const route = routeConnector(doc, page, item);
    for (const p of route?.points ?? []) take({ ...p, width: 0, height: 0 });
    for (const end of [item.from, item.to]) {
      if (end.kind === 'artboard') { const r = endpointBox(doc, page, end); if (r) take(r.box); }
    }
  }
  return Number.isFinite(minX) ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : null;
}

/** Board items whose box intersects a canvas-space rectangle — the marquee. */
export function boardItemsInRect(doc: CanvasDocument, page: Page, rect: BoardBox): string[] {
  const hits: string[] = [];
  const overlaps = (b: BoardBox) => b.x < rect.x + rect.width && b.x + b.width > rect.x
    && b.y < rect.y + rect.height && b.y + b.height > rect.y;
  for (const item of boardOf(page)) {
    if (isShape(item)) {
      // A marquee dragged inside a section selects what is in it, not the
      // section itself; the section is taken only when it is wholly enclosed.
      if (item.kind === 'section') {
        if (item.x >= rect.x && item.y >= rect.y && item.x + item.width <= rect.x + rect.width
          && item.y + item.height <= rect.y + rect.height) hits.push(item.id);
      } else if (overlaps(item)) hits.push(item.id);
      continue;
    }
    const route = routeConnector(doc, page, item);
    if (route?.points.some((p) => p.x >= rect.x && p.x <= rect.x + rect.width && p.y >= rect.y && p.y <= rect.y + rect.height)) {
      hits.push(item.id);
    }
  }
  return hits;
}

/** Connectors whose ends point at things that no longer exist. */
export function danglingConnectors(doc: CanvasDocument, page: Page): string[] {
  return boardOf(page).filter(isConnector).filter((c) => !routeConnector(doc, page, c)).map((c) => c.id);
}

// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------

const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const BOARD_FONT = '"Inter", system-ui, -apple-system, sans-serif';
/**
 * The same stack without quotes, for SVG attributes: a quoted family inside a
 * double-quoted attribute ended the attribute early, and every label fell back
 * to the browser's serif.
 */
const SVG_FONT = 'Inter, system-ui, -apple-system, sans-serif';

/**
 * The board as a standalone SVG.
 *
 * Artboards that connectors reach are drawn as labelled outlines — the SVG is a
 * picture of the diagram, and an artboard's contents are HTML that an SVG
 * cannot hold without flattening it. Shape text is written in a foreignObject
 * so it wraps with the same CSS the canvas uses rather than a guess at line
 * breaks.
 */
export function emitBoardSvg(doc: CanvasDocument, page: Page, opts: { padding?: number } = {}): string {
  const pad = opts.padding ?? 40;
  const bounds = boardBounds(doc, page) ?? { x: 0, y: 0, width: 200, height: 120 };
  const vx = bounds.x - pad;
  const vy = bounds.y - pad;
  const vw = bounds.width + pad * 2;
  const vh = bounds.height + pad * 2;
  const out: string[] = [];

  const artboards = new Set<NodeId>();
  for (const item of boardOf(page)) {
    if (!isConnector(item)) continue;
    for (const end of [item.from, item.to]) if (end.kind === 'artboard') artboards.add(end.id);
  }
  for (const id of artboards) {
    const node = doc.nodes[id];
    const end = endpointBox(doc, page, { kind: 'artboard', id });
    if (!node || !end) continue;
    const { x, y, width, height } = end.box;
    out.push(`<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="4" fill="#ffffff" stroke="#d4d4d8" stroke-width="2"/>`);
    out.push(`<text x="${x}" y="${y - 10}" font-family="${SVG_FONT}" font-size="14" fill="#71717a">${escapeXml(node.name)}</text>`);
  }

  const shapes = boardOf(page).filter(isShape);
  const ordered = [...shapes.filter((s) => s.kind === 'section'), ...shapes.filter((s) => s.kind !== 'section')];
  for (const s of ordered) {
    const c = BOARD_COLORS[s.color];
    const { x, y, width: w, height: h } = s;
    if (s.kind === 'section') {
      out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${c.fill}" fill-opacity="0.45" stroke="${c.stroke}" stroke-opacity="0.35" stroke-width="1.5"/>`);
      out.push(`<text x="${x + 16}" y="${y + 26}" font-family="${SVG_FONT}" font-size="14" font-weight="600" fill="${c.text}">${escapeXml(s.text)}</text>`);
      continue;
    }
    if (s.kind === 'rect') out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${s.rounded ? Math.min(h / 2, 24) : 6}" fill="${c.fill}" stroke="${c.stroke}" stroke-width="2"/>`);
    if (s.kind === 'ellipse') out.push(`<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" fill="${c.fill}" stroke="${c.stroke}" stroke-width="2"/>`);
    if (s.kind === 'diamond') out.push(`<polygon points="${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}" fill="${c.fill}" stroke="${c.stroke}" stroke-width="2"/>`);
    if (s.text) {
      // A diamond's text has to fit inside the diamond, which is half its box.
      const inset = s.kind === 'diamond' ? { x: w / 4, y: h / 4 } : { x: 8, y: 4 };
      out.push(`<foreignObject x="${x + inset.x}" y="${y + inset.y}" width="${Math.max(1, w - inset.x * 2)}" height="${Math.max(1, h - inset.y * 2)}">`
        + `<div xmlns="http://www.w3.org/1999/xhtml" style="display:flex;align-items:center;justify-content:${s.kind === 'text' ? 'flex-start' : 'center'};`
        + `width:100%;height:100%;text-align:${s.kind === 'text' ? 'left' : 'center'};font-family:${escapeXml(BOARD_FONT)};font-size:${s.kind === 'text' ? 16 : 14}px;`
        + `line-height:1.3;color:${c.text};overflow-wrap:anywhere">${escapeXml(s.text)}</div></foreignObject>`);
    }
  }

  for (const item of boardOf(page)) {
    if (!isConnector(item)) continue;
    const route = routeConnector(doc, page, item);
    if (!route) continue;
    const c = BOARD_COLORS[item.color];
    out.push(`<path d="${pathData(route.points)}" fill="none" stroke="${c.stroke}" stroke-width="2" stroke-linejoin="round"${item.dashed ? ' stroke-dasharray="7 6"' : ''}/>`);
    const n = route.points.length;
    if (item.arrow !== 'none') {
      out.push(`<polygon points="${arrowHead(route.points[n - 1]!, route.points[n - 2]!).map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}" fill="${c.stroke}"/>`);
    }
    if (item.arrow === 'both') {
      out.push(`<polygon points="${arrowHead(route.points[0]!, route.points[1]!).map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}" fill="${c.stroke}"/>`);
    }
    if (item.label) {
      const w = Math.max(24, item.label.length * 7.2 + 14);
      out.push(`<rect x="${route.label.x - w / 2}" y="${route.label.y - 11}" width="${w}" height="22" rx="4" fill="#ffffff" stroke="${c.stroke}" stroke-opacity="0.25"/>`);
      out.push(`<text x="${route.label.x}" y="${route.label.y + 4.5}" text-anchor="middle" font-family="${SVG_FONT}" font-size="12" fill="${c.text}">${escapeXml(item.label)}</text>`);
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vx} ${vy} ${vw} ${vh}" width="${Math.round(vw)}" height="${Math.round(vh)}">`
    + `<rect x="${vx}" y="${vy}" width="${vw}" height="${vh}" fill="#fafafa"/>${out.join('')}</svg>`;
}
