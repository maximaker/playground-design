/**
 * The board's half of the canvas gestures.
 *
 * Canvas.tsx owns the pointer; these are the decisions that are about the board
 * rather than about the design — what is under the pointer, what a drag moves,
 * what a resize does to a box — kept here so the canvas reads as a dispatcher
 * rather than as two tools interleaved.
 */

import {
  type BoardShape, type BoardShapeKind, type Endpoint, type Op, type Page, type Point,
  boardOf, isShape, makeBoardShape, sectionContents, DEFAULT_SHAPE_SIZE,
} from '@playground/shared';
import { useCanvas } from '../state/store.ts';
import { hitTest } from './registry.ts';
import { toCanvasSpace } from './interactions.ts';
import type { BoardHandle, ConnectPreview } from './Board.tsx';

/** The board item a pointer event landed on, if it landed on one. */
export function boardIdAt(target: EventTarget | null): string | null {
  return (target as HTMLElement | null)?.closest?.<HTMLElement>('[data-board-id]')?.dataset.boardId ?? null;
}

/**
 * What a connector end dropped here attaches to.
 *
 * A board shape under the pointer first — sections excluded, so drawing an
 * arrow between two things inside a section does not snag on the section —
 * then an artboard, then nothing, which leaves a free end where it was let go.
 */
export function endpointAt(page: Page, clientX: number, clientY: number, not?: string): {
  endpoint: Endpoint; target: ConnectPreview['target']; at: Point;
} {
  const vp = useCanvas.getState().viewport;
  const at = toCanvasSpace(clientX, clientY, vp);
  for (const el of document.elementsFromPoint(clientX, clientY)) {
    const id = (el as HTMLElement).closest?.<HTMLElement>('[data-board-id]')?.dataset.boardId;
    if (!id || id === not) continue;
    const item = boardOf(page).find((i) => i.id === id);
    if (isShape(item) && item.kind !== 'section') {
      return { endpoint: { kind: 'shape', id }, target: { kind: 'shape', id }, at };
    }
  }
  const hit = hitTest(clientX, clientY);
  if (hit?.artboardId && hit.artboardId !== not) {
    return { endpoint: { kind: 'artboard', id: hit.artboardId }, target: { kind: 'artboard', id: hit.artboardId }, at };
  }
  return { endpoint: { kind: 'point', x: Math.round(at.x), y: Math.round(at.y) }, target: null, at };
}

/**
 * What moves when the selection is dragged.
 *
 * The selected shapes, and whatever sits inside a selected section — a
 * section carries its contents, which is the reason to draw one. Connectors
 * are never moved themselves: their ends are attached to shapes, and a free
 * end stays where it was put.
 */
export function movingSet(page: Page, selected: string[]): Record<string, { x: number; y: number }> {
  const origins: Record<string, { x: number; y: number }> = {};
  const board = boardOf(page);
  const take = (id: string) => {
    const item = board.find((i) => i.id === id);
    if (isShape(item)) origins[id] = { x: item.x, y: item.y };
  };
  for (const id of selected) {
    take(id);
    const item = board.find((i) => i.id === id);
    if (isShape(item) && item.kind === 'section') for (const inner of sectionContents(page, id)) take(inner);
  }
  return origins;
}

export function moveChanges(page: Page, origins: Record<string, { x: number; y: number }>, dx: number, dy: number): Op {
  return {
    t: 'board', pageId: page.id,
    changes: Object.entries(origins).map(([id, o]) => ({
      action: 'update' as const, id, patch: { x: Math.round(o.x + dx), y: Math.round(o.y + dy) },
    })),
  };
}

export function restoreMove(page: Page, origins: Record<string, { x: number; y: number }>): Op {
  return {
    t: 'board', pageId: page.id,
    changes: Object.entries(origins).map(([id, o]) => ({ action: 'update' as const, id, patch: { x: o.x, y: o.y } })),
  };
}

/** A box resized from one of its eight handles; Shift keeps its proportions. */
export function resizedBox(
  box: { x: number; y: number; width: number; height: number },
  handle: BoardHandle, dx: number, dy: number, keepRatio: boolean,
): { x: number; y: number; width: number; height: number } {
  let { x, y, width, height } = box;
  const min = 16;
  if (handle.includes('e')) width = Math.max(min, box.width + dx);
  if (handle.includes('s')) height = Math.max(min, box.height + dy);
  if (handle.includes('w')) { width = Math.max(min, box.width - dx); x = box.x + box.width - width; }
  if (handle.includes('n')) { height = Math.max(min, box.height - dy); y = box.y + box.height - height; }
  if (keepRatio && box.width && box.height) {
    const ratio = box.width / box.height;
    if (handle === 'n' || handle === 's') width = height * ratio;
    else height = width / ratio;
    if (handle.includes('w')) x = box.x + box.width - width;
    if (handle.includes('n')) y = box.y + box.height - height;
  }
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

/** Which board shape a drawing tool makes. */
export function boardKindFor(tool: string): BoardShapeKind | null {
  switch (tool) {
    case 'rect': return 'rect';
    case 'ellipse': return 'ellipse';
    case 'diamond': return 'diamond';
    case 'text': return 'text';
    case 'section': return 'section';
    default: return null;
  }
}

/**
 * The shape a drawing gesture on the board produces.
 *
 * A click without a drag gets the kind's default size, centred where it was
 * clicked, rather than a 24px speck: on a whiteboard a click means "put one
 * here".
 */
export function drawnShape(kind: BoardShapeKind, start: Point, end: Point, zoom: number): BoardShape {
  const w = Math.abs(end.x - start.x);
  const h = Math.abs(end.y - start.y);
  const dragged = w * zoom > 8 || h * zoom > 8;
  const size = DEFAULT_SHAPE_SIZE[kind];
  const box = dragged
    ? { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.max(16, w), height: Math.max(16, h) }
    : { x: start.x - size.width / 2, y: start.y - size.height / 2, ...size };
  return makeBoardShape({
    kind,
    x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height),
    text: kind === 'section' ? 'Section' : '',
  });
}
