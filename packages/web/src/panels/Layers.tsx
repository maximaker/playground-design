/** Layer tree: structure, naming, visibility, lock, and drag-to-reparent. */

import { useCallback, useState } from 'react';
import type { NodeId } from '@canvas/shared';
import { isAncestorOf } from '@canvas/shared';
import { useCanvas, getDoc, getNodeById, currentPage, topLevelSelection } from '../state/store.ts';

const TYPE_ICON: Record<string, string> = {
  artboard: '▢', frame: '▣', text: 'T', image: '🖼', vector: '✎', shape: '◼', embed: '⧉', instance: '◈',
};

export function Layers() {
  const version = useCanvas((s) => s.version);
  const page = currentPage();
  const [collapsed, setCollapsed] = useState<Set<NodeId>>(new Set());
  const [dropHint, setDropHint] = useState<{ id: NodeId; where: 'before' | 'after' | 'inside' } | null>(null);

  const toggle = useCallback((id: NodeId) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  if (!page) return null;

  return (
    <div className="layers" key={version}>
      {page.artboards.map((id) => (
        <LayerRow
          key={id} id={id} depth={0}
          collapsed={collapsed} toggle={toggle}
          dropHint={dropHint} setDropHint={setDropHint}
        />
      ))}
      {page.artboards.length === 0 && (
        <p className="panel-empty">No artboards yet. Press <kbd>F</kbd> and drag on the canvas.</p>
      )}
    </div>
  );
}

interface RowProps {
  id: NodeId;
  depth: number;
  collapsed: Set<NodeId>;
  toggle: (id: NodeId) => void;
  dropHint: { id: NodeId; where: 'before' | 'after' | 'inside' } | null;
  setDropHint: (h: { id: NodeId; where: 'before' | 'after' | 'inside' } | null) => void;
}

function LayerRow({ id, depth, collapsed, toggle, dropHint, setDropHint }: RowProps) {
  const selection = useCanvas((s) => s.selection);
  const select = useCanvas((s) => s.select);
  const dispatch = useCanvas((s) => s.dispatch);
  const setHovered = useCanvas((s) => s.setHovered);
  const [renaming, setRenaming] = useState(false);

  const node = getNodeById(id);
  if (!node) return null;

  const isSelected = selection.includes(id);
  const isCollapsed = collapsed.has(id);
  const hasChildren = node.children.length > 0;

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const doc = getDoc();
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
        style={{ paddingLeft: 6 + depth * 14 }}
        draggable={!renaming}
        onDragStart={(e) => {
          const ids = isSelected ? selection : [id];
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
          aria-label={isCollapsed ? 'Expand' : 'Collapse'}
        >
          {isCollapsed ? '▸' : '▾'}
        </button>

        <span className="layer-icon" aria-hidden>{TYPE_ICON[node.type] ?? '◼'}</span>

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
          <span className="layer-name" title={node.name}>{node.name}</span>
        )}

        <button
          className="layer-toggle"
          title={node.visible ? 'Hide' : 'Show'}
          onClick={(e) => {
            e.stopPropagation();
            dispatch([{ t: 'meta', updates: [{ id, visible: !node.visible }] }]);
          }}
        >
          {node.visible ? '👁' : '⌀'}
        </button>
        <button
          className="layer-toggle"
          title={node.locked ? 'Unlock' : 'Lock'}
          onClick={(e) => {
            e.stopPropagation();
            dispatch([{ t: 'meta', updates: [{ id, locked: !node.locked }] }]);
          }}
        >
          {node.locked ? '🔒' : '🔓'}
        </button>
      </div>

      {!isCollapsed && node.children.map((c) => (
        <LayerRow
          key={c} id={c} depth={depth + 1}
          collapsed={collapsed} toggle={toggle}
          dropHint={dropHint} setDropHint={setDropHint}
        />
      ))}
    </>
  );
}
