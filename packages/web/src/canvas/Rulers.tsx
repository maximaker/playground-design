/**
 * Rulers along the top and left edges, in canvas pixels.
 *
 * Canvas pixels, not screen pixels: the number beside a tick is the coordinate a
 * node would have there, whatever the zoom. That is the only reading that is
 * useful — a ruler that measured the screen would tell you about your monitor.
 *
 * Drawn on a canvas element rather than as DOM ticks. At 20% zoom a 1px tick
 * every 10 canvas pixels across a wide window is several thousand elements,
 * recreated on every pan; the same thing painted once per frame costs nothing.
 */

import { useEffect, useRef } from 'react';
import { useCanvas } from '../state/store.ts';

/** Thickness of each ruler, in CSS pixels. Mirrored by --ruler-size in the CSS. */
export const RULER_SIZE = 20;

/**
 * The tick interval, in canvas pixels, that lands somewhere near every 80
 * screen pixels — so labels stay legible and never collide, at any zoom.
 */
function tickStep(zoom: number): number {
  const target = 80 / zoom;
  const magnitude = 10 ** Math.floor(Math.log10(target));
  for (const multiple of [1, 2, 5, 10]) {
    if (magnitude * multiple >= target) return magnitude * multiple;
  }
  return magnitude * 10;
}

interface Props {
  /** Canvas-space origin of the world layer, so ruler zero matches node zero. */
  origin: { x: number; y: number };
  /** Pointer position in canvas space, or null when the pointer is elsewhere. */
  pointer: { x: number; y: number } | null;
  /** The selection's bounding box in canvas space, highlighted on both rulers. */
  highlight: { x: number; y: number; width: number; height: number } | null;
}

export function Rulers({ origin, pointer, highlight }: Props) {
  const viewport = useCanvas((s) => s.viewport);
  const top = useRef<HTMLCanvasElement | null>(null);
  const left = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const draw = () => {
      for (const [ref, axis] of [[top, 'x'], [left, 'y']] as const) {
        const el = ref.current;
        if (!el) continue;
        const parent = el.parentElement;
        if (!parent) continue;

        // Backing store in device pixels, so the hairlines stay hairlines on a
        // retina screen instead of blurring across two.
        const dpr = window.devicePixelRatio || 1;
        const length = axis === 'x' ? parent.clientWidth : parent.clientHeight;
        const w = axis === 'x' ? length : RULER_SIZE;
        const h = axis === 'x' ? RULER_SIZE : length;
        if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
          el.width = Math.round(w * dpr);
          el.height = Math.round(h * dpr);
        }
        el.style.width = `${w}px`;
        el.style.height = `${h}px`;

        const ctx = el.getContext('2d');
        if (!ctx) continue;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);

        const style = getComputedStyle(el);
        const fg = style.getPropertyValue('--ruler-fg').trim() || '#888';
        const line = style.getPropertyValue('--ruler-line').trim() || '#ccc';
        const accent = style.getPropertyValue('--ruler-accent').trim() || '#6b5cff';

        // Screen position of canvas coordinate 0 along this axis.
        const zero = (axis === 'x' ? viewport.x - origin.x : viewport.y - origin.y);
        const step = tickStep(viewport.zoom);
        const toScreen = (value: number) => zero + value * viewport.zoom;
        const first = Math.floor(-zero / viewport.zoom / step) * step;
        const last = first + (length / viewport.zoom) + step;

        // The selection band first, so ticks and labels read on top of it.
        if (highlight) {
          const from = axis === 'x' ? highlight.x : highlight.y;
          const size = axis === 'x' ? highlight.width : highlight.height;
          ctx.fillStyle = accent;
          ctx.globalAlpha = 0.16;
          if (axis === 'x') ctx.fillRect(toScreen(from), 0, size * viewport.zoom, h);
          else ctx.fillRect(0, toScreen(from), w, size * viewport.zoom);
          ctx.globalAlpha = 1;
        }

        ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillStyle = fg;
        ctx.strokeStyle = line;
        ctx.lineWidth = 1;
        ctx.textBaseline = 'alphabetic';

        ctx.beginPath();
        for (let value = first; value <= last; value += step) {
          const at = Math.round(toScreen(value)) + 0.5;
          if (at < -40 || at > length + 40) continue;
          // Minor ticks between labels give a sense of scale without numbers.
          for (let m = 1; m < 5; m++) {
            const minor = Math.round(toScreen(value + (step * m) / 5)) + 0.5;
            if (axis === 'x') { ctx.moveTo(minor, RULER_SIZE - 4); ctx.lineTo(minor, RULER_SIZE); }
            else { ctx.moveTo(RULER_SIZE - 4, minor); ctx.lineTo(RULER_SIZE, minor); }
          }
          if (axis === 'x') { ctx.moveTo(at, RULER_SIZE - 8); ctx.lineTo(at, RULER_SIZE); }
          else { ctx.moveTo(RULER_SIZE - 8, at); ctx.lineTo(RULER_SIZE, at); }

          const label = String(Math.round(value));
          if (axis === 'x') {
            ctx.fillText(label, at + 3, 9);
          } else {
            // Rotated rather than stacked: a vertical column of digits is
            // unreadable, and every tool draws this label sideways.
            ctx.save();
            ctx.translate(9, at - 3);
            ctx.rotate(-Math.PI / 2);
            ctx.fillText(label, 0, 0);
            ctx.restore();
          }
        }
        ctx.stroke();

        if (pointer) {
          const at = Math.round(toScreen(axis === 'x' ? pointer.x : pointer.y)) + 0.5;
          ctx.strokeStyle = accent;
          ctx.beginPath();
          if (axis === 'x') { ctx.moveTo(at, 0); ctx.lineTo(at, RULER_SIZE); }
          else { ctx.moveTo(0, at); ctx.lineTo(RULER_SIZE, at); }
          ctx.stroke();
        }
      }
    };

    draw();
    // The rulers span the stage, so they have to be repainted when it resizes.
    const observer = new ResizeObserver(draw);
    if (top.current?.parentElement) observer.observe(top.current.parentElement);
    return () => observer.disconnect();
  }, [viewport.x, viewport.y, viewport.zoom, origin.x, origin.y, pointer, highlight]);

  return (
    <div className="rulers" aria-hidden>
      <canvas className="ruler ruler-top" ref={top} />
      <canvas className="ruler ruler-left" ref={left} />
      <div className="ruler-corner" />
    </div>
  );
}
