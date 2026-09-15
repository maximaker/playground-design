/**
 * The infinite canvas: pan, zoom, selection, dragging, resizing and drawing.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type Box, type NodeId, type Op, type SnapGuide,
  makeNode, boxOf, getArtboardPosition, getArtboardSize,
  DEFAULT_ARTBOARD_STYLES, defaultStylesFor, makeComment, makeNote, notesOf, commentsOf, breakpointsOf,
} from '@playground/shared';
import { useCanvas, getDoc, currentPage, topLevelSelection, getNodeById } from '../state/store.ts';
import { resolveKey, treeNodeId } from '../state/keys.ts';
import { artboardOf } from '@playground/shared';
import { Artboard } from './Artboard.tsx';
import { NoteCard } from './NoteCard.tsx';
import { Overlay } from './Overlay.tsx';
import { PeerCursors } from './PeerCursors.tsx';
import { imageSize, insertImages } from '../hooks/useClipboard.ts';
import { CommentPin, CommentComposer, authorName } from './CommentPin.tsx';
import { hitTest, nodeInnerRect, nodeRect } from './registry.ts';
import { Rulers } from './Rulers.tsx';

/**
 * Read at the moment of the drag rather than captured in a closure: the
 * preference can be toggled mid-drag, and the pointer handlers are installed
 * once.
 */
const snapOn = () => useCanvas.getState().canvasPrefs.snap;
import {
  type DropTarget, type Handle, type ResizeStart,
  artboardBoxes, beginResize, buildMoveOps, computeDropTarget, nextArtboardPosition,
  nodesInRect, resizeBox, resizeStyles, siblingBoxes, snapMove, snapResizeEdges, toCanvasSpace,
} from './interactions.ts';
import { parsePx } from './styles.ts';

type Drag =
  | { kind: 'none' }
  | { kind: 'pan'; startX: number; startY: number; originX: number; originY: number }
  | { kind: 'marquee'; startX: number; startY: number; additive: boolean }
  | { kind: 'maybe-move'; ids: NodeId[]; startX: number; startY: number }
  | { kind: 'move-nodes'; ids: NodeId[]; startX: number; startY: number; batch: string }
  | { kind: 'move-artboards'; ids: NodeId[]; startX: number; startY: number; origins: Record<NodeId, { x: number; y: number }>; batch: string; restore: Op; candidates: Box[]; size: { width: number; height: number } }
  | { kind: 'move-absolute'; ids: NodeId[]; startX: number; startY: number; origins: Record<NodeId, { left: number; top: number }>; batch: string; restore: Op; candidates: Box[]; container: Box | null; size: { width: number; height: number } }
  | { kind: 'resize'; start: ResizeStart; startX: number; startY: number; batch: string; restore: Op; candidates: Box[]; container: Box | null }
  | { kind: 'draw'; startX: number; startY: number; artboardId: NodeId | null }
  | { kind: 'move-note'; id: string; startX: number; startY: number; origin: { x: number; y: number }; batch: string; restore: Op };

const DRAG_THRESHOLD = 4;

interface CanvasProps {
  onContextMenu: (state: { x: number; y: number; nodeId: NodeId | null }) => void;
}

