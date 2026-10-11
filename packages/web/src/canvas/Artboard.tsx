/**
 * One artboard, rendered into its own same-origin iframe.
 *
 * The iframe is not decoration. It gives each artboard a real viewport, so
 * `@media (max-width: 768px)` inside a 390px artboard resolves the way it will
 * in a browser, and it isolates artboard CSS from the editor's own chrome.
 */

import { memo, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { NodeId } from '@playground/shared';
import { descendants, getArtboardPosition, getArtboardSize } from '@playground/shared';
import { useCanvas, getDoc, getNodeById } from '../state/store.ts';
import { useArtboardFrame } from './frame.ts';
import { NodeView } from './NodeView.tsx';
import { effectiveTheme, pinnedTheme, useViewTheme } from '../state/viewTheme.ts';
import { requestThumb, useThumb } from './thumbs.ts';
import { BreakpointBar } from './BreakpointBar.tsx';

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
  const preview = useViewTheme((s) => s.theme);

  const { frameRef, body } = useArtboardFrame(id, live);

  // Whether the live frame has painted its content yet. Two frames after the
  // portal mounts: one for React to commit into it, one for it to paint.
  const [painted, setPainted] = useState(false);
  useEffect(() => {
    if (!live || !body) { setPainted(false); return; }
    let b = 0;
    const a = requestAnimationFrame(() => { b = requestAnimationFrame(() => setPainted(true)); });
    return () => { cancelAnimationFrame(a); cancelAnimationFrame(b); };
  }, [live, body]);

  const node = getNodeById(id);
  const doc = getDoc();

  // Whether to allow scripts in this frame. Keyed to the structure counter
  // rather than every edit: it only changes when a node is added or removed.
  const hasCodeComponent = useMemo(
    () => !!doc && descendants(doc, id).some((n) => doc.nodes[n]?.type === 'code'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, id, structureVersion],
  );

  const { x, y } = node ? getArtboardPosition(node) : { x: 0, y: 0 };
  const { width, height } = node ? getArtboardSize(node) : { width: 0, height: 0 };

  void nodeVersion;
  if (!node) return null;

  const isSelected = selection.includes(id);
  const agentWorking = agentActivity?.active && agentActivity.artboards.includes(id);
  // Labels are unreadable far out, and adjacent artboards' labels overlap into
  // an unreadable run of text. Below this zoom they are noise.
  const showLabel = zoom > 0.12;
  // While previewing the page in a theme, a frame that pins its own says so,
  // or it reads as the preview not working.
  const pinned = preview && doc ? pinnedTheme(doc, id) : null;

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
        {pinned && pinned !== preview && (
          <span className="artboard-theme-badge" title="This frame sets its own theme, so the preview leaves it alone">
            {pinned === 'default' ? 'Main' : pinned}
          </span>
        )}
        <span className="artboard-size">{Math.round(width)} × {Math.round(height)}</span>
      </div>
      )}

      {isSelected && <BreakpointBar artboardId={id} />}

      {agentWorking && (
        <div className="artboard-agent-badge" title={agentActivity?.summary ?? undefined}>
          <span className="pulse" /> {agentActivity?.agent} working
        </div>
      )}

      <div
        className={`artboard-frame${live ? '' : ' is-static'}${isSelected ? ' is-selected' : ''}${agentWorking ? ' is-agent-working' : ''}`}
        style={{
          width,
          height,
          transform: `scale(${zoom})`,
          transformOrigin: 'top left',
        }}
      >
        {live && (
          <>
            <iframe
              ref={frameRef}
              title={node.name}
              width={width}
              height={height}
              // The frame holds only document content, never third-party pages,
              // and must stay same-origin so the editor can measure and hit-test it.
              //
              // Scripts are off unless the artboard hosts a code component —
              // sandbox flags are inherited, so a nested frame cannot re-enable
              // what its parent forbids, and a code component is a real script.
              // Vector markup is sanitised at render either way, so turning this
              // on does not hand an imported SVG a way to run.
              sandbox={hasCodeComponent ? 'allow-same-origin allow-scripts' : 'allow-same-origin'}
              scrolling="no"
              style={{ border: 0, display: 'block', width, height, background: '#fff' }}
            />
            {body && createPortal(<NodeView id={id} isRoot />, body)}
          </>
        )}
        {/* The thumbnail stays on top of a frame that has just gone live until
            the frame has painted, so zooming in never flashes a blank page. */}
        {(!live || !painted) && (
          <StaticFrame id={id} width={width} height={height} fallback={node.styles['background-color'] ?? '#fff'} />
        )}
      </div>
    </div>
  );
});

/**
 * An artboard as a picture: the cached thumbnail, or its background colour
 * until the first one is drawn. Subscribes to edits only while it is mounted,
 * which is only while the artboard is not live.
 */
function StaticFrame({ id, width, height, fallback }: { id: NodeId; width: number; height: number; fallback: string }) {
  const version = useCanvas((s) => s.version);
  const styleEpoch = useCanvas((s) => s.styleEpoch);
  const preview = useViewTheme((s) => s.theme);
  const url = useThumb(id);

  useEffect(() => {
    // Debounced by the queue itself: a run of edits is one draw, at idle time.
    requestThumb(id, () => {
      const doc = getDoc();
      return doc?.nodes[id] ? { doc, theme: effectiveTheme(doc, id, preview) } : null;
    });
  }, [id, version, styleEpoch, preview, width, height]);

  return url ? (
    <img
      className="artboard-thumb"
      src={url}
      alt=""
      draggable={false}
      style={{ position: 'absolute', inset: 0, width, height, display: 'block' }}
    />
  ) : (
    <div className="artboard-placeholder" style={{ position: 'absolute', inset: 0, width, height, background: fallback }} />
  );
}
