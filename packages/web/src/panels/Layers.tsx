/**
 * The layer tree.
 *
 * Two things keep this cheap on a large document: rows subscribe to their own
 * node rather than a document-wide counter, and subtrees are collapsed until
 * opened. Rendering every node of a thousand-layer page — and worse, remounting
 * the tree on every edit — put the whole editor at single-digit frames per
 * second, because a keystroke anywhere rebuilt this panel.
 */

import { memo, useCallback, useEffect, useState } from 'react';
import type { NodeId } from '@playground/shared';
import { isAncestorOf } from '@playground/shared';
import { useCanvas, getDoc, getNodeById, currentPage, topLevelSelection } from '../state/store.ts';
import { Icon, iconForNodeType } from '../ui/Icon.tsx';

type DropHint = { id: NodeId; where: 'before' | 'after' | 'inside' } | null;

export function Layers() {
  // Only the shape of the tree matters here; row contents subscribe themselves.
  const structureVersion = useCanvas((s) => s.structureVersion);
  const page = currentPage();

  // Artboards start open, everything else closed — the same default every
  // design tool uses, and what keeps the row count bounded.
  const [expanded, setExpanded] = useState<Set<NodeId>>(new Set());
  const [dropHint, setDropHint] = useState<DropHint>(null);

  const toggle = useCallback((id: NodeId) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  /**
   * Reveal whatever is selected.
   *
   * Selecting on the canvas and then looking for the row in a collapsed tree is
   * the same hunt as finding the layer in the first place. Ancestors of the
   * selection are opened and the row is scrolled to — without touching what the
   * person has expanded themselves, which is why this adds and never removes.
   */
  const selection = useCanvas((s) => s.selection);
  useEffect(() => {
    const doc = getDoc();
    const id = selection[0]?.split('::')[0];
    if (!doc || !id) return;
    const ancestors: NodeId[] = [];
    for (let node = doc.nodes[id]?.parent ? doc.nodes[doc.nodes[id]!.parent!] : undefined;
      node; node = node.parent ? doc.nodes[node.parent] : undefined) {
      ancestors.push(node.id);
    }
    if (ancestors.length) {
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const a of ancestors) {
          // Artboards start open, so for them the set means *collapsed* — the
          // first version of this added every ancestor and closed the artboard,
          // which hid the whole tree instead of revealing a row in it.
          if (doc.nodes[a]?.type === 'artboard') next.delete(a);
          else next.add(a);
        }
        return [...next].join() === [...prev].join() ? prev : next;
      });
    }
    // After the rows for those ancestors have rendered.
    const timer = window.setTimeout(() => {
      document.querySelector(`.layer-row[data-layer-id="${CSS.escape(id)}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    }, 60);
    return () => window.clearTimeout(timer);
  }, [selection]);

  if (!page) return null;

  return (
    <div className="layers" key={page.id}>
      {page.artboards.map((id) => (
        <LayerRow
          key={id} id={id} depth={0} defaultOpen
          expanded={expanded} toggle={toggle}
          dropHint={dropHint} setDropHint={setDropHint}
          structureVersion={structureVersion}
        />
      ))}
      {page.artboards.length === 0 && (
        <p className="panel-empty">
          No artboards yet. Press <kbd>F</kbd> and drag on the canvas.
        </p>
      )}
    </div>
  );
}

interface RowProps {
  id: NodeId;
  depth: number;
  defaultOpen?: boolean;
  expanded: Set<NodeId>;
  toggle: (id: NodeId) => void;
  dropHint: DropHint;
  setDropHint: (h: DropHint) => void;
  structureVersion: number;
}

const LayerRow = memo(function LayerRow({
  id, depth, defaultOpen, expanded, toggle, dropHint, setDropHint, structureVersion,
}: RowProps) {
  // This row re-renders when its own node changes, not when anything does.
  useCanvas((s) => s.nodeVersions[id] ?? 0);

  const isSelected = useCanvas(
    (s) => s.selection.includes(id) || s.selection.some((k) => k.startsWith(`${id}::`)),
  );
  const select = useCanvas((s) => s.select);
  const dispatch = useCanvas((s) => s.dispatch);
  const setHovered = useCanvas((s) => s.setHovered);
  const [renaming, setRenaming] = useState(false);

  const node = getNodeById(id);
  if (!node) return null;

  // Artboards open by default, so for them the set records what is *closed*.
  const open = defaultOpen ? !expanded.has(id) : expanded.has(id);
  const hasChildren = node.children.length > 0;
  const doc = getDoc();
  const componentName = node.componentRef ? doc?.components?.[node.componentRef]?.name : undefined;

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const hint = dropHint;
    setDropHint(null);
    if (!doc || !hint) return;

    const dragged = topLevelSelection(JSON.parse(e.dataTransfer.getData('text/canvas-ids') || '[]') as NodeId[]);
    if (!dragged.length) return;
    // Refuse a move that would put a node inside itself — the op layer would
    // throw, but catching it here keeps the tree from flickering.
    if (dragged.some((d) => d === id || isAncestorOf(doc, d, id))) return;

    if (hint.where === 'inside') {
      dispatch([{ t: 'move', moves: dragged.map((d, i) => ({ id: d, parent: id, index: node.children.length + i })) }]);
    } else {
      const parent = node.parent;
      const siblings = parent ? doc.nodes[parent]!.children : (currentPage()?.artboards ?? []);
      const base = siblings.indexOf(id) + (hint.where === 'after' ? 1 : 0);
      dispatch([{ t: 'move', moves: dragged.map((d, i) => ({ id: d, parent, index: base + i, page: currentPage()?.id })) }]);
    }
  };

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientY - rect.top) / rect.height;
    const canContain = node.type !== 'text' && node.type !== 'image' && node.type !== 'vector';
    const where = ratio < 0.25 ? 'before' : ratio > 0.75 ? 'after' : canContain ? 'inside' : 'after';
    setDropHint({ id, where });
  };

  return (
    <>
      <div
        className={[
          'layer-row',
          isSelected ? 'is-selected' : '',
          !node.visible ? 'is-hidden' : '',
          dropHint?.id === id ? `drop-${dropHint.where}` : '',
        ].filter(Boolean).join(' ')}
        // Addressable, so selecting on the canvas can scroll this row into view.
        data-layer-id={id}
        style={{ paddingLeft: `calc(${depth} * 0.85rem + 0.4rem)` }}
        draggable={!renaming}
        onDragStart={(e) => {
          const ids = isSelected ? useCanvas.getState().selection : [id];
          if (!isSelected) select([id]);
          e.dataTransfer.setData('text/canvas-ids', JSON.stringify(ids));
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={onDragOver}
        onDragLeave={() => setDropHint(null)}
        onDrop={onDrop}
        onPointerEnter={() => setHovered(id)}
        onPointerLeave={() => setHovered(null)}
        onClick={(e) => {
          if (e.shiftKey) useCanvas.getState().toggleSelect(id);
          else select([id]);
        }}
        onDoubleClick={() => setRenaming(true)}
      >
        <button
          className="layer-twisty"
          style={{ visibility: hasChildren ? 'visible' : 'hidden' }}
          onClick={(e) => { e.stopPropagation(); toggle(id); }}
          aria-label={open ? 'Collapse' : 'Expand'}
          aria-expanded={open}
        >
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={10} />
        </button>

        <span className="layer-icon"><Icon name={iconForNodeType(node.type)} size={13} /></span>

        {renaming ? (
          <input
            className="layer-rename"
            defaultValue={node.name}
            autoFocus
            onBlur={(e) => {
              const name = e.target.value.trim();
              if (name && name !== node.name) dispatch([{ t: 'rename', updates: [{ id, name }] }]);
              setRenaming(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') setRenaming(false);
              e.stopPropagation();
            }}
          />
        ) : (
          <span className="layer-name" title={node.name}>{componentName ?? node.name}</span>
        )}

        <button
          className="layer-toggle"
          title={node.visible ? 'Hide' : 'Show'}
          aria-label={node.visible ? 'Hide layer' : 'Show layer'}
          onClick={(e) => {
            e.stopPropagation();
            dispatch([{ t: 'meta', updates: [{ id, visible: !node.visible }] }]);
          }}
        >
          <Icon name={node.visible ? 'eye' : 'eyeOff'} size={13} />
        </button>
        <button
          className="layer-toggle"
          title={node.locked ? 'Unlock' : 'Lock'}
          aria-label={node.locked ? 'Unlock layer' : 'Lock layer'}
          onClick={(e) => {
            e.stopPropagation();
            dispatch([{ t: 'meta', updates: [{ id, locked: !node.locked }] }]);
          }}
        >
          <Icon name={node.locked ? 'lock' : 'unlock'} size={13} />
        </button>
      </div>

      {open && node.children.map((c) => (
        <LayerRow
          key={c} id={c} depth={depth + 1}
          expanded={expanded} toggle={toggle}
          dropHint={dropHint} setDropHint={setDropHint}
          structureVersion={structureVersion}
        />
      ))}
    </>
  );
});
