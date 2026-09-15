/** The tool palette. Keyboard-first: every tool has a single-key shortcut. */

import { useCanvas, type Tool } from '../state/store.ts';
import { Icon, type IconName } from './Icon.tsx';
import { zoomBy, zoomTo } from '../hooks/commands.ts';

const TOOLS: { tool: Tool; icon: IconName; key: string; title: string }[] = [
  { tool: 'move', icon: 'cursor', key: 'V', title: 'Move' },
  { tool: 'hand', icon: 'hand', key: 'H', title: 'Pan' },
  { tool: 'frame', icon: 'frame', key: 'F', title: 'Frame' },
  { tool: 'text', icon: 'text', key: 'T', title: 'Text' },
  { tool: 'rect', icon: 'square', key: 'R', title: 'Rectangle' },
  { tool: 'ellipse', icon: 'circle', key: 'O', title: 'Ellipse' },
  { tool: 'image', icon: 'image', key: 'I', title: 'Image' },
  { tool: 'note', icon: 'note', key: 'N', title: 'Prompt card — leave a note or ask an agent' },
  { tool: 'comment', icon: 'comment', key: 'C', title: 'Comment — say something about the design' },
];

export function Toolbar({ compact }: { compact?: boolean }) {
  const tool = useCanvas((s) => s.tool);
  const readOnly = useCanvas((s) => s.readOnly);
  const setTool = useCanvas((s) => s.setTool);
  const zoom = useCanvas((s) => s.viewport.zoom);
  const undo = useCanvas((s) => s.undo);
  const redo = useCanvas((s) => s.redo);
  const canUndo = useCanvas((s) => s.undoStack.length > 0);
  const canRedo = useCanvas((s) => s.redoStack.length > 0);

  // On a phone, eight 40px tap targets plus a zoom control do not fit the
  // width. The tools keep their size — shrinking them below a fingertip would
  // be the wrong trade — and zoom moves to its own pill.
  return (
    <>
    <div className={`toolbar${compact ? ' is-compact' : ''}`}>
      {/* A viewer can move around and look; the drawing tools would only ever
          produce a refusal, so they are not offered. */}
      {/* A viewer can move around, look, and comment — commenting is the whole
          reason a review link exists. The rest would only ever be refused. */}
      {/*
        * Undo and redo live with the tools rather than up in the topbar corner.
        * They belong to the canvas: they undo what the canvas just did, the eye
        * is already here while working, and the corner they were in is the
        * furthest point on the screen from where the work happens.
        */}
      {!readOnly && !compact && (
        <>
          <button
            className="tip is-top" data-tip="Undo  ⌘Z"
            aria-label="Undo"
            disabled={!canUndo}
            onClick={() => undo()}
          ><Icon name="undo" size={16} /></button>
          <button
            className="tip is-top" data-tip="Redo  ⌘⇧Z"
            aria-label="Redo"
            disabled={!canRedo}
            onClick={() => redo()}
          ><Icon name="redo" size={16} /></button>
          <span className="toolbar-divider" />
        </>
      )}

      {TOOLS.filter((t) => !readOnly || ['move', 'hand', 'comment'].includes(t.tool)).map((t) => (
        <button
          key={t.tool}
          className={`tip is-top${tool === t.tool ? ' is-active' : ''}`}
          data-tip={`${t.title}  ${t.key}`}
          onClick={() => setTool(t.tool)}
          aria-label={t.title}
          aria-pressed={tool === t.tool}
        >
          <Icon name={t.icon} size={16} />
        </button>
      ))}
      {!compact && <span className="toolbar-divider" />}
      {!compact && (
      <button className="tip is-top" data-tip="Zoom out" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.25)}>
        <Icon name="minus" size={16} />
      </button>
      )}
      {!compact && (
        <button className="zoom-readout tip is-top" data-tip="Reset zoom  ⌘0" onClick={() => zoomTo(1)}>
          {Math.round(zoom * 100)}%
        </button>
      )}
      {!compact && (
      <button className="tip is-top" data-tip="Zoom in" aria-label="Zoom in" onClick={() => zoomBy(1.25)}>
        <Icon name="plus" size={16} />
      </button>
      )}
    </div>

    {compact && (
      <button
        className="zoom-pill"
        title="Reset zoom to 100%"
        aria-label={`Zoom ${Math.round(zoom * 100)} percent. Tap to reset.`}
        onClick={() => zoomTo(1)}
      >{Math.round(zoom * 100)}%</button>
    )}
    </>
  );
}
