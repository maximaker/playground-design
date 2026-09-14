/** Design tokens: named values emitted as CSS custom properties, with themes. */

import { useState } from 'react';
import type { Token, TokenGroup } from '@canvas/shared';
import { tokenToCssVar } from '@canvas/shared';
import { useCanvas, getDoc } from '../state/store.ts';

const GROUPS: TokenGroup[] = ['color', 'space', 'radius', 'font', 'shadow', 'duration'];

export function Tokens() {
  const version = useCanvas((s) => s.version);
  const dispatch = useCanvas((s) => s.dispatch);
  const toast = useCanvas((s) => s.toast);
  const doc = getDoc();
  const [theme, setTheme] = useState('default');
  const [adding, setAdding] = useState(false);

  if (!doc) return null;

  const commit = (tokens: Token[]) => dispatch([{ t: 'tokens', tokens }]);

  const update = (name: string, value: string) => {
    commit(doc.tokens.map((t) => (t.name === name ? { ...t, values: { ...t.values, [theme]: value } } : t)));
  };

  const remove = (name: string) => commit(doc.tokens.filter((t) => t.name !== name));

  const add = (name: string, group: TokenGroup, value: string) => {
    if (doc.tokens.some((t) => t.name === name)) { toast(`A token named "${name}" already exists`, 'error'); return; }
    commit([...doc.tokens, { name, group, values: { default: value } }]);
    setAdding(false);
  };

  return (
    <div className="tokens" key={version}>
      <div className="tokens-themes">
        {doc.themes.map((t) => (
          <button key={t} className={theme === t ? 'is-active' : ''} onClick={() => setTheme(t)}>{t}</button>
        ))}
        <button
          className="add-variant"
          title="Add a theme"
          onClick={() => {
            const name = window.prompt('Theme name')?.trim();
            if (!name || doc.themes.includes(name)) return;
            // A new theme starts as a copy of default, so nothing renders unstyled.
            commit(doc.tokens.map((t) => ({ ...t, values: { ...t.values, [name]: t.values[name] ?? t.values.default ?? '' } })));
            setTheme(name);
          }}
        >+</button>
      </div>

      {GROUPS.map((group) => {
        const rows = doc.tokens.filter((t) => t.group === group);
        if (!rows.length) return null;
        return (
          <div key={group} className="token-group">
            <h4>{group}</h4>
            {rows.map((t) => (
              <div key={t.name} className="token-row">
                {group === 'color' && (
                  <label className="swatch" style={{ background: t.values[theme] ?? t.values.default }}>
                    <input
                      type="color"
                      value={normalizeHex(t.values[theme] ?? t.values.default ?? '#000000')}
                      onChange={(e) => update(t.name, e.target.value)}
                    />
                  </label>
                )}
                <span className="token-name" title={`var(${tokenToCssVar(t.name)})`}>{t.name}</span>
                <input
                  className="input is-mono"
                  defaultValue={t.values[theme] ?? ''}
                  placeholder={theme === 'default' ? '' : t.values.default}
                  key={`${t.name}-${theme}-${version}`}
                  onBlur={(e) => e.target.value !== (t.values[theme] ?? '') && update(t.name, e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); e.stopPropagation(); }}
                />
                <button className="icon-button" title="Delete token" onClick={() => remove(t.name)}>✕</button>
              </div>
            ))}
          </div>
        );
      })}

      {adding ? <AddToken onAdd={add} onCancel={() => setAdding(false)} /> : (
        <button className="button subtle full" onClick={() => setAdding(true)}>+ New token</button>
      )}

      <p className="panel-hint">
        Tokens become CSS custom properties. Reference one anywhere a value goes, as
        <code> var(--color-brand)</code>. Exported code carries them too.
      </p>
    </div>
  );
}

function AddToken({ onAdd, onCancel }: { onAdd: (n: string, g: TokenGroup, v: string) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [group, setGroup] = useState<TokenGroup>('color');
  const [value, setValue] = useState('#3b82f6');

  return (
    <div className="token-add">
      <input className="input" placeholder="color.brand.600" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      <select className="input select" value={group} onChange={(e) => setGroup(e.target.value as TokenGroup)}>
        {GROUPS.map((g) => <option key={g} value={g}>{g}</option>)}
      </select>
      <input className="input is-mono" value={value} onChange={(e) => setValue(e.target.value)} />
      <div className="token-add-actions">
        <button className="button primary" disabled={!name.trim() || !value.trim()} onClick={() => onAdd(name.trim(), group, value.trim())}>Add</button>
        <button className="button subtle" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function normalizeHex(v: string): string {
  return /^#[0-9a-f]{6}$/i.test(v) ? v : '#000000';
}
