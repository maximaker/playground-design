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
  route: 'straight' | 'elbow' | 'curved';
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
export type BoardColor = 'neutral' | 'slate' | 'blue' | 'green' | 'yellow' | 'red' | 'purple';

/**
 * Each swatch is a family: a fill, an edge, text in the same hue, and an
 * accent for the lines drawn in it.
 *
 * The look is a user-flow sheet rather than a whiteboard: almost everything
 * is slate, outlines are hairlines, and colour is kept for meaning — a pale
 * green pill for where the flow succeeds, a pale red one for an error. Neutral
 * is the only outlined family; the others are soft fills with no edge, which
 * is what lets a coloured pill read as a state rather than as a decoration.
 * Slate is the solid one, for the system's own steps.
 */
export const BOARD_COLORS: Record<BoardColor, { fill: string; stroke: string; text: string; accent: string }> = {
  neutral: { fill: '#ffffff', stroke: '#cfd6df', text: '#3b4656', accent: '#a3acb9' },
  slate: { fill: '#aeb6c2', stroke: '#aeb6c2', text: '#ffffff', accent: '#8e98a6' },
  blue: { fill: '#e7effd', stroke: '#e7effd', text: '#2f5fb3', accent: '#5b8def' },
  green: { fill: '#e2f5e7', stroke: '#e2f5e7', text: '#2d8649', accent: '#3fb865' },
  yellow: { fill: '#fcf2d6', stroke: '#fcf2d6', text: '#946c17', accent: '#dcae34' },
  red: { fill: '#fde5e5', stroke: '#fde5e5', text: '#c03d3d', accent: '#ec6262' },
  purple: { fill: '#eee8fd', stroke: '#eee8fd', text: '#6a4bc2', accent: '#9373ea' },
};

/**
 * Everything else about how the board looks, in one place.
 *
 * Read by the canvas and by the SVG emitter alike, for the same reason the
 * geometry is shared: an agent judging its diagram from a picture has to be
 * looking at what the person sees.
 */
export const BOARD_STYLE = {
  strokeWidth: 1,
  /** Corners: a node one line tall comes out a pill, a big box a soft rectangle. */
  radius: 22,
  sectionRadius: 14,
  /** Neutral steps are white cards: lifted, but only just. */
  cardShadow: '0 1px 2px rgba(30, 41, 59, 0.05), 0 2px 8px -2px rgba(30, 41, 59, 0.06)',
  /** Sections are lifted properly: a white sheet on the canvas. */
  sectionShadow: '0 1px 2px rgba(30, 41, 59, 0.05), 0 12px 32px -8px rgba(30, 41, 59, 0.14)',
  fontSize: 13,
  fontWeight: 600,
  textFontSize: 15,
  titleFontSize: 16,
  lineWidth: 1,
  arrowSize: 6,
  bendRadius: 6,
  /** The small hollow circle a connector starts from. */
  originDot: 2.5,
  labelFontSize: 11,
  labelFill: '#eef1f5',
  labelText: '#7a8594',
  /** The canvas colour a diagram is pictured on. */
  page: '#f3f6fa',
  yes: '#46c16a',
  no: '#ef6b6b',
} as const;

/** How one shape is drawn — shared, so the canvas and the SVG agree. */
export function shapeLook(s: BoardShape): {
  fill: string; stroke: string; strokeWidth: number; dashed: boolean;
  text: string; weight: number; fontSize: number;
} {
  const c = BOARD_COLORS[s.color];
  const S = BOARD_STYLE;
  const base = { fill: c.fill, stroke: c.stroke, strokeWidth: S.strokeWidth, dashed: false, text: c.text, weight: S.fontWeight, fontSize: S.fontSize };
  switch (s.kind) {
    // A decision is an open, dashed diamond: it is a question, not a step.
    case 'diamond': return { ...base, fill: s.color === 'neutral' ? '#ffffff' : c.fill, stroke: s.color === 'neutral' ? '#b4bcc8' : c.accent, dashed: true };
    // A circle is a soft grey disc with no edge — the system doing something.
    case 'ellipse': return s.color === 'neutral' ? { ...base, fill: '#edf0f4', stroke: '#edf0f4' } : base;
    case 'text': return { ...base, fill: 'none', stroke: 'none', strokeWidth: 0, weight: 400, fontSize: S.textFontSize };
    case 'section': return { ...base, fill: '#ffffff', stroke: 'none', strokeWidth: 0, weight: 600, fontSize: S.titleFontSize,
      text: s.color === 'neutral' ? '#3b4656' : c.text };
    default: return base;
  }
}

