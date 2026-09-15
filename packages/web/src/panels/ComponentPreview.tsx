/**
 * A picture of a component, and the bigger one you get on hover.
 *
 * The panel is a 300px rail, so a tile is about 130px across — enough to tell a
 * button from a card, not enough to read one. The overlay is the answer: point
 * at a tile and the real thing appears beside the rail at a size you can
 * actually judge.
 *
 * Both come from the server's renderer, cached against a hash of the component
 * itself, so editing one component re-renders one picture and editing anything
 * else re-renders nothing.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/** How long the pointer must rest before the overlay appears. */
const HOVER_DELAY_MS = 220;

interface Props {
  docId: string | null;
  componentId: string;
  name: string;
  /** Changes when the component changes, so the browser re-fetches. */
  stamp: string | number;
}

export function ComponentPreview({ docId, componentId, name, stamp }: Props) {
  const [failed, setFailed] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  /** The panel to get out of the way of, measured when the overlay opens. */
  const [avoid, setAvoid] = useState<DOMRect | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const ref = useRef<HTMLSpanElement | null>(null);

  // A share-link viewer has no document id to ask with; the tile falls back to
  // the initial rather than firing a request that cannot work.
  const src = docId
    ? `/api/documents/${docId}/components/${componentId}/preview?v=${stamp}`
    : null;

  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => { setFailed(false); }, [src]);

  const open = () => {
    window.clearTimeout(timer.current);
    // Start fetching the large render immediately and open the overlay after
    // the delay: by the time it appears the picture is usually already there,
    // and the delay stops a pointer crossing the grid from firing five renders.
    if (src) { const warm = new Image(); warm.src = `${src}&size=lg`; }
    timer.current = window.setTimeout(() => {
      setAnchor(ref.current?.getBoundingClientRect() ?? null);
      setAvoid(ref.current?.closest('.rail')?.getBoundingClientRect() ?? null);
      setHovering(true);
    }, HOVER_DELAY_MS);
  };
  const close = () => {
    window.clearTimeout(timer.current);
    setHovering(false);
  };

  return (
    <span
      className="component-preview"
      ref={ref}
      onPointerEnter={open}
      onPointerLeave={close}
      // Keyboard users get it too: the tile is inside a button, so focus is the
      // equivalent gesture.
      onFocus={open}
      onBlur={close}
    >
      {src && !failed ? (
        <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
      ) : (
        <span className="component-preview-fallback" aria-hidden>
          {(name.trim()[0] ?? '?').toUpperCase()}
        </span>
      )}
      {hovering && src && !failed && anchor && (
        <PreviewOverlay
          src={`${src}&size=lg`}
          name={name}
          anchor={anchor}
          avoid={avoid}
        />
      )}
    </span>
  );
}

/**
 * The large preview.
 *
 * In a portal on `document.body`: the rail scrolls and clips its contents, so
 * an overlay rendered inside it would be cut off by the panel it is trying to
 * escape. Fixed positioning then needs the anchor's viewport rect, which is
 * measured at the moment it opens.
 */
function PreviewOverlay(
  { src, name, anchor, avoid }:
  { src: string; name: string; anchor: DOMRect; avoid: DOMRect | null },
) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [placed, setPlaced] = useState<{ left: number; top: number } | null>(null);
  /**
   * Nothing is shown until the picture is in.
   *
   * Placed before the image arrives, the overlay is a 20px box in the wrong
   * corner that then jumps — which is exactly what it looked like.
   */
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () => {
      const box = el.getBoundingClientRect();
      const gap = 12;
      // Clear of the whole panel, not just the tile: anchored to the tile it
      // opened halfway across the rail, covering the other components.
      const from = avoid ?? anchor;
      let left = from.right + gap;
      if (left + box.width > window.innerWidth - gap) left = from.left - box.width - gap;
      if (left < gap) left = Math.max(gap, (window.innerWidth - box.width) / 2);
      // Vertically centred on the tile, then pulled back inside the window.
      let top = anchor.top + anchor.height / 2 - box.height / 2;
      top = Math.min(Math.max(gap, top), window.innerHeight - box.height - gap);
      setPlaced({ left, top });
    };
    const img = el.querySelector('img');
    const onLoad = () => { place(); setReady(true); };
    if (img?.complete && img.naturalWidth > 0) onLoad();
    else img?.addEventListener('load', onLoad, { once: true });
    // A render that fails or takes too long should not leave a hole where the
    // overlay was promised, so it is shown anyway after a moment.
    const fallback = window.setTimeout(onLoad, 1200);
    return () => {
      window.clearTimeout(fallback);
      img?.removeEventListener('load', onLoad);
    };
  }, [anchor, avoid, src]);

  return createPortal(
    <div
      className="component-overlay"
      ref={ref}
      role="tooltip"
      style={placed && ready
        ? { left: placed.left, top: placed.top }
        : { opacity: 0, left: placed?.left ?? 0, top: placed?.top ?? 0 }}
    >
      <img src={src} alt={`${name} preview`} />
      <span className="component-overlay-name">{name}</span>
    </div>,
    document.body,
  );
}
