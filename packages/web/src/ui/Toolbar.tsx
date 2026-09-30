/**
 * The tool palette. Keyboard-first: every tool has a single-key shortcut.
 *
 * Twelve tools in a row was a bar as wide as the canvas under it. They are six
 * groups now, the way Figma's toolbar is: each group shows the tool last used
 * from it, and the others are one hover away. Shortcuts are unchanged — a key
 * picks its tool wherever it lives, and that tool becomes its group's face.
 */

import { useEffect, useRef, useState } from 'react';
import { useCanvas, type Tool } from '../state/store.ts';
import { Icon } from './Icon.tsx';
import { MOD, TOOLS } from './tools.ts';
import { zoomBy, zoomTo } from '../hooks/commands.ts';

const GROUPS: { id: string; label: string; tools: Tool[] }[] = [
  { id: 'move', label: 'Move and pan', tools: ['move', 'hand'] },
  { id: 'frame', label: 'Frame and section', tools: ['frame', 'section'] },
  { id: 'shape', label: 'Shapes', tools: ['rect', 'ellipse', 'diamond', 'image'] },
  { id: 'text', label: 'Text', tools: ['text'] },
  { id: 'connector', label: 'Connector', tools: ['connector'] },
  { id: 'note', label: 'Prompt cards and comments', tools: ['note', 'comment'] },
];

const FACES_KEY = 'playground:toolbar-faces';

/** Which tool each group shows, remembered per browser: a convenience, not state. */
function loadFaces(): Record<string, Tool> {
  try { return JSON.parse(localStorage.getItem(FACES_KEY) ?? '{}'); } catch { return {}; }
}

function ToolGroup({ group, faces, readOnly }: { group: (typeof GROUPS)[number]; faces: Record<string, Tool>; readOnly: boolean }) {
  const tool = useCanvas((s) => s.tool);
  const setTool = useCanvas((s) => s.setTool);
  const [open, setOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const tools = group.tools.filter((t) => !readOnly || ['move', 'hand', 'comment'].includes(t));

  // Opens after a short hover, so sweeping the pointer along the bar does not
  // pop every group open on the way past; closes a moment after leaving, so
  // the gap between the button and its menu can be crossed.
  const later = (fn: () => void, ms: number) => { window.clearTimeout(timer.current); timer.current = window.setTimeout(fn, ms); };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // After the hooks, which must run on every render whatever the group holds.
  if (!tools.length) return null;
  const face = TOOLS[tools.includes(faces[group.id]!) ? faces[group.id]! : tools[0]!];
  const active = tools.includes(tool);
  const shown = active ? TOOLS[tool] : face;
  const many = tools.length > 1;

  return (
    <div
      className={`tool-group${many ? ' has-more' : ''}${open ? ' is-open' : ''}`}
      onMouseEnter={() => many && later(() => setOpen(true), 260)}
      onMouseLeave={() => later(() => setOpen(false), 180)}
    >
      <button
        className={`tip is-top${active ? ' is-active' : ''}`}
        data-tip={open ? undefined : `${shown.title}  ${shown.key}`}
        onClick={() => { setTool(shown.tool); setOpen(false); }}
        aria-label={shown.title}
        aria-pressed={active}
      >
        <Icon name={shown.icon} size={16} />
      </button>
      {many && (
        <button
          className="tool-chevron tip is-top"
          data-tip={open ? undefined : group.label}
          aria-label={`More: ${group.label}`}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><path d="M1.5 5.2 4 2.8l2.5 2.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      )}
      {open && (
        <div className="tool-flyout" role="menu" aria-label={group.label}>
          {tools.map((t) => {
            const info = TOOLS[t];
            return (
              <button
                key={t}
                role="menuitemradio"
                aria-checked={tool === t}
                className={tool === t ? 'is-current' : undefined}
                onClick={() => { setTool(t); setOpen(false); }}
              >
                <Icon name={info.icon} size={15} />
                <span className="tool-flyout-name">{info.name}</span>
                <kbd>{info.key}</kbd>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function Toolbar({ compact }: { compact?: boolean }) {
  const tool = useCanvas((s) => s.tool);
  const readOnly = useCanvas((s) => s.readOnly);
  const setTool = useCanvas((s) => s.setTool);
  const zoom = useCanvas((s) => s.viewport.zoom);
  const undo = useCanvas((s) => s.undo);
  const redo = useCanvas((s) => s.redo);
  const canUndo = useCanvas((s) => s.undoStack.length > 0);
  const canRedo = useCanvas((s) => s.redoStack.length > 0);

  // Whichever tool was picked last — by click or by key — becomes the face of
  // its group, so the bar shows what you have been using.
  const [faces, setFaces] = useState<Record<string, Tool>>(loadFaces);
  useEffect(() => {
    const group = GROUPS.find((g) => g.tools.includes(tool));
    if (!group || group.tools.length < 2 || faces[group.id] === tool) return;
    const next = { ...faces, [group.id]: tool };
    setFaces(next);
    try { localStorage.setItem(FACES_KEY, JSON.stringify(next)); } catch { /* a convenience */ }
  }, [tool, faces]);

  // On a phone, eight 40px tap targets plus a zoom control do not fit the
  // width. The tools keep their size — shrinking them below a fingertip would
  // be the wrong trade — and zoom moves to its own pill.
  return (
    <>
    <div className={`toolbar${compact ? ' is-compact' : ''}`}>
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
            className="tip is-top" data-tip={`Undo  ${MOD}Z`}
            aria-label="Undo"
            disabled={!canUndo}
            onClick={() => undo()}
          ><Icon name="undo" size={16} /></button>
          <button
            className="tip is-top" data-tip={`Redo  ${MOD}⇧Z`}
            aria-label="Redo"
            disabled={!canRedo}
            onClick={() => redo()}
          ><Icon name="redo" size={16} /></button>
          <span className="toolbar-divider" />
        </>
      )}

      {GROUPS.map((g) => <ToolGroup key={g.id} group={g} faces={faces} readOnly={readOnly} />)}
      {!compact && <span className="toolbar-divider" />}
      {!compact && (
      <button className="tip is-top" data-tip="Zoom out  −" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.25)}>
        <Icon name="minus" size={16} />
      </button>
      )}
      {!compact && (
        <button className="zoom-readout tip is-top" data-tip="Zoom to 100%  ⇧0" aria-label={`Zoom ${Math.round(zoom * 100)} percent. Reset to 100%.`} onClick={() => zoomTo(1)}>
          {Math.round(zoom * 100)}%
        </button>
      )}
      {!compact && (
      <button className="tip is-top" data-tip="Zoom in  +" aria-label="Zoom in" onClick={() => zoomBy(1.25)}>
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