/** Whether a connector label is a yes or a no, drawn as a badge rather than as words. */
export function verdictOf(label: string | undefined): 'yes' | 'no' | null {
  const l = (label ?? '').trim().toLowerCase();
  if (['yes', 'y', 'true', 'ok', '✓', '✔'].includes(l)) return 'yes';
  if (['no', 'n', 'false', '✗', '✕', '×'].includes(l)) return 'no';
  return null;
}

export const BOARD_COLOR_NAMES = Object.keys(BOARD_COLORS) as BoardColor[];

export const DEFAULT_SHAPE_SIZE: Record<BoardShapeKind, { width: number; height: number }> = {
  rect: { width: 160, height: 44 },
  ellipse: { width: 96, height: 96 },
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
  /**
   * The path as a polyline. A curved route is sampled into one, so everything
   * that measures a route — hit-testing, bounds, labels, arrowheads, the ends
   * a deleted shape leaves behind — works on curves without knowing about them.
   */
  points: Point[];
  /** Where the label goes: halfway along the path by length. */
  label: Point;
  /** For a curved route, the cubic to draw exactly: start, two controls, end. */
  bezier?: [Point, Point, Point, Point];
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
  } else if (connector.route === 'curved') {
    // Out of the sides facing each other, as a node editor draws a wire: each
    // end leaves along its side's normal and the two bend into one S-curve.
    const sa = connector.fromSide ?? facingSide(a, b);
    const sb = connector.toSide ?? facingSide(b, a);
    const p0 = a.outline === 'point' ? centre(a.box) : sidePoint(a, sa);
    const p3 = b.outline === 'point' ? centre(b.box) : sidePoint(b, sb);
    const reach = Math.max(40, Math.hypot(p3.x - p0.x, p3.y - p0.y) * 0.45);
    const na = NORMAL[sa];
    const nb = NORMAL[sb];
    const c1 = { x: p0.x + na.x * reach, y: p0.y + na.y * reach };
    const c2 = { x: p3.x + nb.x * reach, y: p3.y + nb.y * reach };
    const at = (t: number): Point => {
      const u = 1 - t;
      return {
        x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p3.x,
        y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p3.y,
      };
    };
    points = Array.from({ length: 25 }, (_, i) => at(i / 24));
    return { points, label: at(0.5), bezier: [p0, c1, c2, p3] };
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

/** The side of `a` that faces `b`, judged by the gap between them, as the elbow does. */
function facingSide(a: ResolvedEnd, b: ResolvedEnd): Side {
  const gapX = Math.max(b.box.x - (a.box.x + a.box.width), a.box.x - (b.box.x + b.box.width));
  const gapY = Math.max(b.box.y - (a.box.y + a.box.height), a.box.y - (b.box.y + b.box.height));
  const ca = centre(a.box);
  const cb = centre(b.box);
  return gapX >= gapY ? (cb.x >= ca.x ? 'right' : 'left') : (cb.y >= ca.y ? 'bottom' : 'top');
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
export function arrowHead(tip: Point, from: Point, size: number = BOARD_STYLE.arrowSize): Point[] {
  const angle = Math.atan2(tip.y - from.y, tip.x - from.x);
  const spread = Math.PI / 6.5;
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

/**
 * An SVG path for a polyline with its corners rounded.
 *
 * A square elbow reads as a wiring diagram; a small radius at each bend reads
 * as a drawing. The radius shrinks on short segments so two bends close
 * together never overlap, and the ends are left exactly where they were, so
 * arrowheads still meet their shapes.
 */
export function roundedPathData(points: Point[], radius: number = BOARD_STYLE.bendRadius, scale = 1): string {
  const pts = points.map((p) => ({ x: p.x * scale, y: p.y * scale }));
  const r = radius * scale;
  if (pts.length < 3 || r <= 0) return pathData(points, scale);
  const f = (n: number) => n.toFixed(1);
  let d = `M${f(pts[0]!.x)} ${f(pts[0]!.y)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1]!;
    const at = pts[i]!;
    const next = pts[i + 1]!;
    const inLen = Math.hypot(at.x - prev.x, at.y - prev.y);
    const outLen = Math.hypot(next.x - at.x, next.y - at.y);
    const cut = Math.min(r, inLen / 2, outLen / 2);
    if (!inLen || !outLen || !cut) { d += ` L${f(at.x)} ${f(at.y)}`; continue; }
    const a = { x: at.x - ((at.x - prev.x) / inLen) * cut, y: at.y - ((at.y - prev.y) / inLen) * cut };
    const b = { x: at.x + ((next.x - at.x) / outLen) * cut, y: at.y + ((next.y - at.y) / outLen) * cut };
    d += ` L${f(a.x)} ${f(a.y)} Q${f(at.x)} ${f(at.y)} ${f(b.x)} ${f(b.y)}`;
  }
  const last = pts[pts.length - 1]!;
  return `${d} L${f(last.x)} ${f(last.y)}`;
}

/** The SVG path for a route: the exact cubic when it is curved, rounded elbows otherwise. */
export function connectorPathData(route: Route, scale = 1): string {
  if (route.bezier) {
    const [p0, c1, c2, p3] = route.bezier.map((p) => ({ x: (p.x * scale).toFixed(1), y: (p.y * scale).toFixed(1) }));
    return `M${p0!.x} ${p0!.y} C${c1!.x} ${c1!.y} ${c2!.x} ${c2!.y} ${p3!.x} ${p3!.y}`;
  }
  return roundedPathData(route.points, BOARD_STYLE.bendRadius, scale);
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
  const pad = opts.padding ?? 48;
  const bounds = boardBounds(doc, page) ?? { x: 0, y: 0, width: 200, height: 120 };
  const vx = bounds.x - pad;
  const vy = bounds.y - pad;
  const vw = bounds.width + pad * 2;
  const vh = bounds.height + pad * 2;
  const S = BOARD_STYLE;
  const out: string[] = [];
  const font = `font-family="${SVG_FONT}"`;
  const num = (n: number) => n.toFixed(1);

  // Screens a connector reaches, as the phone-sheet outlines a flow shows.
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
    out.push(`<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="8" fill="#fbfcfd" stroke="#cfd6df"/>`);
    out.push(`<text x="${x + width / 2}" y="${y + height + 22}" text-anchor="middle" ${font} font-size="13" fill="#7a8594">${escapeXml(node.name)}</text>`);
  }

  const shapes = boardOf(page).filter(isShape);
  const ordered = [...shapes.filter((s) => s.kind === 'section'), ...shapes.filter((s) => s.kind !== 'section')];
  for (const s of ordered) {
    const look = shapeLook(s);
    const { x, y, width: w, height: h } = s;
    if (s.kind === 'section') {
      out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${S.sectionRadius}" fill="#ffffff" filter="url(#sheet)"/>`);
      out.push(`<text x="${x + 24}" y="${y + 34}" ${font} font-size="${look.fontSize}" font-weight="600" fill="${look.text}">${escapeXml(s.text)}</text>`);
      continue;
    }
    const lifted = s.color === 'neutral' && s.kind === 'rect';
    const edge = `fill="${look.fill}" stroke="${look.stroke}" stroke-width="${look.strokeWidth}"${look.dashed ? ' stroke-dasharray="3 3"' : ''}${lifted ? ' filter="url(#card)"' : ''}`;
    if (s.kind === 'rect') out.push(`<rect x="${x + 0.5}" y="${y + 0.5}" width="${w - 1}" height="${h - 1}" rx="${s.rounded ? h / 2 : Math.min(S.radius, h / 2)}" ${edge}/>`);
    if (s.kind === 'ellipse') out.push(`<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2 - 0.5}" ry="${h / 2 - 0.5}" ${edge}/>`);
    if (s.kind === 'diamond') out.push(`<path d="${diamondPath(w - 1, h - 1, x + 0.5, y + 0.5, 3)}" ${edge}/>`);
    if (s.text) {
      const inset = s.kind === 'diamond' ? { x: w / 4, y: h / 4 } : s.kind === 'ellipse' ? { x: w * 0.15, y: h * 0.15 } : { x: 14, y: 4 };
      const isText = s.kind === 'text';
      out.push(`<foreignObject x="${x + inset.x}" y="${y + inset.y}" width="${Math.max(1, w - inset.x * 2)}" height="${Math.max(1, h - inset.y * 2)}">`
        + `<div xmlns="http://www.w3.org/1999/xhtml" style="display:flex;align-items:center;justify-content:${isText ? 'flex-start' : 'center'};`
        + `width:100%;height:100%;text-align:${isText ? 'left' : 'center'};font-family:${escapeXml(BOARD_FONT)};`
        + `font-size:${look.fontSize}px;font-weight:${look.weight};line-height:1.3;color:${look.text};overflow-wrap:break-word">${escapeXml(s.text)}</div></foreignObject>`);
    }
  }

  for (const item of boardOf(page)) {
    if (!isConnector(item)) continue;
    const route = routeConnector(doc, page, item);
    if (!route) continue;
    const c = BOARD_COLORS[item.color];
    const n = route.points.length;
    out.push(`<path d="${connectorPathData(route)}" fill="none" stroke="${c.accent}" stroke-width="${S.lineWidth}" stroke-linejoin="round"${item.dashed ? ' stroke-dasharray="3 3"' : ''}/>`);
    const head = (tip: Point, from: Point) => arrowHead(tip, from).map((p) => `${num(p.x)},${num(p.y)}`).join(' ');
    if (item.arrow !== 'none') out.push(`<polygon points="${head(route.points[n - 1]!, route.points[n - 2]!)}" fill="${c.accent}"/>`);
    if (item.arrow === 'both') out.push(`<polygon points="${head(route.points[0]!, route.points[1]!)}" fill="${c.accent}"/>`);
    else {
      const o = route.points[0]!;
      out.push(`<circle cx="${num(o.x)}" cy="${num(o.y)}" r="${S.originDot}" fill="#ffffff" stroke="${c.accent}" stroke-width="1"/>`);
    }
    const verdict = verdictOf(item.label);
    if (verdict) {
      const { x, y } = route.label;
      out.push(`<circle cx="${num(x)}" cy="${num(y)}" r="9" fill="${verdict === 'yes' ? S.yes : S.no}"/>`);
      out.push(verdict === 'yes'
        ? `<path d="M${num(x - 4)} ${num(y)} L${num(x - 1)} ${num(y + 3)} L${num(x + 4.5)} ${num(y - 3)}" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
        : `<path d="M${num(x - 3.5)} ${num(y - 3.5)} L${num(x + 3.5)} ${num(y + 3.5)} M${num(x + 3.5)} ${num(y - 3.5)} L${num(x - 3.5)} ${num(y + 3.5)}" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>`);
    } else if (item.label) {
      const w = Math.max(28, item.label.length * 6 + 18);
      out.push(`<rect x="${num(route.label.x - w / 2)}" y="${num(route.label.y - 10)}" width="${num(w)}" height="20" rx="10" fill="${S.labelFill}"/>`);
      out.push(`<text x="${num(route.label.x)}" y="${num(route.label.y + 3.8)}" text-anchor="middle" ${font} font-size="${S.labelFontSize}" fill="${item.color === 'neutral' ? S.labelText : c.text}">${escapeXml(item.label)}</text>`);
    }
  }

  const defs = '<defs><filter id="card" x="-10%" y="-20%" width="120%" height="160%">'
    + '<feDropShadow dx="0" dy="1" stdDeviation="0.8" flood-color="#1e293b" flood-opacity="0.06"/>'
    + '<feDropShadow dx="0" dy="2" stdDeviation="2.5" flood-color="#1e293b" flood-opacity="0.05"/></filter>'
    + '<filter id="sheet" x="-10%" y="-10%" width="120%" height="130%">'
    + '<feDropShadow dx="0" dy="1" stdDeviation="1" flood-color="#1e293b" flood-opacity="0.05"/>'
    + '<feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#1e293b" flood-opacity="0.10"/></filter></defs>';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vx} ${vy} ${vw} ${vh}" width="${Math.round(vw)}" height="${Math.round(vh)}">`
    + `${defs}<rect x="${vx}" y="${vy}" width="${vw}" height="${vh}" fill="${S.page}"/>${out.join('')}</svg>`;
}

/**
 * A diamond with softened corners, as a path in its own box (or offset).
 *
 * Sharp diamond points are the most sketch-like thing on a whiteboard; a
 * small rounding at each vertex keeps the shape unmistakable and makes it
 * belong with the rounded rectangles around it.
 */
export function diamondPath(w: number, h: number, x = 0, y = 0, radius = 6): string {
  const pts = [{ x: x + w / 2, y }, { x: x + w, y: y + h / 2 }, { x: x + w / 2, y: y + h }, { x, y: y + h / 2 }];
  const f = (n: number) => n.toFixed(1);
  let d = '';
  for (let i = 0; i < 4; i++) {
    const prev = pts[(i + 3) % 4]!;
    const at = pts[i]!;
    const next = pts[(i + 1) % 4]!;
    const inLen = Math.hypot(at.x - prev.x, at.y - prev.y);
    const outLen = Math.hypot(next.x - at.x, next.y - at.y);
    const cut = Math.min(radius, inLen / 3, outLen / 3);
    const a = { x: at.x - ((at.x - prev.x) / inLen) * cut, y: at.y - ((at.y - prev.y) / inLen) * cut };
    const b = { x: at.x + ((next.x - at.x) / outLen) * cut, y: at.y + ((next.y - at.y) / outLen) * cut };
    d += `${i ? ' L' : 'M'}${f(a.x)} ${f(a.y)} Q${f(at.x)} ${f(at.y)} ${f(b.x)} ${f(b.y)}`;
  }
  return `${d} Z`;
}
