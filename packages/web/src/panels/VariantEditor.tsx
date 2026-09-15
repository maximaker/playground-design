/**
 * Variant authoring for a component.
 *
 * The rule the UI has to make obvious is which of three places an edit lands:
 * the base component, a variant, or a single instance. So editing a variant is
 * an explicit mode — you pick the combination you are editing, and the panel
 * says what you are changing while that mode is on.
 */

import { useState } from 'react';
import {
  type ComponentDef, type ComponentProp,
  findVariant, variantKey, variantMatrix,
} from '@playground/shared';
import { useCanvas, getDoc } from '../state/store.ts';
import { Icon } from '../ui/Icon.tsx';

export function VariantEditor({ def }: { def: ComponentDef }) {
  const dispatch = useCanvas((s) => s.dispatch);
  const editingVariant = useCanvas((s) => s.editingVariant);
  const setEditingVariant = useCanvas((s) => s.setEditingVariant);
  const select = useCanvas((s) => s.select);
  const toast = useCanvas((s) => s.toast);
  const [adding, setAdding] = useState(false);

  const props = def.props ?? [];
  const matrix = variantMatrix(def);

  const addProp = (name: string, values: string[]) => {
    if (props.some((p) => p.name === name)) { toast(`"${name}" already exists`, 'error'); return; }
    dispatch([{
      t: 'component', action: 'update',
      component: { id: def.id, props: [...props, { name, values, default: values[0]! }] },
    }]);
    setAdding(false);
  };

  const updateProp = (name: string, patch: Partial<ComponentProp>) => {
    dispatch([{
      t: 'component', action: 'update',
      component: { id: def.id, props: props.map((p) => (p.name === name ? { ...p, ...patch } : p)) },
    }]);
  };

  const removeProp = (name: string) => {
    dispatch([{
      t: 'component', action: 'update',
      component: {
        id: def.id,
        props: props.filter((p) => p.name !== name),
        // Variants that referenced the removed property would never match again.
        variants: (def.variants ?? []).filter((v) => !(name in v.match)),
      },
    }]);
  };

  return (
    <div className="variant-editor">
      <div className="variant-section-head">
        <h4>Properties</h4>
        <button className="icon-button" title="Add a property" onClick={() => setAdding(true)}>
          <Icon name="plus" />
        </button>
      </div>

      {props.length === 0 && !adding && (
        <div className="variant-empty">
          <p className="dim">
            A variant is one component that comes in several forms. Add a property —{' '}
            <code>tone</code> with <code>solid</code> and <code>ghost</code>, say — then pick a
            combination below and restyle it. Every instance can then be switched between them,
            and they all still follow the component.
          </p>
          <button className="button subtle full" onClick={() => setAdding(true)}>
            + Add a property
          </button>
        </div>
      )}

      {props.map((prop) => (
        <div key={prop.name} className="variant-prop">
          <div className="variant-prop-head">
            <span className="variant-prop-name">{prop.name}</span>
            <button className="icon-button" title="Remove property" onClick={() => removeProp(prop.name)}>
              <Icon name="close" />
            </button>
          </div>
          <input
            className="input is-mono"
            defaultValue={prop.values.join(', ')}
            key={`${prop.name}-${prop.values.join()}`}
            onBlur={(e) => {
              const values = e.target.value.split(',').map((v) => v.trim()).filter(Boolean);
              if (!values.length) return;
              updateProp(prop.name, {
                values,
                default: values.includes(prop.default) ? prop.default : values[0]!,
              });
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); e.stopPropagation(); }}
          />
          <label className="variant-default">
            <span className="field-label">Default</span>
            <select
              className="input select"
              value={prop.default}
              onChange={(e) => updateProp(prop.name, { default: e.target.value })}
            >
              {prop.values.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </label>
        </div>
      ))}

      {adding && <AddProp onAdd={addProp} onCancel={() => setAdding(false)} />}

      {matrix.length > 0 && (
        <>
          <div className="variant-section-head">
            <h4>Variants</h4>
            <span className="dim">{matrix.length} combinations</span>
          </div>

          {editingVariant && (
            <p className="variant-note">
              Editing <code>{describeMatch(editingVariant.match)}</code>. Changes on the canvas apply
              to this combination only.
              <button className="button subtle" onClick={() => setEditingVariant(null)}>Done</button>
            </p>
          )}

          <div className="variant-matrix">
            {matrix.map((match) => {
              const existing = findVariant(def, match);
              const active = editingVariant && variantKey(editingVariant.match) === variantKey(match);
              return (
                <button
                  key={variantKey(match)}
                  className={`variant-cell${active ? ' is-active' : ''}${existing ? ' has-overrides' : ''}`}
                  title={existing ? `${Object.keys(existing.overrides).length} layers changed` : 'Not customised — renders as the base component'}
                  onClick={() => {
                    setEditingVariant(active ? null : { componentId: def.id, match });
                    // Selecting the definition puts the thing being edited on
                    // screen; editing a variant blind is not useful.
                    if (!active) select([def.root]);
                  }}
                >
                  <span>{describeMatch(match)}</span>
                  {existing && <em>{Object.keys(existing.overrides).length}</em>}
                </button>
              );
            })}
          </div>

          {editingVariant && findVariant(def, editingVariant.match) && (
            <button
              className="button subtle full"
              onClick={() => {
                dispatch([{ t: 'variant', componentId: def.id, match: editingVariant.match, overrides: null }]);
                toast('Variant reset to the base component', 'success');
              }}
            >Reset this variant</button>
          )}
        </>
      )}
    </div>
  );
}

function AddProp({ onAdd, onCancel }: { onAdd: (name: string, values: string[]) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [values, setValues] = useState('sm, md, lg');
  return (
    <div className="token-add">
      <input className="input" placeholder="size" value={name} autoFocus onChange={(e) => setName(e.target.value)} />
      <input className="input is-mono" value={values} onChange={(e) => setValues(e.target.value)} />
      <div className="token-add-actions">
        <button
          className="button primary"
          disabled={!name.trim() || !values.trim()}
          onClick={() => onAdd(name.trim(), values.split(',').map((v) => v.trim()).filter(Boolean))}
        >Add</button>
        <button className="button subtle" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function describeMatch(match: Record<string, string>): string {
  return Object.keys(match).sort().map((k) => match[k]).join(' · ');
}

/** The component whose definition the selection sits inside, if any. */
export function selectedDefinition(): ComponentDef | null {
  const doc = getDoc();
  const { selection } = useCanvas.getState();
  if (!doc || !selection.length) return null;

  const roots = Object.values(doc.components ?? {});
  for (const key of selection) {
    let id: string | null = key.split('::')[0]!;
    while (id) {
      const hit = roots.find((c) => c.root === id);
      if (hit) return hit;
      id = doc.nodes[id]?.parent ?? null;
    }
  }
  return null;
}
