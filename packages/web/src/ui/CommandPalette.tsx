/**
 * Command palette (⌘K).
 *
 * Two jobs in one surface: run any command without hunting for it, and find a
 * layer in a document too large to scroll. Agents already had `find_nodes`;
 * before this a person had no way to search at all.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { componentsOf, makeNode, type NodeId } from '@playground/shared';
import { useCanvas, getDoc, currentPage } from '../state/store.ts';
import { Icon, iconForNodeType, type IconName } from './Icon.tsx';
import {
  copyProperties, detachSelection, duplicateSelection, createComponentFromSelection,
  pasteProperties, selectParent, wrapInFrame, zoomToFit, zoomToSelection,
} from '../hooks/commands.ts';
import { reorder } from '../canvas/arrange.ts';

export interface PaletteActions {
  openImport: () => void;
  openExport: () => void;
  openConnect: () => void;
  openShortcuts: () => void;
  openPanel: (tab: string) => void;
  goHome: () => void;
}

interface Entry {
  id: string;
  label: string;
  hint?: string;
  icon: IconName;
  shortcut?: string;
  group: 'Actions' | 'Layers' | 'Components' | 'Pages' | 'Tools';
  run: () => void;
}

const MAX_PER_GROUP = 6;

/**
 * A command palette that ranks a layer's body text above a command is annoying,
 * so commands win ties. Layers still surface when they genuinely match better.
 */
const GROUP_BIAS: Record<Entry['group'], number> = {
  Actions: 60,
  Tools: 40,
  Components: 20,
  Pages: 10,
  Layers: 0,
};

