/**
 * Setting up an artboard's iframe document.
 *
 * Every surface that renders an artboard for real — the canvas, and now the
 * presentation view — needs the same four things: a document written from
 * scratch, the reset, the artboard's own stylesheet in the head, and the web
 * fonts it asks for. Only the canvas wants the frame in the hit-testing
 * registry, so that is a flag rather than a second copy of all of this.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { NodeId } from '@playground/shared';
import { useCanvas, getDoc } from '../state/store.ts';
import { registerFrame } from './registry.ts';
import { artboardStylesheet, fontFamilies, googleFontsHref } from './styles.ts';

export const RESET = `
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; width: 100%; height: 100%; }
body { overflow: hidden; }
/* Editing chrome must not shift layout, so it is drawn with outlines only. */
[data-node-id] { outline-offset: -1px; }
[contenteditable] { outline: 2px solid #3b82f6; outline-offset: 1px; }
`;

export function useArtboardFrame(id: NodeId, live: boolean, opts: { register?: boolean } = {}) {
  const register = opts.register ?? true;
  const structureVersion = useCanvas((s) => s.structureVersion);
  const styleEpoch = useCanvas((s) => s.styleEpoch);

  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [body, setBody] = useState<HTMLElement | null>(null);
  const doc = getDoc();

  const stylesheet = useMemo(
    () => (doc ? artboardStylesheet(doc, id) : ''),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, id, structureVersion, styleEpoch],
  );
  const fontsHref = useMemo(
    () => (doc ? googleFontsHref(fontFamilies(doc, id)) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, id, structureVersion, styleEpoch],
  );

  // `live` is a dependency because an artboard that scrolls out of view unmounts
  // its iframe and mounts a brand new one when it comes back. Keyed to `id`
  // alone, this effect did not re-run for that second frame: the portal kept
  // writing into the body of the document that had just been thrown away, and
  // the artboard stayed blank for the rest of the session.
  useEffect(() => {
    const frame = frameRef.current;
    if (!live || !frame) { setBody(null); return; }
    if (register) registerFrame(id, frame);

    const init = () => {
      const d = frame.contentDocument;
      if (!d) return;
      if (!d.getElementById('canvas-reset')) {
        d.open();
        d.write('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
        d.close();
        const reset = d.createElement('style');
        reset.id = 'canvas-reset';
        reset.textContent = RESET;
        d.head.appendChild(reset);
        const variants = d.createElement('style');
        variants.id = 'canvas-variants';
        d.head.appendChild(variants);
      }
      setBody(d.body);
    };

    init();
    frame.addEventListener('load', init);
    return () => {
      frame.removeEventListener('load', init);
      if (register) registerFrame(id, null);
    };
  }, [id, live, register]);

  useEffect(() => {
    const d = frameRef.current?.contentDocument;
    if (!d) return;
    const el = d.getElementById('canvas-variants');
    if (el) el.textContent = stylesheet;
  }, [stylesheet, body]);

  useEffect(() => {
    const d = frameRef.current?.contentDocument;
    if (!d || !fontsHref) return;
    let link = d.getElementById('canvas-fonts') as HTMLLinkElement | null;
    if (!link) {
      link = d.createElement('link');
      link.id = 'canvas-fonts';
      link.rel = 'stylesheet';
      d.head.appendChild(link);
    }
    if (link.href !== fontsHref) link.href = fontsHref;
  }, [fontsHref, body]);

  return { frameRef, body };
}
