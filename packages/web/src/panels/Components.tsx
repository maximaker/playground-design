/**
 * The component library.
 *
 * Components exist to stop the same thing being rebuilt five times and drifting
 * apart. The panel is deliberately blunt about the linkage: it shows how many
 * instances each one has, because that count is the reason to use one.
 */

import { useMemo } from 'react';
import { componentsOf, collectSlots, instancesOf, makeNode } from '@canvas/shared';
import { useCanvas, getDoc, currentPage } from '../state/store.ts';
import { createComponentFromSelection, detachSelection } from '../hooks/commands.ts';

export function Components() {
  const version = useCanvas((s) => s.version);
  const selection = useCanvas((s) => s.selection);
  const dispatch = useCanvas((s) => s.dispatch);
  const select = useCanvas((s) => s.select);
  const toast = useCanvas((s) => s.toast);
  const doc = getDoc();

  const components = useMemo(
    () => (doc ? componentsOf(doc) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, version],
  );

  const insert = (componentId: string) => {
    const page = currentPage();
    if (!doc || !page) return;

    // Drop the instance into whatever container is selected, else the first
    // artboard — the same rule paste uses.
    let parent = selection[0] ? doc.nodes[selection[0].split('::')[0]!] : undefined;
    while (parent && (parent.type === 'text' || parent.type === 'image' || parent.type === 'vector')) {
      parent = parent.parent ? doc.nodes[parent.parent] : undefined;
    }
    const parentId = parent?.id ?? page.artboards[0];
    if (!parentId) { toast('Create an artboard first', 'error'); return; }

    const def = doc.components?.[componentId];
    const instance = makeNode({ type: 'instance', name: def?.name ?? 'Instance', componentRef: componentId });
    dispatch([{ t: 'insert', nodes: [instance], parent: parentId, index: doc.nodes[parentId]!.children.length }]);
    select([instance.id]);
  };

  const remove = (componentId: string, name: string) => {
    if (!doc) return;
    const count = instancesOf(doc, componentId).length;
    if (count > 0) {
      toast(`"${name}" still has ${count} instance${count === 1 ? '' : 's'}. Detach or delete them first.`, 'error');
      return;
    }
    const def = doc.components?.[componentId];
    dispatch([
      { t: 'component', action: 'remove', component: { id: componentId } },
      ...(def ? [{ t: 'remove' as const, ids: [def.root] }] : []),
    ]);
  };

  const selectionIsInstance = selection.some((key) => {
    const node = doc?.nodes[key.split('::')[0]!];
    return node?.type === 'instance';
  });

  return (
    <div className="components">
      <div className="components-actions">
        <button
          className="button subtle full"
          disabled={!selection.length}
          title={selection.length ? undefined : 'Select something on the canvas first'}
          onClick={createComponentFromSelection}
        >+ Create from selection</button>
        {selectionIsInstance && (
          <button className="button subtle full" onClick={detachSelection}>
            Detach instance
          </button>
        )}
      </div>

      {components.length === 0 && (
        <p className="panel-empty">
          No components yet.<br />
          <span className="dim">
            Select something you will reuse — a button, a card — and create a component from it.
            Editing the component updates every instance; editing an instance overrides just that one.
          </span>
        </p>
      )}

      {components.map((c) => {
        const root = doc?.nodes[c.root];
        const slots = root && doc ? collectSlots(doc, root) : [];
        const count = doc ? instancesOf(doc, c.id).length : 0;
        return (
          <div key={c.id} className="component-row">
            <button className="component-main" onClick={() => insert(c.id)} title="Insert an instance">
              <span className="component-name">{c.name}</span>
              <span className="dim">
                {count} instance{count === 1 ? '' : 's'}
                {slots.length ? ` · ${slots.length} slot${slots.length === 1 ? '' : 's'}` : ''}
              </span>
            </button>
            <button
              className="icon-button"
              title="Edit the component definition"
              onClick={() => root && select([root.id])}
            >✎</button>
            <button className="icon-button" title="Delete component" onClick={() => remove(c.id, c.name)}>✕</button>
          </div>
        );
      })}

      {components.length > 0 && (
        <p className="panel-hint">
          Click a component to insert an instance. Mark a layer inside a definition with a
          <code> data-slot</code> attribute to let instances put their own content there.
        </p>
      )}
    </div>
  );
}
