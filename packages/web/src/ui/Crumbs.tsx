/**
 * Where the selection sits in the tree, and the way up and down it.
 *
 * A plain click selects the outermost layer inside the artboard, which is the
 * right default and leaves two questions open: what exactly is selected, and
 * how do I get to the thing inside it. The canvas badge answers the first. This
 * answers the second without asking anyone to know that ⌘-click exists or to go
 * hunting in the layer tree.
 */

import { artboardOf } from '@playground/shared';
import { getDoc, useCanvas } from '../state/store.ts';
import { Icon } from './Icon.tsx';

export function Crumbs() {
  const selection = useCanvas((s) => s.selection);
  const version = useCanvas((s) => s.version);
  const select = useCanvas((s) => s.select);
  const setHovered = useCanvas((s) => s.setHovered);
  const doc = getDoc();
  void version;

  const id = selection[0]?.split('::')[0];
  if (!doc || !id || selection.length !== 1 || !doc.nodes[id]) return null;

  // Artboard first, selection last.
  const path: { id: string; name: string }[] = [];
  let node: typeof doc.nodes[string] | undefined = doc.nodes[id];
  while (node) {
    path.unshift({ id: node.id, name: node.name });
    if (node.type === 'artboard') break;
    node = node.parent ? doc.nodes[node.parent] : undefined;
  }

  const children = doc.nodes[id]?.children ?? [];
  const artboard = artboardOf(doc, id);

  return (
    <nav className="crumbs" aria-label="Where this layer sits">
      {path.map((crumb, i) => (
        <span key={crumb.id} style={{ display: 'contents' }}>
          {i > 0 && <span className="crumb-sep" aria-hidden>›</span>}
          <button
            className={crumb.id === id ? 'is-current' : ''}
            title={crumb.id === artboard ? `${crumb.name} (artboard)` : crumb.name}
            onClick={() => select([crumb.id])}
            onPointerEnter={() => setHovered(crumb.id)}
            onPointerLeave={() => setHovered(null)}
          >{crumb.name}</button>
        </span>
      ))}

      {/* One step down, for the common case of "the thing inside this". */}
      {children.length > 0 && (
        <button
          className="crumb-children"
          title={`Select the first of ${children.length} layer${children.length === 1 ? '' : 's'} inside`}
          onClick={() => select([children[0]!])}
        >
          <Icon name="chevronRight" size={11} /> {children.length}
        </button>
      )}
    </nav>
  );
}
