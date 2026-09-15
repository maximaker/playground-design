/**
 * The component library.
 *
 * Components exist to stop the same thing being rebuilt five times and drifting
 * apart. The panel is deliberately blunt about the linkage: it shows how many
 * instances each one has, because that count is the reason to use one.
 */

import { useMemo } from 'react';
import { codeComponentsOf, componentsOf, collectSlots, instancesOf, makeNode } from '@playground/shared';
import { useCanvas, getDoc, currentPage } from '../state/store.ts';
import { createComponentFromSelection, detachSelection } from '../hooks/commands.ts';
import { Icon } from '../ui/Icon.tsx';
import { VariantEditor, selectedDefinition } from './VariantEditor.tsx';
import { ComponentPreview } from './ComponentPreview.tsx';

export function Components() {
  const version = useCanvas((s) => s.version);
  const selection = useCanvas((s) => s.selection);
  const dispatch = useCanvas((s) => s.dispatch);
  const select = useCanvas((s) => s.select);
  const toast = useCanvas((s) => s.toast);
  const docId = useCanvas((s) => s.docId);
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

  const codeComponents = useMemo(
    () => (doc ? codeComponentsOf(doc) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, version],
  );

  const insertCode = (componentId: string) => {
    const page = currentPage();
    if (!doc || !page) return;
    let parent = selection[0] ? doc.nodes[selection[0].split('::')[0]!] : undefined;
    while (parent && (parent.type === 'text' || parent.type === 'image' || parent.type === 'vector')) {
      parent = parent.parent ? doc.nodes[parent.parent] : undefined;
    }
    const parentId = parent?.id ?? page.artboards[0];
    if (!parentId) { toast('Create an artboard first', 'error'); return; }

    const component = doc.codeComponents?.[componentId];
    const node = makeNode({
      type: 'code', name: component?.name ?? 'Component',
      codeRef: componentId, styles: { display: 'block' },
    });
    dispatch([{ t: 'insert', nodes: [node], parent: parentId, index: doc.nodes[parentId]!.children.length }]);
    select([node.id]);
  };

  // When the selection is inside a definition, show that component's variants.
  const definition = selectedDefinition();

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

      {/*
        * A grid rather than a list: a component is a thing you recognise by
        * sight, and a column of names is the one presentation that hides that.
        * The tiles are auto-fitted, so the rail shows two and a wide rail or an
        * expanded drawer shows three.
        */}
      <div className="component-grid">
        {components.map((c) => {
          const root = doc?.nodes[c.root];
          const slots = root && doc ? collectSlots(doc, root) : [];
          const count = doc ? instancesOf(doc, c.id).length : 0;
          return (
            <div key={c.id} className="component-tile">
              <button className="component-main" onClick={() => insert(c.id)} title="Insert an instance">
                <ComponentPreview docId={docId} componentId={c.id} name={c.name} stamp={version} />
                <span className="component-name">{c.name}</span>
                <span className="dim">
                  {count} instance{count === 1 ? '' : 's'}
                  {slots.length ? ` · ${slots.length} slot${slots.length === 1 ? '' : 's'}` : ''}
                  {c.props?.length ? ` · ${c.props.length} prop${c.props.length === 1 ? '' : 's'}` : ''}
                </span>
              </button>
              <div className="component-tile-actions">
                <button
                  className="icon-button"
                  title="Edit the component definition"
                  aria-label={`Edit ${c.name}`}
                  onClick={() => root && select([root.id])}
                ><Icon name="edit" size={12} /></button>
                <button
                  className="icon-button"
                  title="Delete component"
                  aria-label={`Delete ${c.name}`}
                  onClick={() => remove(c.id, c.name)}
                ><Icon name="trash" size={12} /></button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="components-section">
        <h4 className="components-section-title">From your code</h4>
        {codeComponents.length === 0 ? (
          <p className="panel-empty">
            <span className="dim">
              An agent connected to this document can register your real React components here —
              ask it for <code>register_code_component</code>. They render on the canvas with their
              own props, and export as a real import rather than a copy of their markup.
            </span>
          </p>
        ) : codeComponents.map((c) => {
          const count = Object.values(doc?.nodes ?? {}).filter((n) => n.codeRef === c.id).length;
          return (
            <div key={c.id} className="component-row">
              <button className="component-main" onClick={() => insertCode(c.id)} title="Insert an instance">
                <span className="component-name">{c.name}</span>
                <span className="dim">
                  {c.importPath}
                  {` · ${count} instance${count === 1 ? '' : 's'}`}
                  {c.props.length ? ` · ${c.props.length} prop${c.props.length === 1 ? '' : 's'}` : ''}
                </span>
              </button>
            </div>
          );
        })}
      </div>

      {definition && (
        <div className="component-detail">
          <h4 className="component-detail-title">{definition.name}</h4>
          <VariantEditor def={definition} />
        </div>
      )}

      {components.length > 0 && (
        <p className="panel-hint">
          Click a component to insert an instance. Mark a layer inside a definition with a
          <code> data-slot</code> attribute to let instances put their own content there.
        </p>
      )}
    </div>
  );
}
