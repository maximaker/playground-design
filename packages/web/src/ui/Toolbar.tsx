/** The tool palette. Keyboard-first: every tool has a single-key shortcut. */

import { useCanvas, type Tool } from '../state/store.ts';
import { Icon, type IconName } from './Icon.tsx';

const TOOLS: { tool: Tool; icon: IconName; key: string; title: string }[] = [
  { tool: 'move', icon: 'cursor', key: 'V', title: 'Move' },
  { tool: 'hand', icon: 'hand', key: 'H', title: 'Pan' },
  { tool: 'frame', icon: 'frame', key: 'F', title: 'Frame' },
  { tool: 'text', icon: 'text', key: 'T', title: 'Text' },
  { tool: 'rect', icon: 'square', key: 'R', title: 'Rectangle' },
  { tool: 'ellipse', icon: 'circle', key: 'O', title: 'Ellipse' },
  { tool: 'image', icon: 'image', key: 'I', title: 'Image' },
  { tool: 'note', icon: 'note', key: 'N', title: 'Prompt card — leave a note or ask an agent' },
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
          aria-label={t.title}
          aria-pressed={tool === t.tool}
        >
          <Icon name={t.icon} size={16} />
        </button>
      ))}
      <span className="toolbar-divider" />
      <button title="Zoom out" aria-label="Zoom out" onClick={() => setViewport({ zoom: Math.max(0.02, zoom / 1.25) })}>
        <Icon name="minus" size={16} />
      </button>
      <button className="zoom-readout" title="Reset zoom" onClick={() => setViewport({ zoom: 1 })}>
        {Math.round(zoom * 100)}%
      </button>
      <button title="Zoom in" aria-label="Zoom in" onClick={() => setViewport({ zoom: Math.min(8, zoom * 1.25) })}>
        <Icon name="plus" size={16} />
      </button>
    </div>
  );
}
