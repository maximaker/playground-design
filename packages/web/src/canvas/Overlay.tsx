/**
 * Selection chrome drawn above the artboard iframes.
 *
 * Geometry comes from the real DOM every frame rather than from the document's
 * style values, because the whole point of rendering in a browser is that the
 * layout engine decides the final box — a hugging frame or a wrapped line has
 * no width in the document at all.
 */

import { memo, useEffect, useRef, useState } from 'react';
import type { NodeId } from '@canvas/shared';
import { useCanvas, getNodeById } from '../state/store.ts';
import { allFrames, nodeRect } from './registry.ts';
import { HANDLES, type DropTarget } from './interactions.ts';

interface Rects { selection: Record<NodeId, DOMRect>; hovered: DOMRect | null; peers: { color: string; rect: DOMRect }[] }

export const Overlay = memo(function Overlay({ version, dropTarget }: { version: number; dropTarget: DropTarget | null }) {
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
