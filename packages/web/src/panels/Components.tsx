/**
 * The component library.
 *
 * Components exist to stop the same thing being rebuilt five times and drifting
 * apart. The panel is deliberately blunt about the linkage: it shows how many
 * instances each one has, because that count is the reason to use one.
 */

import { useEffect, useMemo } from 'react';
import {
  codeComponentsOf, componentsOf, collectSlots, instancesOf, makeNode, usageOf,
} from '@playground/shared';
import { useCanvas, getDoc, currentPage } from '../state/store.ts';
import {
  createComponentFromSelection, detachSelection, replaceWithComponent, revealSelection,
} from '../hooks/commands.ts';
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
  const replaceTarget = useCanvas((s) => s.replaceTarget);
  const setReplaceTarget = useCanvas((s) => s.setReplaceTarget);
  const doc = getDoc();

  /*
   * An armed replacement is a half-finished sentence, and a stale one is worse
   * than none: it turns the next click on a component — normally an insert —
   * into a deletion of something the person has since stopped thinking about.
   * So it lasts until it is used, until Escape, or until the selection moves on.
   */
  useEffect(() => {
    if (!replaceTarget) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setReplaceTarget(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [replaceTarget, setReplaceTarget]);

  useEffect(() => {
    if (!replaceTarget) return;
    const same = replaceTarget.length === selection.length
      && replaceTarget.every((id) => selection.some((key) => key.split('::')[0] === id));
    if (!same) setReplaceTarget(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection]);

  const replaceable = useMemo(() => {
    if (!doc) return [];
    return selection
      .map((key) => key.split('::')[0]!)
      .filter((id, i, all) => all.indexOf(id) === i)
      .filter((id) => {
        const node = doc.nodes[id];
        return !!node?.parent && node.type !== 'artboard';
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, selection, version]);

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
    // Put it in front of the person who asked for it. An instance dropped into
    // the last container you touched can land off screen, and then inserting
    // appears to have done nothing at all.
    revealSelection();
    toast(`${def?.name ?? 'Instance'} inserted`, 'info');
  };

  const replace = (componentId: string) => {
    replaceWithComponent(componentId, replaceTarget ?? replaceable);
    setReplaceTarget(null);
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

      {replaceTarget && (
        <div className="components-replacing">
          <Icon name="swap" size={12} />
          <span>
            Replacing {replaceTarget.length === 1
              ? `“${doc?.nodes[replaceTarget[0]!]?.name ?? 'a layer'}”`
              : `${replaceTarget.length} layers`} — click a component.
          </span>
          <button className="button subtle" onClick={() => setReplaceTarget(null)}>Cancel</button>
        </div>
      )}

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
          const usage = doc ? usageOf(doc, c.id) : { onPages: [], inComponents: [] };
          const count = usage.onPages.length;
          return (
            <div key={c.id} className="component-tile">
              <button
                className="component-main"
                onClick={() => (replaceTarget ? replace(c.id) : insert(c.id))}
                title={replaceTarget ? `Replace the selection with ${c.name}` : 'Insert an instance'}
              >
                <ComponentPreview docId={docId} componentId={c.id} name={c.name} stamp={version} />
                <span className="component-name">{c.name}</span>
                <span className="dim">
                  {count} instance{count === 1 ? '' : 's'}
                  {slots.length ? ` · ${slots.length} slot${slots.length === 1 ? '' : 's'}` : ''}
                  {c.props?.length ? ` · ${c.props.length} prop${c.props.length === 1 ? '' : 's'}` : ''}
                </span>
                {/* Used inside another component counts as used: a tag that
                    only appears in three cards read as "0 instances" and looked
                    like something to delete. */}
                {usage.inComponents.length > 0 && (
                  <span className="dim component-nested">
                    in {usage.inComponents.map((u) => `${u.name}${u.count > 1 ? ` ×${u.count}` : ''}`).join(', ')}
                  </span>
                )}
              </button>
              <div className="component-tile-actions">
                {replaceable.length > 0 && !replaceTarget && (
                  <button
                    className="icon-button"
                    title={`Replace the selection with ${c.name}`}
                    aria-label={`Replace the selection with ${c.name}`}
                    onClick={() => replace(c.id)}
                  ><Icon name="swap" size={12} /></button>
                )}
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

      {definition && doc && (
        <div className="component-detail">
          <h4 className="component-detail-title">{definition.name}</h4>

          {/*
            * The definition's own layers.
            *
            * A definition is not on any page, so it never appears on the canvas
            * or in the layer tree — which left "how do I change the component
            * itself" with no answer but editing an instance, which is the one
            * thing that does not change it. Selecting a row here puts that
            * layer in the inspector, and every instance updates as you edit.
            */}
          <DefinitionTree rootId={definition.root} />

          <VariantEditor def={definition} />
        </div>
      )}

      {components.length > 0 && (
        <p className="panel-hint">
          Click a component to insert an instance; it is selected and brought into view. Select an
          instance and use <strong>Go to component</strong> to edit the original — changes there
          reach every instance, while editing an instance overrides just that one.
          {' '}A component can contain an instance of another one: insert into a definition's layers
          above and the outer component follows the inner one from then on. To turn something you already built into a component,
          select it and use <strong>Replace with component</strong> from the right-click menu, or the
          swap button on a tile — it keeps the layer's place in the flow. Mark a layer with a
          <code> data-slot</code> attribute to let instances put their own content there.
        </p>
      )}
    </div>
  );
}

/**
 * The layers inside a component definition, as a list you can select from.
 *
 * Flat with indents rather than a collapsible tree: a definition is a handful
 * of layers, and a second tree with its own expand state beside the real one is
 * more machinery than the thing it shows.
 *
 * It exists because a definition is on no page, so it never appears on the
 * canvas or in the layer tree — which left "how do I change the component
 * itself" with no answer but editing an instance, which is the one thing that
 * does not change it.
 */
function DefinitionTree({ rootId }: { rootId: string }) {
  const select = useCanvas((s) => s.select);
  const selection = useCanvas((s) => s.selection);
  const version = useCanvas((s) => s.version);
  const doc = getDoc();
  void version;
  if (!doc) return null;

  const rows: { id: string; depth: number; name: string; type: string }[] = [];
  const walk = (id: string, depth: number) => {
    const node = doc.nodes[id];
    if (!node) return;
    rows.push({ id, depth, name: node.name, type: node.type });
    for (const child of node.children) walk(child, depth + 1);
  };
  walk(rootId, 0);

  return (
    <div className="definition-tree">
      {rows.map((row) => (
        <button
          key={row.id}
          className={`definition-row${selection.includes(row.id) ? ' is-selected' : ''}`}
          style={{ paddingLeft: `calc(${row.depth} * 0.8rem + 0.3rem)` }}
          onClick={() => select([row.id])}
          title="Edit this layer of the component"
        >
          <Icon name={row.type === 'instance' ? 'instance' : row.type === 'text' ? 'text' : 'frame'} size={11} />
          <span>{row.name}</span>
        </button>
      ))}
    </div>
  );
}
