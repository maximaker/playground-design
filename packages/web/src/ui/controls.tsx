/**
 * Property-panel controls.
 *
 * Every control carries the real CSS property name in its tooltip. That is a
 * deliberate teaching choice: the tool's premise is that you are editing CSS, so
 * the UI should never hide which declaration a field writes.
 */

import { useEffect, useRef, useState } from 'react';

export function Field({ label, prop, children, wide }: {
  label: string; prop?: string; children: React.ReactNode; wide?: boolean;
}) {
  return (
    <label className={`field${wide ? ' is-wide' : ''}`} title={prop ? `CSS: ${prop}` : undefined}>
      <span className="field-label">{label}</span>
      <span className="field-control">{children}</span>
    </label>
  );
}

export function Section({ title, children, defaultOpen = true, action }: {
  title: string; children: React.ReactNode; defaultOpen?: boolean; action?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="prop-section">
      <header>
        <button onClick={() => setOpen((o) => !o)}>
          <span className="twisty">{open ? '▾' : '▸'}</span> {title}
        </button>
        {action}
      </header>
      {open && <div className="prop-body">{children}</div>}
    </section>
  );
}

/**
 * A text input that commits on blur or Enter and reverts on Escape, so typing a
 * value never produces a stream of intermediate document edits.
 */
export function TextInput({ value, onCommit, placeholder, mono, ...rest }: {
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [draft, setDraft] = useState(value);
  const dirty = useRef(false);

  useEffect(() => { if (!dirty.current) setDraft(value); }, [value]);

  return (
    <input
      {...rest}
      className={`input${mono ? ' is-mono' : ''}${rest.className ? ` ${rest.className}` : ''}`}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => { dirty.current = true; setDraft(e.target.value); }}
      onBlur={() => { dirty.current = false; if (draft !== value) onCommit(draft); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.currentTarget.blur(); }
        if (e.key === 'Escape') { dirty.current = false; setDraft(value); e.currentTarget.blur(); }
        e.stopPropagation();
      }}
    />
  );
}

/**
 * A numeric input with a unit. Supports drag-to-scrub on the label, which is the
 * fastest way to dial in spacing.
 */
export function NumberInput({ value, onCommit, min, max, step = 1, suffix = 'px', allowKeywords }: {
  value: string;
  onCommit: (v: string) => void;
  min?: number; max?: number; step?: number;
  suffix?: string;
  allowKeywords?: string[];
}) {
  const numeric = parseFloat(value);
  const isNumeric = Number.isFinite(numeric) && /^-?[\d.]+/.test(value.trim());

  return (
    <div className="number-input">
      <TextInput
        value={value}
        onCommit={(v) => {
          const t = v.trim();
          if (!t) return onCommit('');
          if (allowKeywords?.includes(t)) return onCommit(t);
          // A bare number gets the unit appended; anything else is passed
          // through so `calc()`, `%` and `var()` all still work.
          if (/^-?[\d.]+$/.test(t)) return onCommit(`${t}${suffix}`);
          onCommit(t);
        }}
      />
      {isNumeric && (
        <button
          className="scrub"
          title="Drag to change"
          onPointerDown={(e) => {
            e.preventDefault();
            const startX = e.clientX;
            const start = numeric;
            const el = e.currentTarget;
            el.setPointerCapture(e.pointerId);
            const move = (ev: PointerEvent) => {
              let next = start + Math.round((ev.clientX - startX) / 2) * step;
              if (min !== undefined) next = Math.max(min, next);
              if (max !== undefined) next = Math.min(max, next);
              onCommit(`${next}${suffix}`);
            };
            const up = () => {
              el.removeEventListener('pointermove', move);
              el.removeEventListener('pointerup', up);
            };
            el.addEventListener('pointermove', move);
            el.addEventListener('pointerup', up);
          }}
        >⇔</button>
      )}
    </div>
  );
}

export function Select({ value, options, onCommit }: {
  value: string;
  options: { value: string; label: string }[];
  onCommit: (v: string) => void;
}) {
  return (
    <select className="input select" value={value} onChange={(e) => onCommit(e.target.value)}>
      {!options.some((o) => o.value === value) && <option value={value}>{value || '—'}</option>}
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function SegmentedControl({ value, options, onCommit }: {
  value: string;
  options: { value: string; label: string; title?: string }[];
  onCommit: (v: string) => void;
}) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button
          key={o.value}
          className={value === o.value ? 'is-active' : ''}
          title={o.title ?? o.label}
          onClick={() => onCommit(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function ColorInput({ value, onCommit, tokens }: {
  value: string;
  onCommit: (v: string) => void;
  tokens?: { name: string; usage: string; resolved: string }[];
}) {
  const token = tokens?.find((t) => t.usage === value.trim());
  const swatch = token?.resolved ?? value;
  const hex = /^#[0-9a-f]{3,8}$/i.test(swatch) ? swatch : '#000000';

  return (
    <div className="color-input">
      <label className="swatch" style={{ background: swatch || 'transparent' }}>
        <input type="color" value={hex} onChange={(e) => onCommit(e.target.value)} />
      </label>
      <TextInput value={value} onCommit={onCommit} placeholder="transparent" mono />
      {tokens && tokens.length > 0 && (
        <select
          className="token-pick"
          title="Use a design token"
          value={token?.usage ?? ''}
          onChange={(e) => e.target.value && onCommit(e.target.value)}
        >
          <option value="">token…</option>
          {tokens.map((t) => <option key={t.name} value={t.usage}>{t.name}</option>)}
        </select>
      )}
    </div>
  );
}

export function Row({ children }: { children: React.ReactNode }) {
  return <div className="prop-row">{children}</div>;
}
