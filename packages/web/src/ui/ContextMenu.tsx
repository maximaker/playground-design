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
import { createComponentFromSelection, duplicateSelection, wrapInFrame } from '../hooks/commands.ts';
import { MOD } from './tools.ts';

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
    const label = { tailwind: 'JSX + Tailwind', jsx: 'JSX', css: 'CSS', html: 'HTML' }[what];
    try {
      await navigator.clipboard.writeText(text);
      toast(`Copied as ${label}`, 'success');
    } catch {
      toast('Could not reach the clipboard', 'error');
    }
  };

  /*
   * Pictures, through the same server render Export uses. The PNG goes on the
   * clipboard as an image (pastes into Figma, Slack, docs); the SVG as its
   * markup, which Figma and most design tools paste as vectors. The fetch is
   * handed to the clipboard as a promise so the click still counts as the
   * user's gesture while the render runs.
   */
  const copyPicture = async (format: 'png' | 'svg') => {
    const id = ids[0];
    const docId = useCanvas.getState().docId;
    if (!id || !docId) return;
    const url = `/api/documents/${docId}/export/${id}?format=${format}&scale=${format === 'png' ? 2 : 1}`;
    const fetched = fetch(url, { credentials: 'same-origin' }).then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.blob();
    });
    try {
      if (format === 'png') {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': fetched.then((b) => new Blob([b], { type: 'image/png' })) })]);
      } else {
        const svg = await (await fetched).text();
        await navigator.clipboard.write([new ClipboardItem({
          'text/plain': new Blob([svg], { type: 'text/plain' }),
        })]);
      }
      toast(`Copied as ${format.toUpperCase()}${ids.length > 1 ? ' (first selected layer)' : ''}`, 'success');
    } catch {
      toast(`Could not copy as ${format.toUpperCase()}`, 'error');
    }
  };

  const hasComponents = Object.keys(doc?.components ?? {}).length > 0;

  const items: Item[] = [
    { label: 'Copy as JSX + Tailwind', run: () => void copy('tailwind'), disabled: !has },
    { label: 'Copy as JSX + inline styles', run: () => void copy('jsx'), disabled: !has },
    { label: 'Copy as HTML', run: () => void copy('html'), disabled: !has },
    { label: 'Copy as CSS', shortcut: `${MOD}⇧C`, run: () => void copy('css'), disabled: !has },
    { label: 'Copy as PNG', run: () => void copyPicture('png'), disabled: !has },
    { label: 'Copy as SVG', run: () => void copyPicture('svg'), disabled: !has },
    { label: '', separator: true },
    {
      label: 'Rename',
      shortcut: 'F2',
      run: () => {
        if (!state.nodeId) return;
        useCanvas.getState().requestPanel('layers');
        useCanvas.getState().setRenaming(state.nodeId);
      },
      disabled: !state.nodeId,
    },
    { label: 'Duplicate', shortcut: `${MOD}D`, run: duplicateSelection, disabled: !has },
    { label: 'Wrap in frame', shortcut: `${MOD}G`, run: wrapInFrame, disabled: !has },
    { label: 'Create component', run: createComponentFromSelection, disabled: !has },
    {
      // Arms the library rather than opening a submenu of names: which
      // component you want is a question you answer by looking at them, and
      // the panel already shows what each one is.
      label: node?.type === 'instance' ? 'Swap component…' : 'Replace with component…',
      run: () => {
        useCanvas.getState().setReplaceTarget(ids);
        useCanvas.getState().requestPanel('components');
      },
      disabled: !has || !hasComponents,
    },
    {
      label: 'Edit text',
      shortcut: '↵',
      run: () => state.nodeId && setEditingText(state.nodeId),
      disabled: node?.type !== 'text',
    },
    { label: '', separator: true },
    { label: 'Bring to front', shortcut: ']', run: () => doc && dispatch(reorder(doc, ids, 'front')), disabled: !has },
    { label: 'Bring forward', shortcut: `${MOD}]`, run: () => doc && dispatch(reorder(doc, ids, 'forward')), disabled: !has },
    { label: 'Send backward', shortcut: `${MOD}[`, run: () => doc && dispatch(reorder(doc, ids, 'backward')), disabled: !has },
    { label: 'Send to back', shortcut: '[', run: () => doc && dispatch(reorder(doc, ids, 'back')), disabled: !has },
    { label: '', separator: true },
    {
      label: 'Select parent',
      shortcut: '\\',
      run: () => node?.parent && select([node.parent]),
      disabled: !node?.parent,
    },
    {
      label: 'Select children',
      shortcut: '↵',
      run: () => node?.children.length && select(node.children),
      disabled: !node?.children.length,
    },
    {
      label: node?.visible === false ? 'Show' : 'Hide',
      shortcut: `${MOD}⇧H`,
      run: () => dispatch([{ t: 'meta', updates: ids.map((id) => ({ id, visible: !(doc?.nodes[id]?.visible ?? true) })) }]),
      disabled: !has,
    },
    {
      label: node?.locked ? 'Unlock' : 'Lock',
      shortcut: `${MOD}⇧L`,
      run: () => dispatch([{ t: 'meta', updates: ids.map((id) => ({ id, locked: !(doc?.nodes[id]?.locked ?? false) })) }]),
      disabled: !has,
    },
    { label: '', separator: true },
    { label: 'Export…', shortcut: `${MOD}⇧E`, run: onExport, disabled: !has },
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
