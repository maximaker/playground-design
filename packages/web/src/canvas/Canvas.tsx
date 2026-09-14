/**
 * The infinite canvas: pan, zoom, selection, dragging, resizing and drawing.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type Box, type NodeId, type Op, type SnapGuide,
  makeNode, boxOf, getArtboardPosition, getArtboardSize,
  DEFAULT_ARTBOARD_STYLES, defaultStylesFor, makeNote, notesOf,
} from '@canvas/shared';
import { useCanvas, getDoc, currentPage, topLevelSelection, getNodeById } from '../state/store.ts';
import { resolveKey, treeNodeId } from '../state/keys.ts';
import { artboardOf } from '@canvas/shared';
import { Artboard } from './Artboard.tsx';
import { NoteCard } from './NoteCard.tsx';
import { Overlay } from './Overlay.tsx';
import { hitTest, nodeRect } from './registry.ts';
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
  const version = useCanvas((s) => s.version);
  const viewport = useCanvas((s) => s.viewport);
  const setViewport = useCanvas((s) => s.setViewport);
  const tool = useCanvas((s) => s.tool);
  const setTool = useCanvas((s) => s.setTool);
  const spacePanning = useCanvas((s) => s.spacePanning);
  const selection = useCanvas((s) => s.selection);
  const select = useCanvas((s) => s.select);
  const setHovered = useCanvas((s) => s.setHovered);
  const setMeasureTo = useCanvas((s) => s.setMeasureTo);
  const setEditingText = useCanvas((s) => s.setEditingText);
  const dispatch = useCanvas((s) => s.dispatch);

  const containerRef = useRef<HTMLDivElement | null>(null);
  // The viewport is stored in client coordinates (so it matches the rects the
  // overlay and hit-testing work in), but the world div is positioned inside
  // the stage. Subtract the stage origin when applying the transform, or the
  // offset gets counted twice.
  const [origin, setOrigin] = useState({ x: 0, y: 0 });
  const drag = useRef<Drag>({ kind: 'none' });
  const [marquee, setMarquee] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [drawPreview, setDrawPreview] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  // Guides live in the working space of whatever is being dragged; the space
  // they belong to is recorded so the overlay can convert them to the screen.
  const [guides, setGuides] = useState<{ guides: SnapGuide[]; space: 'canvas' | NodeId } | null>(null);

  const page = currentPage();

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
  }, [page, viewport.x, viewport.y, viewport.zoom, version, selection]);

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
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);

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

    const panning = spacePanning || tool === 'hand' || e.button === 1;
    if (panning) {
      drag.current = { kind: 'pan', startX: e.clientX, startY: e.clientY, originX: viewport.x, originY: viewport.y };
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

    if (d.kind === 'none') {
      const hit = hitTest(e.clientX, e.clientY);
      setHovered(hit?.nodeId ?? null);
      // Holding Alt over another node measures the distance to the selection.
      setMeasureTo(e.altKey && hit ? hit.nodeId : null);
      return;
    }

    const dxScreen = e.clientX - d.startX!;
    const dyScreen = e.clientY - d.startY!;
    const dx = dxScreen / vp.zoom;
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
        // something a few pixels off a guide on purpose.
        const snap = e.metaKey || e.ctrlKey
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
        const snap = e.metaKey || e.ctrlKey
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
        const proposed = resizeBox(d.start, dx, dy);
        const snap = e.metaKey || e.ctrlKey || e.shiftKey
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

  // --- Drawing new nodes -------------------------------------------------

  const handleDraw = useCallback((d: Extract<Drag, { kind: 'draw' }>, e: React.PointerEvent) => {
    const doc = getDoc();
    const page = currentPage();

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
  }, [page, viewport.x, viewport.y, viewport.zoom, version, selection]);
    if (!doc || !page) return;

    const vp = useCanvas.getState().viewport;
    const w = Math.abs(e.clientX - d.startX) / vp.zoom;
    const h = Math.abs(e.clientY - d.startY) / vp.zoom;
    const tool = useCanvas.getState().tool;

    // A click without a drag gets a sensible default size rather than nothing.
    const width = Math.max(w, tool === 'text' ? 0 : 24);
    const height = Math.max(h, tool === 'text' ? 0 : 24);

    if (!d.artboardId) {
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
      onPointerLeave={() => { setHovered(null); setMeasureTo(null); }}
      onContextMenu={(e) => {
        e.preventDefault();
        const hit = hitTest(e.clientX, e.clientY);
        // Right-clicking outside the selection retargets it first, so the menu
        // always acts on what the user pointed at.
        if (hit && !useCanvas.getState().selection.includes(hit.nodeId)) select([hit.nodeId]);
        onContextMenu({ x: e.clientX, y: e.clientY, nodeId: hit?.nodeId ?? null });
      }}
      onDoubleClick={onDoubleClick as unknown as React.MouseEventHandler}
    >
      <div
        className="canvas-grid"
        style={{
          backgroundSize: `${24 * viewport.zoom}px ${24 * viewport.zoom}px`,
          backgroundPosition: `${viewport.x - origin.x}px ${viewport.y - origin.y}px`,
        }}
      />
      <div
        className="canvas-world"
        style={{ transform: `translate(${viewport.x - origin.x}px, ${viewport.y - origin.y}px)` }}
      >
        {page.artboards.map((id) => (
          <Artboard key={id} id={id} live={visibleArtboards.has(id)} />
        ))}
        {notesOf(page).map((note) => <NoteCard key={note.id} note={note} />)}
      </div>

      <Overlay version={version} dropTarget={dropTarget} guides={guides} />

      {marquee && <div className="marquee" style={marquee} />}
      {drawPreview && <div className="draw-preview" style={drawPreview} />}
    </div>
  );
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
