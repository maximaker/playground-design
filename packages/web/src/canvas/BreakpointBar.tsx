/**
 * Breakpoint ruler for the selected artboard.
 *
 * An artboard is a real viewport, so this is not a preview mode: clicking a
 * breakpoint sets the artboard's width, the browser re-resolves the media
 * queries, and what reflows on screen is what will reflow in production. That
 * is the thing an HTML-native canvas can do that a vector tool cannot.
 */

import { memo } from 'react';
import {
  type Breakpoint, type NodeId,
  activeBreakpoints, breakpointsOf, getArtboardSize,
} from '@playground/shared';
import { useCanvas, getDoc, getNodeById } from '../state/store.ts';
import { Icon } from '../ui/Icon.tsx';

interface Props { artboardId: NodeId }

export const BreakpointBar = memo(function BreakpointBar({ artboardId }: Props) {
  useCanvas((s) => s.nodeVersions[artboardId] ?? 0);
  useCanvas((s) => s.structureVersion);
  const zoom = useCanvas((s) => s.viewport.zoom);
  const dispatch = useCanvas((s) => s.dispatch);

  const doc = getDoc();
  const node = getNodeById(artboardId);
  if (!doc || !node || node.type !== 'artboard') return null;

  const { width } = getArtboardSize(node);
  const breakpoints = breakpointsOf(doc);
  const active = activeBreakpoints(doc, width);
  // The narrowest matching breakpoint is the one whose rules win.
  const current = active[0];

  const setWidth = (px: number) => {
    dispatch([{ t: 'styles', updates: [{ id: artboardId, styles: { width: `${Math.round(px)}px` } }] }]);
  };

  // Hidden when zoomed far out, where the ticks would overlap into noise.
  if (zoom < 0.2) return null;

  return (
    <div className="breakpoint-bar" style={{ width: width * zoom }}>
      {breakpoints.map((bp) => {
        const isActive = current?.id === bp.id;
        const applies = width <= bp.maxWidth;
        return (
          <button
            key={bp.id}
            className={`bp-tick${isActive ? ' is-current' : ''}${applies ? ' is-applying' : ''}`}
            title={`${bp.name} — ${bp.maxWidth}px and below${isActive ? ' (active)' : ''}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setWidth(bp.maxWidth)}
          >
            {bp.name}
          </button>
        );
      })}

      <span className="bp-spacer" />

      <span className="bp-width" title="Artboard width">
        {Math.round(width)}px
        {current ? <em>{current.name}</em> : <em>base</em>}
      </span>

      <button
        className="bp-tick bp-add"
        title="Add a breakpoint at this width"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => addBreakpointAt(Math.round(width))}
      ><Icon name="plus" size={11} /></button>
    </div>
  );
});

function addBreakpointAt(width: number): void {
  const doc = getDoc();
  const { dispatch, toast } = useCanvas.getState();
  if (!doc) return;

  const existing = breakpointsOf(doc);
  if (existing.some((b) => b.maxWidth === width)) {
    toast(`There is already a breakpoint at ${width}px.`, 'info');
    return;
  }
  const name = window.prompt(`Name this breakpoint (applies at ${width}px and below)`, suggestName(existing, width));
  if (!name?.trim()) return;

  const next: Breakpoint = { id: `bp_${Math.random().toString(36).slice(2, 8)}`, name: name.trim(), maxWidth: width };
  dispatch([{ t: 'breakpoints', breakpoints: [...existing, next] }]);
  toast(`Added "${next.name}" at ${width}px.`, 'success');
}

function suggestName(existing: Breakpoint[], width: number): string {
  if (width <= 480) return 'xs';
  if (width <= 700) return 'sm';
  if (width <= 900) return 'md';
  if (width <= 1200) return 'lg';
  return `w${width}`;
}
