/**
 * Other people's pointers.
 *
 * Positions arrive in world coordinates, because everyone is at a different
 * zoom and scroll position — a screen point from one tab lands somewhere else
 * entirely in another, which is the bug that makes remote cursors feel broken
 * rather than absent.
 *
 * The movement between updates is done by CSS rather than by interpolating in
 * JavaScript: twenty positions a second plus a short transition reads as smooth,
 * and it costs nothing on the main thread. A cursor that stops updating is
 * dropped rather than left parked on the design forever.
 */

import { memo, useEffect, useState } from 'react';
import { useCanvas } from '../state/store.ts';

/** How long a silent cursor stays on screen before it is assumed gone. */
const STALE_MS = 12_000;

export const PeerCursors = memo(function PeerCursors() {
  const peerCursors = useCanvas((s) => s.peerCursors);
  const viewport = useCanvas((s) => s.viewport);
  const pageId = useCanvas((s) => s.pageId);

  // Last time each peer's position actually moved, so a tab left open in the
  // background does not leave a cursor sitting on the canvas indefinitely.
  const [seen, setSeen] = useState<Record<string, { x: number; y: number; at: number }>>({});
  const [, tick] = useState(0);

  useEffect(() => {
    setSeen((prev) => {
      const next = { ...prev };
      for (const p of peerCursors) {
        if (!p.cursor) { delete next[p.clientId]; continue; }
        const was = prev[p.clientId];
        next[p.clientId] = was && was.x === p.cursor.x && was.y === p.cursor.y
          ? was
          : { ...p.cursor, at: Date.now() };
      }
      for (const id of Object.keys(next)) {
        if (!peerCursors.some((p) => p.clientId === id)) delete next[id];
      }
      return next;
    });
  }, [peerCursors]);

  // Re-render occasionally so a cursor that went quiet actually disappears;
  // nothing else would prompt it, since no message arrives.
  useEffect(() => {
    const timer = window.setInterval(() => tick((n) => n + 1), 2000);
    return () => window.clearInterval(timer);
  }, []);

  const now = Date.now();

  return (
    <>
      {peerCursors.map((peer) => {
        const last = seen[peer.clientId];
        if (!peer.cursor || !last || now - last.at > STALE_MS) return null;
        // Someone looking at a different page is present but not here.
        if (peer.pageId && pageId && peer.pageId !== pageId) return null;

        return (
          <div
            key={peer.clientId}
            className="peer-cursor"
            style={{
              // world → client: the same transform the artboards use.
              transform: `translate(${viewport.x + peer.cursor.x * viewport.zoom}px, ${viewport.y + peer.cursor.y * viewport.zoom}px)`,
              color: peer.color,
            }}
          >
            <svg width="16" height="19" viewBox="0 0 16 19" aria-hidden>
              <path
                d="M1 1l12.2 6.4-5.6 1.3-2.4 5.3z"
                fill="currentColor"
                stroke="#fff"
                strokeWidth="1.2"
                strokeLinejoin="round"
              />
            </svg>
            <span className="peer-cursor-name" style={{ background: peer.color }}>{peer.name}</span>
          </div>
        );
      })}
    </>
  );
});
