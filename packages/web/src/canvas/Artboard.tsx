/**
 * One artboard, rendered into its own same-origin iframe.
 *
 * The iframe is not decoration. It gives each artboard a real viewport, so
 * `@media (max-width: 768px)` inside a 390px artboard resolves the way it will
 * in a browser, and it isolates artboard CSS from the editor's own chrome.
 */

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { NodeId } from '@playground/shared';
import { getArtboardPosition, getArtboardSize } from '@playground/shared';
import { useCanvas, getDoc, getNodeById } from '../state/store.ts';
import { registerFrame } from './registry.ts';
import { NodeView } from './NodeView.tsx';
import { artboardStylesheet, fontFamilies, googleFontsHref } from './styles.ts';

const RESET = `
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; width: 100%; height: 100%; }
body { overflow: hidden; }
/* Editing chrome must not shift layout, so it is drawn with outlines only. */
[data-node-id] { outline-offset: -1px; }
[contenteditable] { outline: 2px solid #3b82f6; outline-offset: 1px; }
`;

interface Props {
  id: NodeId;
  /**
   * Whether this artboard is near enough the viewport to render for real.
   * Offscreen artboards keep their footprint and label but drop their iframe.
   */
  live: boolean;
}

export const Artboard = memo(function Artboard({ id, live }: Props) {
  // Narrow subscriptions: an artboard only needs to re-render for its own
  // node, structural changes, and the things that change its stylesheet.
  const nodeVersion = useCanvas((s) => s.nodeVersions[id] ?? 0);
  const structureVersion = useCanvas((s) => s.structureVersion);
  const styleEpoch = useCanvas((s) => s.styleEpoch);
  const zoom = useCanvas((s) => s.viewport.zoom);
  const agentActivity = useCanvas((s) => s.agentActivity);
  const selection = useCanvas((s) => s.selection);
  const dispatch = useCanvas((s) => s.dispatch);

  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [body, setBody] = useState<HTMLElement | null>(null);

  const node = getNodeById(id);
  const doc = getDoc();

  const { x, y } = node ? getArtboardPosition(node) : { x: 0, y: 0 };
  const { width, height } = node ? getArtboardSize(node) : { width: 0, height: 0 };

  // Both walk the artboard's entire subtree, so they must not be keyed to a
  // counter that changes on every edit.
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

  // Set up the iframe document once it exists, then portal the node tree in.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) { setBody(null); return; }
    registerFrame(id, frame);

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
      registerFrame(id, null);
    };
  }, [id]);

  // Variants and fonts go in the iframe head, outside the React tree.
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

  void nodeVersion;
  if (!node) return null;

  const isSelected = selection.includes(id);
  const agentWorking = agentActivity?.active && agentActivity.artboards.includes(id);
  // Labels are unreadable far out, and adjacent artboards' labels overlap into
  // an unreadable run of text. Below this zoom they are noise.
  const showLabel = zoom > 0.12;

  const rename = (name: string) => {
    if (name.trim() && name !== node.name) dispatch([{ t: 'rename', updates: [{ id, name: name.trim() }] }]);
  };

  return (
    <div
      className="artboard"
      style={{
        position: 'absolute',
        left: x * zoom,
        top: y * zoom,
        width: width * zoom,
        height: height * zoom,
      }}
      data-artboard-id={id}
    >
      {showLabel && (
      <div
        className="artboard-label"
        // The canvas handles pointerdown here (see `data-artboard-label`) so the
        // label is a drag handle for the whole artboard, the way it is in every
        // other design tool.
        data-artboard-label={id}
        style={{
          maxWidth: Math.max(80, width * zoom),
          color: isSelected ? 'var(--accent)' : undefined,
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          const el = e.currentTarget;
          el.contentEditable = 'true';
          el.focus();
          const range = document.createRange();
          range.selectNodeContents(el);
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
        }}
        onBlur={(e) => {
          e.currentTarget.contentEditable = 'false';
          rename(e.currentTarget.textContent?.replace(/\s*\d+\s*×\s*\d+\s*$/, '') ?? '');
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
          e.stopPropagation();
        }}
        suppressContentEditableWarning
      >
        <span className="artboard-name">{node.name}</span>
        <span className="artboard-size">{Math.round(width)} × {Math.round(height)}</span>
      </div>
      )}

      {agentWorking && (
        <div className="artboard-agent-badge" title={agentActivity?.summary ?? undefined}>
          <span className="pulse" /> {agentActivity?.agent} working
        </div>
      )}

      <div
        className={`artboard-frame${isSelected ? ' is-selected' : ''}${agentWorking ? ' is-agent-working' : ''}`}
        style={{
          width,
          height,
          transform: `scale(${zoom})`,
          transformOrigin: 'top left',
        }}
      >
        {live ? (
          <>
            <iframe
              ref={frameRef}
              title={node.name}
              width={width}
              height={height}
              // The iframe holds only document content, never third-party pages,
              // and must stay same-origin so the editor can measure and hit-test it.
              sandbox="allow-same-origin"
              scrolling="no"
              style={{ border: 0, display: 'block', width, height, background: '#fff' }}
            />
            {body && createPortal(<NodeView id={id} isRoot />, body)}
          </>
        ) : (
          <div
            className="artboard-placeholder"
            style={{ width, height, background: node.styles['background-color'] ?? '#fff' }}
          />
        )}
      </div>
    </div>
  );
});
