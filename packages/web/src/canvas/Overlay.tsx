/**
 * Selection chrome drawn above the artboard iframes.
 *
 * Geometry comes from the real DOM every frame rather than from the document's
 * style values, because the whole point of rendering in a browser is that the
 * layout engine decides the final box — a hugging frame or a wrapped line has
 * no width in the document at all.
 */

import { memo, useEffect, useRef, useState } from 'react';
import type { NodeId, SnapGuide } from '@canvas/shared';
import { useCanvas, getNodeById, getDoc } from '../state/store.ts';
import { allFrames, nodeRect, nodeInnerRect } from './registry.ts';
import { HANDLES, type DropTarget } from './interactions.ts';

interface Rects { selection: Record<NodeId, DOMRect>; hovered: DOMRect | null; peers: { color: string; rect: DOMRect }[] }

interface OverlayProps {
  version: number;
  dropTarget: DropTarget | null;
  /** Snap guides, in the working space named by `space`. */
  guides: { guides: SnapGuide[]; space: 'canvas' | NodeId } | null;
}

export const Overlay = memo(function Overlay({ version, dropTarget, guides }: OverlayProps) {
  const selection = useCanvas((s) => s.selection);
  const hovered = useCanvas((s) => s.hovered);
  const editingText = useCanvas((s) => s.editingText);
  const viewport = useCanvas((s) => s.viewport);
  const peers = useCanvas((s) => s.peers);

  const [rects, setRects] = useState<Rects>({ selection: {}, hovered: null, peers: [] });
  const raf = useRef<number>(0);

  // Re-measure on a rAF loop rather than on state changes: layout inside the
  // iframes settles asynchronously (fonts, images, reflow), so a one-shot
  // measurement after a change is routinely wrong by a frame or two.
  useEffect(() => {
    let running = true;
    const tick = () => {
      if (!running) return;
      const next: Rects = { selection: {}, hovered: null, peers: [] };
      for (const id of selection) {
        const r = nodeRect(id);
        if (r) next.selection[id] = r;
      }
      if (hovered && !selection.includes(hovered)) next.hovered = nodeRect(hovered);
      for (const peer of peers) {
        for (const id of peer.selection) {
          const r = nodeRect(id);
          if (r) next.peers.push({ color: peer.color, rect: r });
        }
      }
      setRects((prev) => (sameRects(prev, next) ? prev : next));
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => { running = false; cancelAnimationFrame(raf.current); };
  }, [selection, hovered, peers, version, viewport]);

  const measureTo = useCanvas((s) => s.measureTo);
  const single = selection.length === 1 ? selection[0]! : null;
  const singleRect = single ? rects.selection[single] : null;
  const singleNode = single ? getNodeById(single) : undefined;

  return (
    <div className="overlay">
      {rects.peers.map((p, i) => (
        <div key={`peer-${i}`} className="overlay-peer" style={boxStyle(p.rect, p.color)} />
      ))}

      {rects.hovered && <div className="overlay-hover" style={boxStyle(rects.hovered)} />}

      {Object.entries(rects.selection).map(([id, rect]) => (
        <div key={id} className="overlay-selected" style={boxStyle(rect)} />
      ))}

      {singleRect && singleNode && editingText !== single && (
        <>
          {HANDLES.map((h) => (
            <div
              key={h}
              data-handle={h}
              className={`overlay-handle handle-${h}`}
              style={handleStyle(singleRect, h)}
            />
          ))}
          <div
            className="overlay-size"
            style={{ left: singleRect.left, top: singleRect.bottom + 6 }}
          >
            {Math.round(singleRect.width)} × {Math.round(singleRect.height)}
          </div>
        </>
      )}

      {guides && <SnapGuides guides={guides.guides} space={guides.space} viewport={viewport} />}

      {measureTo && selection.length === 1 && (
        <Measurements fromId={selection[0]!} toId={measureTo} />
      )}

      {dropTarget?.indicator && (
        <div
          className="overlay-drop"
          style={
            dropTarget.indicator.horizontal
              ? { left: dropTarget.indicator.x, top: dropTarget.indicator.y - 1, width: dropTarget.indicator.length, height: 2 }
              : { left: dropTarget.indicator.x - 1, top: dropTarget.indicator.y, width: 2, height: dropTarget.indicator.length }
          }
        />
      )}
    </div>
  );
});

/**
 * Draws snap guides. Canvas-space guides (artboards) convert through the
 * viewport transform; parent-local guides convert through the parent's rendered
 * rect, which already includes the zoom.
 */
function SnapGuides({ guides, space, viewport }: {
  guides: SnapGuide[];
  space: 'canvas' | NodeId;
  viewport: { x: number; y: number; zoom: number };
}) {
  let originX = viewport.x;
  let originY = viewport.y;
  const scale = viewport.zoom;

  if (space !== 'canvas') {
    const parent = nodeRect(space);
    if (!parent) return null;
    originX = parent.left;
    originY = parent.top;
  }

  return (
    <>
      {guides.map((g, i) => {
        const pos = (g.axis === 'x' ? originX : originY) + g.position * scale;
        const from = (g.axis === 'x' ? originY : originX) + g.from * scale;
        const to = (g.axis === 'x' ? originY : originX) + g.to * scale;

        if (g.kind === 'spacing') {
          // Spacing guides mark the gap itself, along the axis, not an alignment.
          const start = (g.axis === 'x' ? originX : originY) + g.from * scale;
          const end = (g.axis === 'x' ? originX : originY) + g.to * scale;
          const cross = (g.axis === 'x' ? originY : originX) + g.from * scale;
          return (
            <div
              key={`s${i}`}
              className="guide guide-spacing"
              style={g.axis === 'x'
                ? { left: start, top: cross, width: Math.max(1, end - start), height: 2 }
                : { left: cross, top: start, width: 2, height: Math.max(1, end - start) }}
              data-label={g.label}
            />
          );
        }

        return (
          <div
            key={`g${i}`}
            className={`guide guide-${g.kind}`}
            style={g.axis === 'x'
              ? { left: pos, top: Math.min(from, to) - 20, width: 1, height: Math.abs(to - from) + 40 }
              : { left: Math.min(from, to) - 20, top: pos, width: Math.abs(to - from) + 40, height: 1 }}
          />
        );
      })}
    </>
  );
}

/**
 * Distance readouts between the selection and a hovered node — the Option-hover
 * measurement every design tool has, and the fastest way to check spacing
 * without opening a panel.
 */
function Measurements({ fromId, toId }: { fromId: NodeId; toId: NodeId }) {
  const a = nodeRect(fromId);
  const b = nodeRect(toId);
  if (!a || !b || fromId === toId) return null;

  const spans: { left: number; top: number; width: number; height: number; label: string; axis: 'x' | 'y' }[] = [];

  // Horizontal gap, measured between facing edges when the boxes do not overlap.
  const midY = Math.max(Math.min(a.top + a.height / 2, b.bottom), b.top);
  if (b.left > a.right) spans.push({ left: a.right, top: midY, width: b.left - a.right, height: 0, label: `${Math.round(b.left - a.right)}`, axis: 'x' });
  else if (a.left > b.right) spans.push({ left: b.right, top: midY, width: a.left - b.right, height: 0, label: `${Math.round(a.left - b.right)}`, axis: 'x' });

  const midX = Math.max(Math.min(a.left + a.width / 2, b.right), b.left);
  if (b.top > a.bottom) spans.push({ left: midX, top: a.bottom, width: 0, height: b.top - a.bottom, label: `${Math.round(b.top - a.bottom)}`, axis: 'y' });
  else if (a.top > b.bottom) spans.push({ left: midX, top: b.bottom, width: 0, height: a.top - b.bottom, label: `${Math.round(a.top - b.bottom)}`, axis: 'y' });

  return (
    <>
      <div className="measure-target" style={{ left: b.left, top: b.top, width: b.width, height: b.height }} />
      {spans.map((s, i) => (
        <div
          key={i}
          className={`measure measure-${s.axis}`}
          style={{ left: s.left, top: s.top, width: Math.max(s.width, 1), height: Math.max(s.height, 1) }}
        >
          <span className="measure-label">{s.label}</span>
        </div>
      ))}
    </>
  );
}

function boxStyle(rect: DOMRect, color?: string): React.CSSProperties {
  return {
    left: rect.left, top: rect.top, width: rect.width, height: rect.height,
    ...(color ? { borderColor: color } : {}),
  };
}

function handleStyle(rect: DOMRect, handle: string): React.CSSProperties {
  const x = handle.includes('w') ? rect.left : handle.includes('e') ? rect.right : rect.left + rect.width / 2;
  const y = handle.includes('n') ? rect.top : handle.includes('s') ? rect.bottom : rect.top + rect.height / 2;
  return { left: x, top: y };
}

function sameRects(a: Rects, b: Rects): boolean {
  const ak = Object.keys(a.selection);
  const bk = Object.keys(b.selection);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    const ra = a.selection[k];
    const rb = b.selection[k];
    if (!rb || !ra || !sameRect(ra, rb)) return false;
  }
  if (!!a.hovered !== !!b.hovered) return false;
  if (a.hovered && b.hovered && !sameRect(a.hovered, b.hovered)) return false;
  if (a.peers.length !== b.peers.length) return false;
  for (let i = 0; i < a.peers.length; i++) {
    if (!sameRect(a.peers[i]!.rect, b.peers[i]!.rect)) return false;
  }
  return true;
}

function sameRect(a: DOMRect, b: DOMRect): boolean {
  return Math.abs(a.left - b.left) < 0.5 && Math.abs(a.top - b.top) < 0.5
    && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;
}

/** Keeps the overlay honest when an artboard's iframe reflows on its own. */
export function useReflowWatcher(onReflow: () => void): void {
  useEffect(() => {
    const observers: ResizeObserver[] = [];
    for (const [, frame] of allFrames()) {
      const body = frame.contentDocument?.body;
      if (!body) continue;
      const ro = new ResizeObserver(onReflow);
      ro.observe(body);
      observers.push(ro);
    }
    return () => observers.forEach((o) => o.disconnect());
  }, [onReflow]);
}
