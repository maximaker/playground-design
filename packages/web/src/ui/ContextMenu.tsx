/**
 * Right-click menu.
 *
 * Deliberately short: the operations people actually reach for on a selection,
 * with their real shortcuts shown so the menu teaches the keyboard.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { NodeId } from '@playground/shared';
import { emitHtml, emitJsx } from '@playground/shared';
import { useCanvas, getDoc, topLevelSelection } from '../state/store.ts';
import { reorder } from '../canvas/arrange.ts';
import { duplicateSelection, wrapInFrame } from '../hooks/commands.ts';

export interface ContextMenuState { x: number; y: number; nodeId: NodeId | null }

interface Item {
  label: string;
  shortcut?: string;
  run?: () => void;
  disabled?: boolean;
  danger?: boolean;
  separator?: boolean;
}

export function ContextMenu({ state, onClose, onExport }: {
  state: ContextMenuState;
  onClose: () => void;
  onExport: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x: state.x, y: state.y });

  const selection = useCanvas((s) => s.selection);
  const dispatch = useCanvas((s) => s.dispatch);
  const select = useCanvas((s) => s.select);
  const toast = useCanvas((s) => s.toast);
  const setEditingText = useCanvas((s) => s.setEditingText);

  // Flip the menu back on screen when it would open past an edge.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      x: Math.min(state.x, window.innerWidth - rect.width - 8),
      y: Math.min(state.y, window.innerHeight - rect.height - 8),
    });
  }, [state.x, state.y]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const doc = getDoc();
  const node = state.nodeId ? doc?.nodes[state.nodeId] : undefined;
  const ids = topLevelSelection(selection);
  const has = ids.length > 0;

  const copy = async (what: 'jsx' | 'tailwind' | 'css' | 'html') => {
    if (!doc || !ids.length) return;
    const text = ids.map((id) => {
      if (what === 'css') return emitHtml(doc, id, { mode: 'stylesheet', includeTokens: false }).css;
      if (what === 'html') return emitHtml(doc, id, { mode: 'inline', includeTokens: false }).html;
      return emitJsx(doc, id, { format: what === 'tailwind' ? 'tailwind' : 'inline' });
    }).join('\n\n');
    await navigator.clipboard.writeText(text);
    toast(`Copied ${what.toUpperCase()}`, 'success');
  };

  const items: Item[] = [
    { label: 'Copy as JSX + Tailwind', run: () => void copy('tailwind'), disabled: !has },
    { label: 'Copy as JSX + inline styles', run: () => void copy('jsx'), disabled: !has },
    { label: 'Copy as HTML', run: () => void copy('html'), disabled: !has },
    { label: 'Copy as CSS', shortcut: '⌘⇧C', run: () => void copy('css'), disabled: !has },
    { label: '', separator: true },
    { label: 'Duplicate', shortcut: '⌘D', run: duplicateSelection, disabled: !has },
    { label: 'Wrap in frame', shortcut: '⌘G', run: wrapInFrame, disabled: !has },
    {
      label: 'Edit text',
      shortcut: '↵',
      run: () => state.nodeId && setEditingText(state.nodeId),
      disabled: node?.type !== 'text',
    },
    { label: '', separator: true },
    { label: 'Bring to front', shortcut: ']', run: () => doc && dispatch(reorder(doc, ids, 'front')), disabled: !has },
    { label: 'Bring forward', run: () => doc && dispatch(reorder(doc, ids, 'forward')), disabled: !has },
    { label: 'Send backward', run: () => doc && dispatch(reorder(doc, ids, 'backward')), disabled: !has },
    { label: 'Send to back', shortcut: '[', run: () => doc && dispatch(reorder(doc, ids, 'back')), disabled: !has },
    { label: '', separator: true },
    {
      label: 'Select parent',
      shortcut: '⏎',
      run: () => node?.parent && select([node.parent]),
      disabled: !node?.parent,
    },
    {
      label: 'Select children',
      run: () => node?.children.length && select(node.children),
      disabled: !node?.children.length,
    },
    {
      label: node?.visible === false ? 'Show' : 'Hide',
      shortcut: '⌘⇧H',
      run: () => dispatch([{ t: 'meta', updates: ids.map((id) => ({ id, visible: !(doc?.nodes[id]?.visible ?? true) })) }]),
      disabled: !has,
    },
    {
      label: node?.locked ? 'Unlock' : 'Lock',
      shortcut: '⌘⇧L',
      run: () => dispatch([{ t: 'meta', updates: ids.map((id) => ({ id, locked: !(doc?.nodes[id]?.locked ?? false) })) }]),
      disabled: !has,
    },
    { label: '', separator: true },
    { label: 'Export…', shortcut: '⌘⇧E', run: onExport, disabled: !has },
    {
      label: 'Delete',
      shortcut: '⌫',
      danger: true,
      run: () => { dispatch([{ t: 'remove', ids }]); select([]); },
      disabled: !has,
    },
  ];

  return (
    <>
      <div className="context-backdrop" onPointerDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div ref={ref} className="context-menu" style={{ left: pos.x, top: pos.y }} role="menu">
        {items.map((item, i) =>
          item.separator ? (
            <div key={i} className="context-separator" />
          ) : (
            <button
              key={i}
              role="menuitem"
              className={`context-item${item.danger ? ' is-danger' : ''}`}
              disabled={item.disabled}
              onClick={() => { item.run?.(); onClose(); }}
            >
              <span>{item.label}</span>
              {item.shortcut && <kbd>{item.shortcut}</kbd>}
            </button>
          ),
        )}
      </div>
    </>
  );
}
