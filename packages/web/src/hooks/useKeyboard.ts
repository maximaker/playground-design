/** Global keyboard shortcuts. */

import { useEffect } from 'react';
import { type NodeId, type Op, cloneSubtree, makeNode, defaultStylesFor, getArtboardPosition } from '@canvas/shared';
import { useCanvas, getDoc, currentPage, topLevelSelection } from '../state/store.ts';
import { nodeRect } from '../canvas/registry.ts';
import { parsePx } from '../canvas/styles.ts';

const TOOL_KEYS: Record<string, string> = {
  v: 'move', h: 'hand', f: 'frame', a: 'frame', t: 'text', r: 'rect', o: 'ellipse', i: 'image',
};

export function useKeyboard(): void {
  useEffect(() => {
    const isTyping = (target: EventTarget | null): boolean => {
      const el = target as HTMLElement | null;
      if (!el) return false;
      return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const state = useCanvas.getState();
      if (e.key === ' ' && !isTyping(e.target) && !state.spacePanning) {
        state.setSpacePanning(true);
        e.preventDefault();
        return;
      }
      if (isTyping(e.target)) return;

      const mod = e.metaKey || e.ctrlKey;
      const { selection, dispatch, select, setTool, setViewport } = state;

      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) state.redo(); else state.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); state.redo(); return; }

      if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelection(); return; }
      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        const page = currentPage();
        const doc = getDoc();
        if (page && doc) {
          // Select the contents of the artboards, not the artboards themselves —
          // ⌘A on a canvas almost always means "everything I am working on".
          const ids = page.artboards.flatMap((a) => doc.nodes[a]?.children ?? []);
          select(ids.length ? ids : page.artboards);
        }
        return;
      }
      if (mod && e.key.toLowerCase() === 'g') { e.preventDefault(); wrapInFrame(); return; }
      if (mod && e.key === '0') { e.preventDefault(); setViewport({ zoom: 1 }); return; }
      if (mod && (e.key === '=' || e.key === '+')) {
        e.preventDefault(); setViewport({ zoom: Math.min(8, state.viewport.zoom * 1.25) }); return;
      }
      if (mod && e.key === '-') {
        e.preventDefault(); setViewport({ zoom: Math.max(0.02, state.viewport.zoom / 1.25) }); return;
      }
      if (e.key === '1' && !mod) { e.preventDefault(); zoomToFit(); return; }
      if (e.key === '2' && !mod) { e.preventDefault(); zoomToSelection(); return; }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!selection.length) return;
        e.preventDefault();
        dispatch([{ t: 'remove', ids: topLevelSelection(selection) }]);
        select([]);
        return;
      }

      if (e.key === 'Escape') {
        if (state.editingText) state.setEditingText(null);
        else if (state.tool !== 'move') setTool('move');
        else select([]);
        return;
      }

      if (e.key === 'Enter' && selection.length === 1) {
        const node = getDoc()?.nodes[selection[0]!];
        if (node?.type === 'text') { e.preventDefault(); state.setEditingText(node.id); }
        return;
      }

      if (e.key.startsWith('Arrow') && selection.length) {
        e.preventDefault();
        nudge(e.key, e.shiftKey ? 10 : 1);
        return;
      }

      if (!mod && TOOL_KEYS[e.key.toLowerCase()]) {
        setTool(TOOL_KEYS[e.key.toLowerCase()] as never);
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ') useCanvas.getState().setSpacePanning(false);
    };

    // A dropped focus (e.g. alt-tab mid-pan) would otherwise leave space stuck.
    const onBlur = () => useCanvas.getState().setSpacePanning(false);

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);
}

function duplicateSelection(): void {
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

function wrapInFrame(): void {
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

function nudge(key: string, amount: number): void {
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

function zoomToFit(): void {
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

function zoomToSelection(): void {
  const { selection } = useCanvas.getState();
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
