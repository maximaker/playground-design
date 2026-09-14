/** The tool palette. Keyboard-first: every tool has a single-key shortcut. */

import { useCanvas, type Tool } from '../state/store.ts';

const TOOLS: { tool: Tool; label: string; key: string; title: string }[] = [
  { tool: 'move', label: '⬉', key: 'V', title: 'Move' },
  { tool: 'hand', label: '✋', key: 'H', title: 'Pan' },
  { tool: 'frame', label: '▣', key: 'F', title: 'Frame' },
  { tool: 'text', label: 'T', key: 'T', title: 'Text' },
  { tool: 'rect', label: '◼', key: 'R', title: 'Rectangle' },
  { tool: 'ellipse', label: '⬤', key: 'O', title: 'Ellipse' },
  { tool: 'image', label: '🖼', key: 'I', title: 'Image' },
  { tool: 'note', label: '🗒', key: 'N', title: 'Prompt card — leave a note or ask an agent' },
];

export function Toolbar() {
  const tool = useCanvas((s) => s.tool);
  const setTool = useCanvas((s) => s.setTool);
  const zoom = useCanvas((s) => s.viewport.zoom);
  const setViewport = useCanvas((s) => s.setViewport);

  return (
    <div className="toolbar">
      {TOOLS.map((t) => (
        <button
          key={t.tool}
          className={tool === t.tool ? 'is-active' : ''}
          title={`${t.title} (${t.key})`}
          onClick={() => setTool(t.tool)}
        >
          <span aria-hidden>{t.label}</span>
        </button>
      ))}
      <span className="toolbar-divider" />
      <button title="Zoom out" onClick={() => setViewport({ zoom: Math.max(0.02, zoom / 1.25) })}>−</button>
      <button className="zoom-readout" title="Reset zoom" onClick={() => setViewport({ zoom: 1 })}>
        {Math.round(zoom * 100)}%
      </button>
      <button title="Zoom in" onClick={() => setViewport({ zoom: Math.min(8, zoom * 1.25) })}>+</button>
    </div>
  );
}