export function Canvas({ onContextMenu }: CanvasProps) {
  const structureVersion = useCanvas((s) => s.structureVersion);
  const styleEpoch = useCanvas((s) => s.styleEpoch);
  const viewport = useCanvas((s) => s.viewport);
  const setViewport = useCanvas((s) => s.setViewport);
  const tool = useCanvas((s) => s.tool);
  const setTool = useCanvas((s) => s.setTool);
  const spacePanning = useCanvas((s) => s.spacePanning);
  const selection = useCanvas((s) => s.selection);
  const select = useCanvas((s) => s.select);
  const setHovered = useCanvas((s) => s.setHovered);
  const setMeasureTo = useCanvas((s) => s.setMeasureTo);
  const setPointer = useCanvas((s) => s.setPointer);
  const setEditingText = useCanvas((s) => s.setEditingText);
  const dispatch = useCanvas((s) => s.dispatch);

  const containerRef = useRef<HTMLDivElement | null>(null);
  // The viewport is stored in client coordinates (so it matches the rects the
  // overlay and hit-testing work in), but the world div is positioned inside
  // the stage. Subtract the stage origin when applying the transform, or the
  // offset gets counted twice.
  const [origin, setOrigin] = useState({ x: 0, y: 0 });
  const prefs = useCanvas((s) => s.canvasPrefs);
  // The Comments panel shows the pins while it is open, whatever the preference
  // says: a lens you have to switch on separately is not a lens.
  const commentLens = useCanvas((s) => s.commentLens);
  /**
   * The pointer in canvas space, for the ruler's position marker. Held here
   * rather than read from the peer-cursor state because that one is rounded and
   * throttled for the network; a marker that lags the cursor reads as broken.
   */
  const [rulerPointer, setRulerPointer] = useState<{ x: number; y: number } | null>(null);

  /**
   * Picking the comment tool with something selected comments on *that*.
   *
   * Otherwise the selection is decoration: you have told the tool what you are
   * talking about and it still asks you to click, and the pin lands wherever
   * the pointer happened to be.
   */
  useEffect(() => {
    if (tool !== 'comment') return;
    const id = selection[0]?.split('::')[0];
    const doc = getDoc();
    const page = currentPage();
    if (!id || !doc?.nodes[id] || !page) return;
    const at = canvasBoxOf(id);
    if (!at) return;
    useCanvas.getState().setDraftComment(makeComment({
      pageId: page.id,
      nodeId: id,
      x: Math.round(at.right),
      y: Math.round(at.top),
      author: authorName(),
    }));
    setTool('move');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool]);

  /**
   * The selection's box in canvas space, banded on both rulers so you can read
   * where a layer starts and ends without measuring it.
   *
   * Measured from the live DOM, which is why it is keyed to everything that can
   * move it — a memo on selection alone would band the old position after a drag.
   */
  const rulerHighlight = useMemo(() => {
    if (!prefs.rulers || selection.length === 0) return null;
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const id of selection) {
      const rect = nodeRect(id);
      if (!rect) continue;
      left = Math.min(left, rect.left); top = Math.min(top, rect.top);
      right = Math.max(right, rect.right); bottom = Math.max(bottom, rect.bottom);
    }
    if (left === Infinity) return null;
    const vp = viewport;
    return {
      x: (left - vp.x) / vp.zoom,
      y: (top - vp.y) / vp.zoom,
      width: (right - left) / vp.zoom,
      height: (bottom - top) / vp.zoom,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // rulerPointer changes on every move, which is also exactly when a drag is
    // moving the thing being banded — so it doubles as the drag-time refresh.
  }, [prefs.rulers, selection, viewport, structureVersion, styleEpoch, rulerPointer]);
  const drag = useRef<Drag>({ kind: 'none' });
  const [marquee, setMarquee] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [drawPreview, setDrawPreview] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  // Guides live in the working space of whatever is being dragged; the space
  // they belong to is recorded so the overlay can convert them to the screen.
  const [guides, setGuides] = useState<{ guides: SnapGuide[]; space: 'canvas' | NodeId } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dropping, setDropping] = useState(false);
  // Hover hit-testing reads layout inside an iframe, so it runs at most once a
  // frame rather than once per pointermove event.
  const hoverRaf = useRef(0);

  const page = currentPage();
  const doc = getDoc();

  // Only artboards near the viewport get a live iframe. Each one is a real
  // document with its own layout and style engine, so a page with dozens of
  // them would otherwise cost hundreds of megabytes and stall panning. This is
  // the mitigation the PRD calls for against the iframe-per-artboard risk.
  const visibleArtboards = useMemo(() => {
    const doc = getDoc();
    if (!doc || !page) return new Set<NodeId>();

    const stage = containerRef.current?.getBoundingClientRect();
    if (!stage) return new Set(page.artboards);

    // A generous margin so panning does not reveal blank frames.
    const margin = Math.max(stage.width, stage.height);
    const left = (stage.left - viewport.x - margin) / viewport.zoom;
    const top = (stage.top - viewport.y - margin) / viewport.zoom;
    const right = (stage.right - viewport.x + margin) / viewport.zoom;
    const bottom = (stage.bottom - viewport.y + margin) / viewport.zoom;

    const near = new Set<NodeId>();
    for (const id of page.artboards) {
      const node = doc.nodes[id];
      if (!node) continue;
      const pos = getArtboardPosition(node);
      const size = getArtboardSize(node);
      if (pos.x + size.width < left || pos.x > right) continue;
      if (pos.y + size.height < top || pos.y > bottom) continue;
      near.add(id);
    }

    // Never unmount an artboard that holds the selection: measuring it drives
    // the overlay, and it must stay live even if the user pans it off screen.
    for (const id of selection) {
      const artboard = artboardOf(doc, id);
      if (artboard) near.add(artboard);
    }
    return near;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, viewport.x, viewport.y, viewport.zoom, structureVersion, selection]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setOrigin((prev) => (prev.x === rect.left && prev.y === rect.top ? prev : { x: rect.left, y: rect.top }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
  }, []);

  // --- Touch: pinch to zoom, two fingers to pan ---------------------------

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Tracked here rather than in the pointer handlers because a pinch must not
    // be mistaken for a drag: the first finger would otherwise start moving a
    // layer before the second one lands.
    const active = new Map<number, { x: number; y: number }>();
    let gesture: { distance: number; centreX: number; centreY: number; zoom: number } | null = null;

    const centreOf = () => {
      const points = [...active.values()];
      const x = points.reduce((sum, p) => sum + p.x, 0) / points.length;
      const y = points.reduce((sum, p) => sum + p.y, 0) / points.length;
      const [a, b] = points;
      return { x, y, distance: a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0 };
    };

    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      active.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (active.size === 2) {
        const c = centreOf();
        const vp = useCanvas.getState().viewport;
        gesture = { distance: c.distance, centreX: c.x, centreY: c.y, zoom: vp.zoom };
        // Cancel whatever the first finger started.
        drag.current = { kind: 'none' };
        setGuides(null);
        setDropTarget(null);
      }
    };

    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'touch' || !active.has(e.pointerId)) return;
      active.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (active.size !== 2 || !gesture) return;
      e.preventDefault();

      const c = centreOf();
      const vp = useCanvas.getState().viewport;
      const scale = gesture.distance > 0 ? c.distance / gesture.distance : 1;
      const zoom = Math.min(8, Math.max(0.02, gesture.zoom * scale));
      const k = zoom / vp.zoom;

      setViewport({
        zoom,
        // Zoom about the pinch centre, and pan by however far it moved.
        x: c.x - (gesture.centreX - vp.x) * k + (c.x - gesture.centreX),
        y: c.y - (gesture.centreY - vp.y) * k + (c.y - gesture.centreY),
      });
      gesture = { distance: c.distance, centreX: c.x, centreY: c.y, zoom };
    };

    const onUp = (e: PointerEvent) => {
      active.delete(e.pointerId);
      if (active.size < 2) gesture = null;
    };

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove, { passive: false });
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
    };
  }, [setViewport]);

  // --- Zoom and pan ------------------------------------------------------

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const vp = useCanvas.getState().viewport;
      if (e.ctrlKey || e.metaKey) {
        // Zoom toward the cursor so the point under it stays put.
        const factor = Math.exp(-e.deltaY / 200);
        const zoom = Math.min(8, Math.max(0.02, vp.zoom * factor));
        const k = zoom / vp.zoom;
        setViewport({ zoom, x: e.clientX - (e.clientX - vp.x) * k, y: e.clientY - (e.clientY - vp.y) * k });
      } else {
        setViewport({ x: vp.x - e.deltaX, y: vp.y - e.deltaY });
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [setViewport]);

  // --- Pointer down ------------------------------------------------------

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    const doc = getDoc();
    if (!doc || !page) return;
    // A second finger turns this into a pinch, handled by the gesture effect.
    if (e.pointerType === 'touch' && !e.isPrimary) { drag.current = { kind: 'none' }; return; }
    try {
      // Throws if the pointer has already been released, which happens with
      // fast taps and with synthetic events; it is an optimisation, not a
      // requirement, so losing it must not abort the gesture.
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    } catch { /* capture is best-effort */ }

    // A pointerdown inside a note is the note's own business, except for drags.
    const noteEl = (e.target as HTMLElement).closest<HTMLElement>('[data-note-id]');
    if (noteEl && tool === 'move' && !e.button) {
      const id = noteEl.dataset.noteId!;
      const note = notesOf(page).find((n) => n.id === id);
      if (note) {
        drag.current = {
          kind: 'move-note', id, startX: e.clientX, startY: e.clientY,
          origin: { x: note.x, y: note.y },
          batch: `b_${Date.now()}`,
          restore: { t: 'note', action: 'update', pageId: page.id, note: { id, x: note.x, y: note.y } },
        };
        return;
      }
    }

    setDragging(true);
    const panning = spacePanning || tool === 'hand' || e.button === 1;
    if (panning) {
      drag.current = { kind: 'pan', startX: e.clientX, startY: e.clientY, originX: viewport.x, originY: viewport.y };
      return;
    }

    if (tool === 'comment') {
      const at = toCanvasSpace(e.clientX, e.clientY, viewport);
      // The node under the pin is recorded as well as the position, so an agent
      // reading the thread knows what it is about — but the pin keeps its own
      // coordinates, so the remark survives the node being moved or deleted.
      const hit = hitTest(e.clientX, e.clientY);
      const comment = makeComment({
        pageId: page.id,
        nodeId: hit?.nodeId,
        // Pinned to the corner of the thing it is about rather than to the
        // exact pixel clicked: a pin floating in the middle of a card reads as
        // being about the word underneath it.
        ...cornerOf(hit?.nodeId, at),
        author: authorName(),
      });
      useCanvas.getState().setDraftComment(comment);
      setTool('move');
      return;
    }

    if (tool === 'note') {
      const at = toCanvasSpace(e.clientX, e.clientY, viewport);
      const note = makeNote({
        x: Math.round(at.x), y: Math.round(at.y),
        // A card dropped while something is selected is about that selection.
        targets: [...selection],
        author: 'You',
      });
      dispatch([{ t: 'note', action: 'add', pageId: page.id, note }]);
      useCanvas.getState().selectNote(note.id);
      setTool('move');
      return;
    }

    if (tool !== 'move') {
      const hit = hitTest(e.clientX, e.clientY);
      drag.current = { kind: 'draw', startX: e.clientX, startY: e.clientY, artboardId: hit?.artboardId ?? null };
      return;
    }

    // Dragging an artboard's label moves the artboard.
    const labelId = (e.target as HTMLElement).closest<HTMLElement>('[data-artboard-label]')?.dataset.artboardLabel;
    if (labelId && doc.nodes[labelId]) {
      const already = selection.includes(labelId);
      if (e.shiftKey) useCanvas.getState().toggleSelect(labelId);
      else if (!already) select([labelId]);
      const ids = topLevelSelection(already || e.shiftKey ? useCanvas.getState().selection : [labelId])
        .filter((id) => doc.nodes[id]?.parent === null);
      drag.current = { kind: 'maybe-move', ids: ids.length ? ids : [labelId], startX: e.clientX, startY: e.clientY };
      return;
    }

    const handle = (e.target as HTMLElement).dataset.handle as Handle | undefined;
    if (handle && selection.length === 1) {
      const start = beginResize(doc, selection[0]!, handle);
      if (start) {
        const before = doc.nodes[start.id]!.styles;
        const sib = siblingBoxes(doc, start.id, [start.id]);
        drag.current = {
          kind: 'resize', start, startX: e.clientX, startY: e.clientY, batch: `b_${Date.now()}`,
          candidates: sib.boxes,
          container: sib.container,
          restore: {
            t: 'styles',
            updates: [{
              id: start.id,
              styles: {
                width: before.width ?? '', height: before.height ?? '',
                left: before.left ?? '', top: before.top ?? '',
              },
            }],
          },
        };
        return;
      }
    }

    const hit = hitTest(e.clientX, e.clientY);
    if (!hit) {
      if (!e.shiftKey) { select([]); useCanvas.getState().selectNote(null); }
      drag.current = { kind: 'marquee', startX: e.clientX, startY: e.clientY, additive: e.shiftKey };
      return;
    }

    // A plain click targets the outermost element inside the artboard; ⌘-click
    // reaches the deepest one, matching how every other design tool behaves.
    // Inside a component instance the outermost thing is the instance itself,
    // so a plain click selects that and ⌘-click reaches the part to override.
    let targetId = hit.nodeId;
    if (!e.metaKey && !e.ctrlKey) {
      const instanceId = treeNodeId(targetId);
      if (instanceId !== targetId) {
        targetId = instanceId;
      }
      let node = doc.nodes[targetId];
      while (node?.parent && node.parent !== hit.artboardId && !selection.includes(node.id)) {
        node = doc.nodes[node.parent];
      }
      if (node) targetId = node.id;
    }

    const already = selection.includes(targetId);
    if (e.shiftKey) {
      useCanvas.getState().toggleSelect(targetId);
    } else if (!already) {
      select([targetId]);
    }

    const ids = topLevelSelection(already || e.shiftKey ? useCanvas.getState().selection : [targetId]);
    drag.current = { kind: 'maybe-move', ids, startX: e.clientX, startY: e.clientY };
  }, [page, select, selection, spacePanning, tool, viewport.x, viewport.y]);

  // --- Pointer move ------------------------------------------------------

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const doc = getDoc();
    if (!doc) return;
    const d = drag.current;
    const vp = useCanvas.getState().viewport;

    // Broadcast position in world coordinates, so a peer at a different zoom
    // sees the cursor over the same part of the design rather than the same
    // part of their screen. Rounded because sub-pixel precision is invisible
    // and would make every frame a change worth sending.
    const atX = (e.clientX - vp.x) / vp.zoom;
    const atY = (e.clientY - vp.y) / vp.zoom;
    setPointer({ x: Math.round(atX), y: Math.round(atY) });
    // Only while the rulers are on: this is a state update per pointer move.
    if (useCanvas.getState().canvasPrefs.rulers) setRulerPointer({ x: atX, y: atY });

    if (d.kind === 'none') {
      const { clientX, clientY, altKey } = e;
      cancelAnimationFrame(hoverRaf.current);
      hoverRaf.current = requestAnimationFrame(() => {
        // While a comment is open, the canvas stops drawing hover chrome: the
        // outline was being painted across the thread someone was reading.
        if (useCanvas.getState().draftComment || useCanvas.getState().openComment) {
          setHovered(null);
          setMeasureTo(null);
          return;
        }
        const hit = hitTest(clientX, clientY);
        setHovered(hit?.nodeId ?? null);
        // Holding Alt over another node measures the distance to the selection.
        setMeasureTo(altKey && hit ? hit.nodeId : null);
      });
      return;
    }

    const dxScreen = e.clientX - d.startX!;
    const dyScreen = e.clientY - d.startY!;
    let dx = dxScreen / vp.zoom;
    const dy = dyScreen / vp.zoom;

    switch (d.kind) {
      case 'pan':
        setViewport({ x: d.originX + dxScreen, y: d.originY + dyScreen });
        return;

      case 'marquee': {
        const rect = {
          left: Math.min(d.startX, e.clientX), top: Math.min(d.startY, e.clientY),
          width: Math.abs(dxScreen), height: Math.abs(dyScreen),
        };
        setMarquee(rect);
        if (page) {
          const hits = nodesInRect(doc, page, {
            left: rect.left, top: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height,
          });
          select(hits, d.additive);
        }
        return;
      }

      case 'move-note': {
        dispatch([{
          t: 'note', action: 'update', pageId: page!.id,
          note: { id: d.id, x: Math.round(d.origin.x + dx), y: Math.round(d.origin.y + dy) },
        }], { batch: d.batch, skipUndo: true });
        return;
      }

      case 'draw': {
        setDrawPreview({
          left: Math.min(d.startX, e.clientX), top: Math.min(d.startY, e.clientY),
          width: Math.abs(dxScreen), height: Math.abs(dyScreen),
        });
        return;
      }

      case 'maybe-move': {
        if (Math.abs(dxScreen) < DRAG_THRESHOLD && Math.abs(dyScreen) < DRAG_THRESHOLD) return;
        const batch = `b_${Date.now()}`;
        const first = doc.nodes[d.ids[0]!];
        if (!first) { drag.current = { kind: 'none' }; return; }

        if (first.parent === null) {
          const origins: Record<NodeId, { x: number; y: number }> = {};
          for (const id of d.ids) {
            const n = doc.nodes[id];
            if (n) origins[id] = getArtboardPosition(n);
          }
          const size = getArtboardSize(first);
          drag.current = {
            kind: 'move-artboards', ids: d.ids, startX: d.startX, startY: d.startY, origins, batch,
            candidates: artboardBoxes(doc, page?.artboards ?? [], d.ids),
            size,
            restore: {
              t: 'attrs',
              updates: d.ids.map((id) => ({
                id, attrs: { 'data-x': String(origins[id]?.x ?? 0), 'data-y': String(origins[id]?.y ?? 0) },
              })),
            },
          };
        } else if (first.styles.position === 'absolute' || first.styles.position === 'fixed') {
          const origins: Record<NodeId, { left: number; top: number }> = {};
          for (const id of d.ids) {
            const n = doc.nodes[id];
            if (n) origins[id] = { left: parsePx(n.styles.left), top: parsePx(n.styles.top) };
          }
          const rect = nodeRect(d.ids[0]!);
          const vpNow = useCanvas.getState().viewport;
          const sib = siblingBoxes(doc, d.ids[0]!, d.ids);
          drag.current = {
            kind: 'move-absolute', ids: d.ids, startX: d.startX, startY: d.startY, origins, batch,
            candidates: sib.boxes,
            container: sib.container,
            size: {
              width: (rect?.width ?? 0) / vpNow.zoom,
              height: (rect?.height ?? 0) / vpNow.zoom,
            },
            restore: {
              t: 'styles',
              updates: d.ids.map((id) => ({
                id,
                styles: {
                  left: `${origins[id]?.left ?? 0}px`,
                  top: `${origins[id]?.top ?? 0}px`,
                },
              })),
            },
          };
        } else {
          drag.current = { kind: 'move-nodes', ids: d.ids, startX: d.startX, startY: d.startY, batch };
        }
        return;
      }

      case 'move-artboards': {
        const lead = d.ids[0]!;
        const proposed = boxOf(
          lead,
          d.origins[lead]!.x + dx, d.origins[lead]!.y + dy,
          d.size.width, d.size.height,
        );
        // Holding ⌘ suspends snapping, the standard escape hatch for placing
        // something a few pixels off a guide on purpose. The preference is the
        // same switch held down for a whole session.
        const snap = e.metaKey || e.ctrlKey || !snapOn()
          ? { dx: 0, dy: 0, guides: [] }
          : snapMove(proposed, d.candidates, vp.zoom);
        setGuides(snap.guides.length ? { guides: snap.guides, space: 'canvas' } : null);

        dispatch([{
          t: 'attrs',
          updates: d.ids.map((id) => ({
            id,
            attrs: {
              'data-x': String(Math.round(d.origins[id]!.x + dx + snap.dx)),
              'data-y': String(Math.round(d.origins[id]!.y + dy + snap.dy)),
            },
          })),
        }], { batch: d.batch, skipUndo: true });
        return;
      }

      case 'move-absolute': {
        const lead = d.ids[0]!;
        const proposed = boxOf(
          lead,
          d.origins[lead]!.left + dx, d.origins[lead]!.top + dy,
          d.size.width, d.size.height,
        );
        const snap = e.metaKey || e.ctrlKey || !snapOn()
          ? { dx: 0, dy: 0, guides: [] }
          : snapMove(proposed, d.candidates, vp.zoom, d.container);
        const parentId = doc.nodes[lead]?.parent;
        setGuides(snap.guides.length && parentId ? { guides: snap.guides, space: parentId } : null);

        dispatch([{
          t: 'styles',
          updates: d.ids.map((id) => ({
            id,
            styles: {
              left: `${Math.round(d.origins[id]!.left + dx + snap.dx)}px`,
              top: `${Math.round(d.origins[id]!.top + dy + snap.dy)}px`,
            },
          })),
        }], { batch: d.batch, skipUndo: true });
        return;
      }

      case 'move-nodes': {
        setDropTarget(computeDropTarget(doc, d.ids, e.clientX, e.clientY));
        return;
      }

      case 'resize': {
        // Resizing an artboard settles on the document's breakpoints, so the
        // widths you author at are the widths the design responds at.
        const resizingArtboard = doc.nodes[d.start.id]?.type === 'artboard';
        if (resizingArtboard && !e.metaKey && !e.ctrlKey) {
          const target = d.start.width + dx;
          const snapped = snapOn()
            ? breakpointsOf(doc).find((bp) => Math.abs(bp.maxWidth - target) < 16 / vp.zoom)
            : undefined;
          if (snapped) dx = snapped.maxWidth - d.start.width;
        }
        const proposed = resizeBox(d.start, dx, dy);
        const snap = e.metaKey || e.ctrlKey || e.shiftKey || !snapOn()
          ? { dx: 0, dy: 0, guides: [] }
          : snapResizeEdges(proposed, d.candidates, d.start.handle, vp.zoom, d.container);
        const parentId = doc.nodes[d.start.id]?.parent;
        setGuides(snap.guides.length && parentId ? { guides: snap.guides, space: parentId } : null);

        dispatch([{
          t: 'styles',
          updates: [{ id: d.start.id, styles: resizeStyles(d.start, dx + snap.dx, dy + snap.dy, e.shiftKey) }],
        }], { batch: d.batch, skipUndo: true });
        return;
      }
    }
  }, [dispatch, page, select, setHovered, setMeasureTo, setViewport]);

  // --- Pointer up --------------------------------------------------------

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    const doc = getDoc();
    const d = drag.current;
    drag.current = { kind: 'none' };
    setDragging(false);
    setMarquee(null);
    setDrawPreview(null);
    setDropTarget(null);
    setGuides(null);

    if (!doc || !page) return;

    if (d.kind === 'move-nodes') {
      const target = computeDropTarget(doc, d.ids, e.clientX, e.clientY);
      if (target) {
        // ⌘ while dropping converts the node to absolute positioning at the
        // drop point, which is how you escape flex flow without a panel trip.
        if (e.metaKey || e.ctrlKey) {
          const parentRect = nodeRect(target.parentId);
          const styles: Op[] = d.ids.map((id) => {
            const r = nodeRect(id);
            const vp = useCanvas.getState().viewport;
            return {
              t: 'styles' as const,
              updates: [{
                id,
                styles: {
                  position: 'absolute',
                  left: `${Math.round(((r?.left ?? 0) - (parentRect?.left ?? 0)) / vp.zoom)}px`,
                  top: `${Math.round(((r?.top ?? 0) - (parentRect?.top ?? 0)) / vp.zoom)}px`,
                },
              }],
            };
          });
          dispatch([...buildMoveOps(doc, d.ids, target), ...styles], { batch: d.batch });
        } else {
          dispatch(buildMoveOps(doc, d.ids, target), { batch: d.batch });
        }
      }
      return;
    }

    // Intermediate frames of a drag were dispatched with skipUndo; record the
    // whole gesture as one undo entry now.
    if (d.kind === 'move-artboards' || d.kind === 'move-absolute' || d.kind === 'resize' || d.kind === 'move-note') {
      useCanvas.getState().pushUndo([d.restore], selection);
      return;
    }

    if (d.kind === 'draw') {
      handleDraw(d, e);
      return;
    }
  }, [dispatch, page, selection]);

  /**
   * Files dropped onto the canvas.
   *
   * Where it lands follows the pointer, not the selection: dropping something
   * *there* is a statement about where you want it. On empty canvas that means
   * a new artboard sized to the image, because dropping a screenshot to work
   * from is the reason people drag an image in at all, and making them create
   * a frame first is a step in the way of the obvious intent.
   */
  const onDrop = useCallback(async (e: React.DragEvent) => {
    setDropping(false);
    const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();

    const store = useCanvas.getState();
    if (store.readOnly) {
      store.toast('This is a view-only link. You can comment, but not change the design.', 'info');
      return;
    }

    const page = currentPage();
    if (!page) return;

    // A container under the pointer takes the image; text, images and vectors
    // cannot hold children, so walk up until something can.
    const hit = hitTest(e.clientX, e.clientY);
    let container = hit ? getDoc()?.nodes[hit.nodeId] : undefined;
    while (container && (container.type === 'text' || container.type === 'image' || container.type === 'vector' || container.type === 'code')) {
      container = container.parent ? getDoc()!.nodes[container.parent] : undefined;
    }

    if (container) { await insertImages(files, container.id); return; }

    // Empty canvas: one artboard per dropped image, at its natural size, placed
    // where it was dropped.
    const at = toCanvasSpace(e.clientX, e.clientY, useCanvas.getState().viewport);
    let offset = 0;
    for (const file of files) {
      const size = await imageSize(file);
      const artboard = makeNode({
        type: 'artboard',
        name: file.name.replace(/\.[^.]+$/, ''),
        styles: {
          ...DEFAULT_ARTBOARD_STYLES,
          width: `${size.width}px`,
          height: `${size.height}px`,
        },
        attrs: { 'data-x': String(Math.round(at.x + offset)), 'data-y': String(Math.round(at.y)) },
      });
      dispatch([{ t: 'insert', nodes: [artboard], parent: null, index: page.artboards.length }]);
      await insertImages([file], artboard.id);
      offset += size.width + 48;
    }
  }, [dispatch]);

  // --- Drawing new nodes -------------------------------------------------

  const handleDraw = useCallback((d: Extract<Drag, { kind: 'draw' }>, e: React.PointerEvent) => {
    const doc = getDoc();
    const page = currentPage();

    if (!doc || !page) return;

    const vp = useCanvas.getState().viewport;
    const w = Math.abs(e.clientX - d.startX) / vp.zoom;
    const h = Math.abs(e.clientY - d.startY) / vp.zoom;
    const tool = useCanvas.getState().tool;

    // A click without a drag gets a sensible default size rather than nothing.
    const width = Math.max(w, tool === 'text' ? 0 : 24);
    const height = Math.max(h, tool === 'text' ? 0 : 24);

    if (!d.artboardId) {
      // Only the frame tool means "new artboard" out here. Every other tool
      // drew on empty canvas by mistake, and silently producing an artboard is
      // a confusing answer to that.
      if (tool !== 'frame') {
        useCanvas.getState().toast(
          'Draw inside an artboard — or press F to create one first.',
          'info',
        );
        setTool('move');
        return;
      }

      // Empty canvas: the frame tool makes a new artboard, which is what the
      // gesture means out here.
      const start = toCanvasSpace(Math.min(d.startX, e.clientX), Math.min(d.startY, e.clientY), vp);
      const pos = width > 40 ? start : nextArtboardPosition(doc, page.artboards);
      const artboard = makeNode({
        type: 'artboard',
        name: `Artboard ${page.artboards.length + 1}`,
        styles: {
          ...DEFAULT_ARTBOARD_STYLES,
          width: `${Math.round(width > 40 ? width : 1440)}px`,
          height: `${Math.round(height > 40 ? height : 900)}px`,
        },
        attrs: { 'data-x': String(Math.round(pos.x)), 'data-y': String(Math.round(pos.y)) },
      });
      dispatch([{ t: 'insert', nodes: [artboard], parent: null, index: page.artboards.length, page: page.id }]);
      select([artboard.id]);
      setTool('move');
      return;
    }

    const parentHit = hitTest(Math.min(d.startX, e.clientX), Math.min(d.startY, e.clientY));
    const parentId = resolveContainer(parentHit?.nodeId ?? d.artboardId);
    const parentRect = nodeRect(parentId);
    const left = (Math.min(d.startX, e.clientX) - (parentRect?.left ?? 0)) / vp.zoom;
    const top = (Math.min(d.startY, e.clientY) - (parentRect?.top ?? 0)) / vp.zoom;

    const node = makeNode(nodeSpecFor(tool, width, height));
    // Drawn nodes are placed where they were drawn, which means absolute — the
    // alternative (appending to flex flow) puts the node somewhere the user did
    // not point at.
    node.styles = {
      ...node.styles,
      position: 'absolute',
      left: `${Math.round(left)}px`,
      top: `${Math.round(top)}px`,
    };

    dispatch([{ t: 'insert', nodes: [node], parent: parentId, index: (getNodeById(parentId)?.children.length ?? 0) }]);
    select([node.id]);
    if (tool === 'text') setEditingText(node.id);
    setTool('move');
  }, [dispatch, select, setEditingText, setTool]);

  // --- Double click enters text editing ----------------------------------

  const onDoubleClick = useCallback((e: React.PointerEvent) => {
    const hit = hitTest(e.clientX, e.clientY);
    if (!hit) return;
    // The hit id may be a composite key pointing inside a component instance,
    // so it has to be resolved rather than looked up directly.
    const resolved = resolveKey(getDoc(), hit.nodeId);
    if (!resolved?.node) return;
    select([hit.nodeId]);
    if (resolved.node.type === 'text') setEditingText(hit.nodeId);
  }, [select, setEditingText]);

  if (!page) return <div className="canvas-empty">No page</div>;

  return (
    <div
      ref={containerRef}
      className={`canvas${spacePanning || tool === 'hand' ? ' is-panning' : ''}${tool !== 'move' && tool !== 'hand' ? ' is-drawing' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => { setHovered(null); setMeasureTo(null); setPointer(null); setRulerPointer(null); }}
      onContextMenu={(e) => {
        e.preventDefault();
        const hit = hitTest(e.clientX, e.clientY);
        // Right-clicking outside the selection retargets it first, so the menu
        // always acts on what the user pointed at.
        if (hit && !useCanvas.getState().selection.includes(hit.nodeId)) select([hit.nodeId]);
        onContextMenu({ x: e.clientX, y: e.clientY, nodeId: hit?.nodeId ?? null });
      }}
      onDoubleClick={onDoubleClick as unknown as React.MouseEventHandler}
      onDragOver={(e) => {
        // Only claim a drag that actually carries files. Without this the canvas
        // swallows in-app drags — a layer being reordered, text being moved —
        // and they stop working.
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDropping(true);
      }}
      onDragLeave={(e) => {
        // dragleave fires for every child crossed on the way in, so ignore any
        // that is not the canvas itself losing the pointer.
        if (e.currentTarget === e.target) setDropping(false);
      }}
      onDrop={onDrop}
    >
      {prefs.grid && (
        <div
          className="canvas-grid"
          style={{
            backgroundSize: `${24 * viewport.zoom}px ${24 * viewport.zoom}px`,
            backgroundPosition: `${viewport.x - origin.x}px ${viewport.y - origin.y}px`,
          }}
        />
      )}
      <div
        className="canvas-world"
        style={{ transform: `translate(${viewport.x - origin.x}px, ${viewport.y - origin.y}px)` }}
      >
        {page.artboards.map((id) => (
          <Artboard key={id} id={id} live={visibleArtboards.has(id)} />
        ))}
        {notesOf(page).map((note) => <NoteCard key={note.id} note={note} />)}
      </div>

      <Overlay version={structureVersion} dropTarget={dropTarget} guides={guides} live={dragging} />

      {/*
        * Comments sit in their own layer above the overlay, translated with the
        * world so the pins stay on the design.
        *
        * Inside the world they were below the selection chrome no matter what
        * z-index they carried: the world has a transform, which makes it a
        * stacking context, so everything in it paints as one layer under the
        * overlay. A hairline selection outline drawn across the thread someone
        * is reading is exactly the sort of thing that looks broken.
        */}
      <div
        className="comment-layer"
        style={{ transform: `translate(${viewport.x - origin.x}px, ${viewport.y - origin.y}px)` }}
      >
        {(prefs.comments || commentLens) && doc
          && commentsOf(doc, page.id).map((c) => <CommentPin key={c.id} comment={c} />)}
        <CommentComposer />
      </div>

      {prefs.rulers && (
        <Rulers origin={origin} pointer={rulerPointer} highlight={rulerHighlight} />
      )}

      <div className="peer-cursors"><PeerCursors /></div>

      {dropping && (
        <div className="canvas-dropzone">
          <span>Drop to place — on a frame to put it inside, anywhere else for a new artboard</span>
        </div>
      )}

      {marquee && <div className="marquee" style={marquee} />}
      {drawPreview && <div className="draw-preview" style={drawPreview} />}
    </div>
  );
}

/**
 * Where a pin for a node should sit: its top-right corner, in canvas space.
 *
 * Computed from the artboard's canvas position plus the node's box *inside* its
 * iframe, never from screen coordinates. The world layer's transform animates,
 * so a screen rect measured mid-animation does not correspond to the viewport
 * the store is reporting — which put pins a thousand canvas pixels from the
 * thing they were about, but only sometimes.
 *
 * Falls back to the pointer when the comment is about the canvas rather than a
 * layer; a pin floating in the middle of a card reads as being about whatever
 * word happens to be underneath it.
 */
function cornerOf(nodeId: NodeId | undefined, fallback: { x: number; y: number }) {
  const at = nodeId ? canvasBoxOf(nodeId) : null;
  return at ? { x: Math.round(at.right), y: Math.round(at.top) }
    : { x: Math.round(fallback.x), y: Math.round(fallback.y) };
}

/** A node's box in canvas space, via its artboard rather than via the screen. */
function canvasBoxOf(nodeId: NodeId): { right: number; top: number } | null {
  const doc = getDoc();
  const artboardId = doc ? artboardOf(doc, nodeId) : null;
  const artboard = artboardId ? doc?.nodes[artboardId] : null;
  const inner = nodeInnerRect(nodeId);
  if (!artboard || !inner) return null;
  const pos = getArtboardPosition(artboard);
  return { right: pos.x + inner.right, top: pos.y + inner.top };
}

function resolveContainer(key: string): NodeId {
  // Drawing inside a component instance is not meaningful — the instance is a
  // single node in the tree — so climb out to the nearest real container.
  let node = getNodeById(treeNodeId(key));
  while (node && (node.type === 'text' || node.type === 'image' || node.type === 'vector' || node.type === 'instance')) {
    node = getNodeById(node.parent ?? undefined);
  }
  return node?.id ?? treeNodeId(key);
}

function nodeSpecFor(tool: string, width: number, height: number) {
  switch (tool) {
    case 'text':
      return {
        type: 'text' as const, tag: 'p', name: 'Text', text: 'Text',
        styles: { ...defaultStylesFor('text') },
      };
    case 'ellipse':
      return {
        type: 'shape' as const, name: 'Ellipse',
        styles: { ...defaultStylesFor('shape'), width: `${Math.round(width)}px`, height: `${Math.round(height)}px`, 'border-radius': '9999px' },
      };
    case 'image':
      return {
        type: 'image' as const, name: 'Image',
        attrs: { src: '', alt: '' },
        styles: { ...defaultStylesFor('image'), width: `${Math.round(width)}px`, height: `${Math.round(height)}px`, 'background-color': '#e5e7eb' },
      };
    case 'rect':
      return {
        type: 'shape' as const, name: 'Rectangle',
        styles: { ...defaultStylesFor('shape'), width: `${Math.round(width)}px`, height: `${Math.round(height)}px` },
      };
    default:
      return {
        type: 'frame' as const, name: 'Frame',
        styles: { ...defaultStylesFor('frame'), width: `${Math.round(width)}px`, height: `${Math.round(height)}px` },
      };
  }
}