export function CommandPalette({ onClose, actions }: { onClose: () => void; actions: PaletteActions }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  const selection = useCanvas((s) => s.selection);
  const structureVersion = useCanvas((s) => s.structureVersion);
  const setTool = useCanvas((s) => s.setTool);
  const select = useCanvas((s) => s.select);
  const dispatch = useCanvas((s) => s.dispatch);
  const setPage = useCanvas((s) => s.setPage);

  const entries = useMemo(
    () => buildEntries({ actions, selection, setTool, select, dispatch, setPage, onClose }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [actions, selection, structureVersion],
  );

  const matches = useMemo(() => rank(entries, query), [entries, query]);
  useEffect(() => setActive(0), [query]);

  // Keep the highlighted row in view while arrowing through a long list.
  useEffect(() => {
    listRef.current?.querySelector('.palette-item.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, matches.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    if (e.key === 'Enter') {
      e.preventDefault();
      matches[active]?.run();
      onClose();
    }
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    e.stopPropagation();
  };

  let lastGroup = '';

  return (
    <div className="modal-backdrop palette-backdrop" onPointerDown={onClose}>
      <div className="palette" onPointerDown={(e) => e.stopPropagation()} role="dialog" aria-label="Command palette">
        <div className="palette-search">
          <Icon name="search" size={15} />
          <input
            autoFocus
            value={query}
            placeholder="Search layers and commands…"
            aria-label="Search layers and commands"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <kbd>esc</kbd>
        </div>

        <div className="palette-list" ref={listRef}>
          {matches.length === 0 && <p className="panel-empty">Nothing matches “{query}”.</p>}
          {matches.map((entry, i) => {
            const header = entry.group !== lastGroup ? entry.group : null;
            lastGroup = entry.group;
            return (
              <div key={entry.id}>
                {header && <div className="palette-group">{header}</div>}
                <button
                  className={`palette-item${i === active ? ' is-active' : ''}`}
                  onPointerEnter={() => setActive(i)}
                  onClick={() => { entry.run(); onClose(); }}
                >
                  <Icon name={entry.icon} size={14} />
                  <span className="palette-label">{entry.label}</span>
                  {entry.hint && <span className="palette-hint">{entry.hint}</span>}
                  {entry.shortcut && <kbd>{entry.shortcut}</kbd>}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function buildEntries({
  actions, selection, setTool, select, dispatch, setPage, onClose,
}: {
  actions: PaletteActions;
  selection: string[];
  setTool: (t: never) => void;
  select: (ids: NodeId[]) => void;
  dispatch: ReturnType<typeof useCanvas.getState>['dispatch'];
  setPage: (id: string) => void;
  onClose: () => void;
}): Entry[] {
  const doc = getDoc();
  const page = currentPage();
  const hasSelection = selection.length > 0;
  const entries: Entry[] = [];

  const tool = (id: string, label: string, icon: IconName, key: string) =>
    entries.push({
      id: `tool:${id}`, label, icon, shortcut: key, group: 'Tools',
      run: () => setTool(id as never),
    });

  tool('move', 'Move tool', 'cursor', 'V');
  tool('frame', 'Frame tool', 'frame', 'F');
  tool('text', 'Text tool', 'text', 'T');
  tool('rect', 'Rectangle tool', 'square', 'R');
  tool('ellipse', 'Ellipse tool', 'circle', 'O');
  tool('image', 'Image tool', 'image', 'I');
  tool('note', 'Prompt card', 'note', 'N');

  const action = (id: string, label: string, icon: IconName, run: () => void, shortcut?: string, hint?: string) =>
    entries.push({ id: `action:${id}`, label, icon, run, shortcut, hint, group: 'Actions' });

  action('connect', 'Connect an agent', 'sparkle', actions.openConnect);
  action('review', 'Review this design', 'check', () => actions.openPanel('review'), undefined, 'Contrast, tap targets, tokens');
  action('import', 'Import a webpage', 'download', actions.openImport);
  action('export', 'Export', 'upload', actions.openExport, '⌘⇧E');
  action('shortcuts', 'Keyboard shortcuts', 'keyboard', actions.openShortcuts, '?');

  action('undo', 'Undo', 'undo', () => useCanvas.getState().undo(), '⌘Z');
  action('redo', 'Redo', 'redo', () => useCanvas.getState().redo(), '⌘⇧Z');

  // Shown whether or not something is selected: hiding them makes the palette
  // feel unreliable, and each one explains itself when there is nothing to act on.
  {
    const needs = hasSelection ? undefined : 'Select something first';
    action('duplicate', 'Duplicate', 'copy', duplicateSelection, '⌘D', needs);
    action('group', 'Wrap in a frame', 'frame', wrapInFrame, '⌘G', needs);
    action('component', 'Create a component', 'component', createComponentFromSelection, undefined, needs);
    action('detach', 'Detach from component', 'instance', detachSelection, undefined, needs);
    action('copy-props', 'Copy properties', 'copy', copyProperties, '⌥⌘C');
    action('paste-props', 'Paste properties', 'copy', pasteProperties, '⌥⌘V');
    action('front', 'Bring to front', 'chevronUp', () => doc && dispatch(reorder(doc, selection.map(stripKey), 'front')), ']');
    action('back', 'Send to back', 'chevronDown', () => doc && dispatch(reorder(doc, selection.map(stripKey), 'back')), '[');
    action('parent', 'Select parent', 'layers', selectParent, 'esc');
    action('zoom-sel', 'Zoom to selection', 'search', zoomToSelection, '2');
    action('delete', 'Delete', 'trash', () => {
      if (!hasSelection) return;
      dispatch([{ t: 'remove', ids: selection.map(stripKey) }]);
      select([]);
    }, '⌫', needs);
  }

  action('zoom-fit', 'Zoom to fit', 'search', zoomToFit, '1');
  action('tokens', 'Design tokens', 'palette', () => actions.openPanel('tokens'));
  action('history', 'Version history', 'history', () => actions.openPanel('history'));
  action('home', 'All documents', 'page', actions.goHome);

  // --- Layers --------------------------------------------------------------

  if (doc && page) {
    for (const artboardId of page.artboards) {
      const stack: NodeId[] = [artboardId];
      while (stack.length) {
        const id = stack.pop()!;
        const node = doc.nodes[id];
        if (!node) continue;
        stack.push(...node.children);
        entries.push({
          id: `layer:${id}`,
          label: node.name,
          hint: node.type === 'text' ? (node.text ?? '').slice(0, 40) : node.type,
          icon: iconForNodeType(node.type),
          group: 'Layers',
          run: () => { select([id]); zoomToSelection(); },
        });
      }
    }

    for (const component of componentsOf(doc)) {
      entries.push({
        id: `component:${component.id}`,
        label: component.name,
        hint: 'Insert an instance',
        icon: 'component',
        group: 'Components',
        run: () => {
          const parentId = selection[0] ? stripKey(selection[0]) : page.artboards[0];
          if (!parentId || !doc.nodes[parentId]) return;
          const instance = makeNode({ type: 'instance', name: component.name, componentRef: component.id });
          dispatch([{ t: 'insert', nodes: [instance], parent: parentId, index: doc.nodes[parentId]!.children.length }]);
          select([instance.id]);
        },
      });
    }

    for (const p of doc.pages) {
      if (p.id === page.id) continue;
      entries.push({
        id: `page:${p.id}`, label: p.name, hint: `${p.artboards.length} artboards`,
        icon: 'page', group: 'Pages', run: () => setPage(p.id),
      });
    }
  }

  void onClose;
  return entries;
}

function stripKey(key: string): NodeId {
  return key.split('::')[0]!;
}

/**
 * Ranks entries against the query.
 *
 * Subsequence matching, not substring: "cmp" should find "Create a component".
 * With no query the list stays short and useful rather than dumping every layer
 * in the document.
 */
function rank(entries: Entry[], query: string): Entry[] {
  const q = query.trim().toLowerCase();

  if (!q) {
    const order: Entry['group'][] = ['Actions', 'Tools', 'Components', 'Pages'];
    return order.flatMap((group) => entries.filter((e) => e.group === group).slice(0, MAX_PER_GROUP));
  }

  // Names are what people search for; body text is a fallback. Scoring them
  // together let a layer's paragraph outrank "Create a component" for "cmp".
  const scored = entries
    .map((entry) => {
      const byLabel = score(entry.label.toLowerCase(), q);
      const byHint = entry.hint ? score(entry.hint.toLowerCase(), q) * 0.25 : 0;
      return { entry, score: Math.max(byLabel, byHint) + GROUP_BIAS[entry.group] };
    })
    .filter((s) => s.score > GROUP_BIAS[entries[0]?.group ?? 'Actions'] || s.score > 50)
    .filter((s) => Math.max(score(s.entry.label.toLowerCase(), q), s.entry.hint ? score(s.entry.hint.toLowerCase(), q) : 0) > 0)
    .sort((a, b) => b.score - a.score);

  const perGroup = new Map<string, number>();
  const out: Entry[] = [];
  for (const { entry } of scored) {
    const seen = perGroup.get(entry.group) ?? 0;
    if (seen >= MAX_PER_GROUP) continue;
    perGroup.set(entry.group, seen + 1);
    out.push(entry);
  }
  // Group the survivors so headers appear once each.
  const order: Entry['group'][] = ['Actions', 'Layers', 'Components', 'Pages', 'Tools'];
  return order.flatMap((group) => out.filter((e) => e.group === group));
}

function score(haystack: string, needle: string): number {
  const exact = haystack.indexOf(needle);
  if (exact === 0) return 1000;
  if (exact > 0) return 800 - exact;

  // Subsequence: every character in order, rewarding tight runs.
  let index = 0;
  let hits = 0;
  let streak = 0;
  let best = 0;
  for (const ch of haystack) {
    if (ch === needle[index]) {
      index++; hits++; streak++;
      best = Math.max(best, streak);
      if (index === needle.length) break;
    } else {
      streak = 0;
    }
  }
  return index === needle.length ? 100 + hits + best * 5 : 0;
}
