/**
 * The infinite canvas: pan, zoom, selection, dragging, resizing and drawing.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type NodeId, type Op, makeNode, getArtboardPosition, getArtboardSize,
  DEFAULT_ARTBOARD_STYLES, defaultStylesFor,
} from '@canvas/shared';
import { useCanvas, getDoc, currentPage, topLevelSelection, getNodeById } from '../state/store.ts';
import { Artboard } from './Artboard.tsx';
import { Overlay } from './Overlay.tsx';
import { hitTest, nodeRect } from './registry.ts';
import {
  type DropTarget, type Handle, type ResizeStart,
  beginResize, buildMoveOps, computeDropTarget, nextArtboardPosition,
  nodesInRect, resizeStyles, toCanvasSpace,
} from './interactions.ts';
import { parsePx } from './styles.ts';

type Drag =
  | { kind: 'none' }
  | { kind: 'pan'; startX: number; startY: number; originX: number; originY: number }
  | { kind: 'marquee'; startX: number; startY: number; additive: boolean }
  | { kind: 'maybe-move'; ids: NodeId[]; startX: number; startY: number }
  | { kind: 'move-nodes'; ids: NodeId[]; startX: number; startY: number; batch: string }
  | { kind: 'move-artboards'; ids: NodeId[]; startX: number; startY: number; origins: Record<NodeId, { x: number; y: number }>; batch: string; restore: Op }
  | { kind: 'move-absolute'; ids: NodeId[]; startX: number; startY: number; origins: Record<NodeId, { left: number; top: number }>; batch: string; restore: Op }
  | { kind: 'resize'; start: ResizeStart; startX: number; startY: number; batch: string; restore: Op }
  | { kind: 'draw'; startX: number; startY: number; artboardId: NodeId | null };

const DRAG_THRESHOLD = 4;

export function Canvas() {
  const version = useCanvas((s) => s.version);
  const viewport = useCanvas((s) => s.viewport);
  const setViewport = useCanvas((s) => s.setViewport);
  const tool = useCanvas((s) => s.tool);
  const setTool = useCanvas((s) => s.setTool);
  const spacePanning = useCanvas((s) => s.spacePanning);
  const selection = useCanvas((s) => s.selection);
  const select = useCanvas((s) => s.select);
  const setHovered = useCanvas((s) => s.setHovered);
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

  const page = currentPage();

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

    const panning = spacePanning || tool === 'hand' || e.button === 1;
    if (panning) {
      drag.current = { kind: 'pan', startX: e.clientX, startY: e.clientY, originX: viewport.x, originY: viewport.y };
      return;
    }

    if (tool !== 'move') {
      const hit = hitTest(e.clientX, e.clientY);
      drag.current = { kind: 'draw', startX: e.clientX, startY: e.clientY, artboardId: hit?.artboardId ?? null };
      return;
    }

    const handle = (e.target as HTMLElement).dataset.handle as Handle | undefined;
    if (handle && selection.length === 1) {
      const start = beginResize(doc, selection[0]!, handle);
      if (start) {
        const before = doc.nodes[start.id]!.styles;
        drag.current = {
          kind: 'resize', start, startX: e.clientX, startY: e.clientY, batch: `b_${Date.now()}`,
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
      if (!e.shiftKey) select([]);
      drag.current = { kind: 'marquee', startX: e.clientX, startY: e.clientY, additive: e.shiftKey };
      return;
    }

    // A plain click targets the outermost element inside the artboard; ⌘-click
    // reaches the deepest one, matching how every other design tool behaves.
    let targetId = hit.nodeId;
    if (!e.metaKey && !e.ctrlKey) {
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
          drag.current = {
            kind: 'move-artboards', ids: d.ids, startX: d.startX, startY: d.startY, origins, batch,
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
          drag.current = {
            kind: 'move-absolute', ids: d.ids, startX: d.startX, startY: d.startY, origins, batch,
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
        dispatch([{
          t: 'attrs',
          updates: d.ids.map((id) => ({
            id,
            attrs: {
              'data-x': String(Math.round(d.origins[id]!.x + dx)),
              'data-y': String(Math.round(d.origins[id]!.y + dy)),
            },
          })),
        }], { batch: d.batch, skipUndo: true });
        return;
      }

      case 'move-absolute': {
        dispatch([{
          t: 'styles',
          updates: d.ids.map((id) => ({
            id,
            styles: {
              left: `${Math.round(d.origins[id]!.left + dx)}px`,
              top: `${Math.round(d.origins[id]!.top + dy)}px`,
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
        dispatch([{
          t: 'styles',
          updates: [{ id: d.start.id, styles: resizeStyles(d.start, dx, dy, e.shiftKey) }],
        }], { batch: d.batch, skipUndo: true });
        return;
      }
    }
  }, [dispatch, page, select, setHovered, setViewport]);

  // --- Pointer up --------------------------------------------------------

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    const doc = getDoc();
    const d = drag.current;
    drag.current = { kind: 'none' };
    setMarquee(null);
    setDrawPreview(null);
    setDropTarget(null);

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
    if (d.kind === 'move-artboards' || d.kind === 'move-absolute' || d.kind === 'resize') {
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
    const node = getNodeById(hit.nodeId);
    if (node?.type === 'text') {
      select([hit.nodeId]);
      setEditingText(hit.nodeId);
    } else if (node) {
      select([hit.nodeId]);
    }
  }, [select, setEditingText]);

  if (!page) return <div className="canvas-empty">No page</div>;

  return (
    <div
      ref={containerRef}
      className={`canvas${spacePanning || tool === 'hand' ? ' is-panning' : ''}${tool !== 'move' && tool !== 'hand' ? ' is-drawing' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => setHovered(null)}
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
        {page.artboards.map((id) => <Artboard key={id} id={id} />)}
      </div>

      <Overlay version={version} dropTarget={dropTarget} />

      {marquee && <div className="marquee" style={marquee} />}
      {drawPreview && <div className="draw-preview" style={drawPreview} />}
    </div>
  );
}

function resolveContainer(id: NodeId): NodeId {
  let node = getNodeById(id);
  while (node && (node.type === 'text' || node.type === 'image' || node.type === 'vector')) {
    node = getNodeById(node.parent ?? undefined);
  }
  return node?.id ?? id;
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
