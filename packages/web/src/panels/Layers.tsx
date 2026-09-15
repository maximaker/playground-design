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

  /*
   * Arrow-key navigation, the way a tree works everywhere else.
   *
   * Down and up walk the rows that are actually visible — a row inside a
   * collapsed group is not somewhere you can arrow to. Right opens a closed
   * group and then steps into it; left closes an open one and then steps out
   * to its parent, which is the pair that lets you cross a deep tree without
   * ever reaching for the mouse.
   */
  const onKeyDown = (e: React.KeyboardEvent) => {
    const doc = getDoc();
    if (!doc) return;
    const keys = ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End', 'Enter'];
    if (!keys.includes(e.key) || e.metaKey || e.ctrlKey || e.altKey) return;

    const rows = visibleRows();
    const current = useCanvas.getState().selection[0]?.split('::')[0] ?? rows[0];
    if (!current) return;
    const index = rows.indexOf(current);
    const node = doc.nodes[current];
    const isArtboard = node?.type === 'artboard';
    const open = isArtboard ? !expanded.has(current) : expanded.has(current);

    const go = (id: NodeId | undefined) => {
      if (!id) return;
      useCanvas.getState().select([id]);
      // Focus follows selection so the next arrow arrives here and not on the
      // canvas, where it would nudge the layer instead of moving past it.
      window.setTimeout(() => {
        document.querySelector<HTMLElement>(`.layer-row[data-layer-id="${CSS.escape(id)}"]`)?.focus();
      }, 0);
    };

    e.preventDefault();
    e.stopPropagation();

    if (e.key === 'ArrowDown') go(rows[index + 1] ?? rows[index]);
    else if (e.key === 'ArrowUp') go(rows[index - 1] ?? rows[0]);
    else if (e.key === 'Home') go(rows[0]);
    else if (e.key === 'End') go(rows[rows.length - 1]);
    else if (e.key === 'Enter') useCanvas.getState().setRenaming(current);
    else if (e.key === 'ArrowRight') {
      if (node?.children.length && !open) toggle(current);
      else go(node?.children[0]);
    } else if (e.key === 'ArrowLeft') {
      if (node?.children.length && open) toggle(current);
      else if (node?.parent) go(node.parent);
    }
  };

  return (
    <div className="layers" key={page.id} role="tree" aria-label="Layers" onKeyDown={onKeyDown}>
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

/** The rows a person can actually see, in the order they see them. */
function visibleRows(): NodeId[] {
  return [...document.querySelectorAll<HTMLElement>('.layer-row[data-layer-id]')]
    .map((el) => el.dataset.layerId!)
    .filter(Boolean);
}

/**
 * Select every row between the current selection and this one.
 *
 * The run is read off the rendered tree rather than recomputed from the
 * document, because what "between" means to the person holding shift is what
 * they can see: rows inside a collapsed group are not part of the run.
 */
function selectRangeTo(id: NodeId): void {
  const { selection, select } = useCanvas.getState();
  const rows = visibleRows();
  const anchorId = selection[selection.length - 1]?.split('::')[0];
  const from = anchorId ? rows.indexOf(anchorId) : -1;
  const to = rows.indexOf(id);
  if (from < 0 || to < 0) { select([id]); return; }
  const [a, b] = from < to ? [from, to] : [to, from];
  select(rows.slice(a, b + 1));
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
  // In the store, not in the row: the right-click menu offers Rename, and it
  // has no way to reach one row's useState.
  const renaming = useCanvas((s) => s.renaming === id);
  const setRenaming = (on: boolean) => useCanvas.getState().setRenaming(on ? id : null);

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
        role="treeitem"
        aria-selected={isSelected}
        aria-expanded={hasChildren ? open : undefined}
        // One tab stop for the whole tree, on the selected row: tabbing through
        // a hundred layers to reach the panel after it is not navigation.
        tabIndex={isSelected ? 0 : -1}
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
          // Figma's division, which is what people's hands expect: shift takes
          // the run between the last selection and this row, the platform
          // modifier adds or removes one, a plain click replaces.
          if (e.shiftKey) selectRangeTo(id);
          else if (e.metaKey || e.ctrlKey) useCanvas.getState().toggleSelect(id);
          else select([id]);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!isSelected) select([id]);
          useCanvas.getState().openContextMenu({ x: e.clientX, y: e.clientY, nodeId: id });
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
