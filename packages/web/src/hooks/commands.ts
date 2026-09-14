/**
 * Editor commands.
 *
 * Shared by the keyboard shortcuts, the context menu and the toolbar, so every
 * action has exactly one implementation regardless of how it is invoked.
 */

import {
  type NodeId, type Op, type StyleMap,
  cloneSubtree, makeNode, defaultStylesFor, getArtboardPosition,
} from '@canvas/shared';
import { useCanvas, getDoc, currentPage, topLevelSelection } from '../state/store.ts';
import { nodeRect } from '../canvas/registry.ts';
import { parsePx } from '../canvas/styles.ts';

export function duplicateSelection(): void {
  const doc = getDoc();
  const { selection, dispatch, select } = useCanvas.getState();
  if (!doc || !selection.length) return;

  const ops: Op[] = [];
  const newIds: NodeId[] = [];
  for (const id of topLevelSelection(selection)) {
    const src = doc.nodes[id];
    if (!src) continue;
    const { nodes } = cloneSubtree(doc, id);
    const root = nodes[0]!;
    newIds.push(root.id);

    if (src.parent === null) {
      const pos = getArtboardPosition(src);
      root.attrs = { ...root.attrs, 'data-x': String(pos.x + 80), 'data-y': String(pos.y + 80) };
      root.name = `${src.name} copy`;
      const page = doc.pages.find((p) => p.artboards.includes(id)) ?? doc.pages[0]!;
      ops.push({ t: 'insert', nodes, parent: null, index: page.artboards.length, page: page.id });
    } else {
      // Offset absolutely-positioned copies so they do not hide under the original.
      if (src.styles.position === 'absolute') {
        root.styles = {
          ...root.styles,
          left: `${parsePx(src.styles.left) + 16}px`,
          top: `${parsePx(src.styles.top) + 16}px`,
        };
      }
      const index = doc.nodes[src.parent]!.children.indexOf(id) + 1;
      ops.push({ t: 'insert', nodes, parent: src.parent, index });
    }
  }
  if (ops.length) { dispatch(ops); select(newIds); }
}

export function wrapInFrame(): void {
  const doc = getDoc();
  const { selection, dispatch, select } = useCanvas.getState();
  if (!doc || !selection.length) return;

  const ids = topLevelSelection(selection);
  const first = doc.nodes[ids[0]!];
  if (!first?.parent) return;
  // Wrapping artboards is meaningless — they are page roots.
  if (ids.some((id) => doc.nodes[id]?.parent !== first.parent)) return;

  const frame = makeNode({
    type: 'frame',
    name: 'Group',
    styles: {
      ...defaultStylesFor('frame'),
      width: 'fit-content', height: 'fit-content',
      'background-color': 'transparent',
    },
  });
  const index = doc.nodes[first.parent]!.children.indexOf(ids[0]!);

  dispatch([
    { t: 'insert', nodes: [frame], parent: first.parent, index },
    { t: 'move', moves: ids.map((id, i) => ({ id, parent: frame.id, index: i })) },
  ]);
  select([frame.id]);
}

export function nudge(key: string, amount: number): void {
  const doc = getDoc();
  const { selection, dispatch } = useCanvas.getState();
  if (!doc) return;

  const dx = key === 'ArrowLeft' ? -amount : key === 'ArrowRight' ? amount : 0;
  const dy = key === 'ArrowUp' ? -amount : key === 'ArrowDown' ? amount : 0;

  const artboardMoves: { id: NodeId; attrs: Record<string, string> }[] = [];
  const styleMoves: { id: NodeId; styles: Record<string, string> }[] = [];

  for (const id of topLevelSelection(selection)) {
    const node = doc.nodes[id];
    if (!node) continue;
    if (node.parent === null) {
      const pos = getArtboardPosition(node);
      artboardMoves.push({ id, attrs: { 'data-x': String(pos.x + dx), 'data-y': String(pos.y + dy) } });
    } else if (node.styles.position === 'absolute' || node.styles.position === 'fixed') {
      styleMoves.push({
        id,
        styles: { left: `${parsePx(node.styles.left) + dx}px`, top: `${parsePx(node.styles.top) + dy}px` },
      });
    } else {
      // In flex flow there is nothing to nudge; adjust margin instead, which is
      // what the user is actually reaching for.
      styleMoves.push({
        id,
        styles: {
          'margin-left': `${parsePx(node.styles['margin-left']) + dx}px`,
          'margin-top': `${parsePx(node.styles['margin-top']) + dy}px`,
        },
      });
    }
  }

  const ops: Op[] = [];
  if (artboardMoves.length) ops.push({ t: 'attrs', updates: artboardMoves });
  if (styleMoves.length) ops.push({ t: 'styles', updates: styleMoves });
  if (ops.length) dispatch(ops);
}

export function zoomToFit(): void {
  const page = currentPage();
  const doc = getDoc();
  if (!page || !doc || !page.artboards.length) return;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const id of page.artboards) {
    const node = doc.nodes[id];
    if (!node) continue;
    const pos = getArtboardPosition(node);
    const w = parsePx(node.styles.width, 1440);
    const h = parsePx(node.styles.height, 900);
    minX = Math.min(minX, pos.x); minY = Math.min(minY, pos.y);
    maxX = Math.max(maxX, pos.x + w); maxY = Math.max(maxY, pos.y + h);
  }
  if (!Number.isFinite(minX)) return;
  fitBox(minX, minY, maxX - minX, maxY - minY);
}

export function zoomToSelection(): void {
  const { selection, selectedNote } = useCanvas.getState();

  // Prompt cards are selected separately from design nodes, but "zoom to what
  // I have selected" should mean the same thing either way.
  if (selectedNote) {
    const note = currentPage()?.notes?.find((n) => n.id === selectedNote);
    if (note) return fitBox(note.x, note.y, note.width, note.height);
  }

  if (!selection.length) return zoomToFit();

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const vp = useCanvas.getState().viewport;
  for (const id of selection) {
    const r = nodeRect(id);
    if (!r) continue;
    // Screen rect back to canvas space.
    const x = (r.left - vp.x) / vp.zoom;
    const y = (r.top - vp.y) / vp.zoom;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + r.width / vp.zoom); maxY = Math.max(maxY, y + r.height / vp.zoom);
  }
  if (!Number.isFinite(minX)) return;
  fitBox(minX, minY, maxX - minX, maxY - minY);
}

function fitBox(x: number, y: number, width: number, height: number): void {
  // Measure the stage rather than assuming panel widths: the rails are
  // responsive, so hardcoded offsets push content off-screen on narrow windows.
  const stage = document.querySelector('.stage')?.getBoundingClientRect();
  if (!stage) return;

  const padding = 64;
  const availableW = stage.width - padding * 2;
  const availableH = stage.height - padding * 2 - 60; // leave room for the toolbar
  const zoom = Math.min(4, Math.max(0.02, Math.min(
    availableW / Math.max(width, 1),
    availableH / Math.max(height, 1),
  )));

  useCanvas.getState().setViewport({
    zoom,
    x: stage.left + padding + (availableW - width * zoom) / 2 - x * zoom,
    y: stage.top + padding + (availableH - height * zoom) / 2 - y * zoom,
  });
}


// ---------------------------------------------------------------------------
// Style clipboard
// ---------------------------------------------------------------------------

/**
 * Copy/paste properties, the fastest way to make one thing look like another.
 * Layout-affecting properties are deliberately excluded: pasting a width and a
 * position along with a colour is almost never what is wanted.
 */
let styleClipboard: StyleMap | null = null;

const NON_TRANSFERABLE = new Set([
  'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
  'left', 'top', 'right', 'bottom', 'position', 'flex', 'flex-grow', 'flex-basis',
]);

export function copyProperties(): void {
  const doc = getDoc();
  const { selection, toast } = useCanvas.getState();
  const node = selection.length === 1 ? doc?.nodes[selection[0]!] : undefined;
  if (!node) { toast('Select a single layer to copy its properties', 'error'); return; }

  styleClipboard = Object.fromEntries(
    Object.entries(node.styles).filter(([k]) => !NON_TRANSFERABLE.has(k)),
  );
  toast(`Copied ${Object.keys(styleClipboard).length} properties`, 'success');
}

export function pasteProperties(): void {
  const { selection, dispatch, toast } = useCanvas.getState();
  if (!styleClipboard) { toast('No properties copied yet', 'error'); return; }
  if (!selection.length) return;
  dispatch([{ t: 'styles', updates: selection.map((id) => ({ id, styles: styleClipboard! })) }]);
  toast(`Applied properties to ${selection.length} layer${selection.length === 1 ? '' : 's'}`, 'success');
}

// ---------------------------------------------------------------------------
// Selection navigation
// ---------------------------------------------------------------------------

export function selectParent(): void {
  const doc = getDoc();
  const { selection, select } = useCanvas.getState();
  const parents = selection.map((id) => doc?.nodes[id]?.parent).filter((p): p is NodeId => !!p);
  if (parents.length) select([...new Set(parents)]);
}

export function selectChildren(): void {
  const doc = getDoc();
  const { selection, select } = useCanvas.getState();
  const children = selection.flatMap((id) => doc?.nodes[id]?.children ?? []);
  if (children.length) select(children);
}

/** Cycles to the next or previous sibling, matching Tab / Shift-Tab in Figma. */
export function selectSibling(direction: 1 | -1): void {
  const doc = getDoc();
  const page = currentPage();
  const { selection, select } = useCanvas.getState();
  const id = selection[0];
  if (!doc || !id) return;

  const node = doc.nodes[id];
  if (!node) return;
  const siblings = node.parent ? doc.nodes[node.parent]?.children : page?.artboards;
  if (!siblings?.length) return;

  const index = siblings.indexOf(id);
  const next = siblings[(index + direction + siblings.length) % siblings.length];
  if (next) select([next]);
}

export function toggleVisibility(): void {
  const doc = getDoc();
  const { selection, dispatch } = useCanvas.getState();
  if (!selection.length) return;
  dispatch([{ t: 'meta', updates: selection.map((id) => ({ id, visible: !(doc?.nodes[id]?.visible ?? true) })) }]);
}

export function toggleLock(): void {
  const doc = getDoc();
  const { selection, dispatch } = useCanvas.getState();
  if (!selection.length) return;
  dispatch([{ t: 'meta', updates: selection.map((id) => ({ id, locked: !(doc?.nodes[id]?.locked ?? false) })) }]);
}
