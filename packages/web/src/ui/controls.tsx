/**
 * Property-panel controls.
 *
 * Every control carries the real CSS property name in its tooltip. That is a
 * deliberate teaching choice: the tool's premise is that you are editing CSS, so
 * the UI should never hide which declaration a field writes.
 */

import { useEffect, useRef, useState } from 'react';
import { evaluateInput, formatNumber, stepMultiplier, stepValue } from '@playground/shared';
import { Icon } from './Icon.tsx';

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
        <button onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={10} className="twisty" />
          {title}
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
export function TextInput({ value, onCommit, placeholder, mono, onKey, selectOnFocus, ...rest }: {
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  /** Return true to consume the key. Lets a numeric field own the arrows. */
  onKey?: (e: React.KeyboardEvent<HTMLInputElement>) => boolean;
  /** Focusing selects the text, so typing replaces rather than appends. */
  selectOnFocus?: boolean;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [draft, setDraft] = useState(value);
  const dirty = useRef(false);
  // Mirrored in a ref because the blur handler must read the latest text, not
  // whatever `draft` was when this render's closure was created — a change and
  // a blur in the same tick would otherwise commit the previous value.
  const latest = useRef(value);

  useEffect(() => {
    if (!dirty.current) { setDraft(value); latest.current = value; }
  }, [value]);

  const commit = () => {
    dirty.current = false;
    if (latest.current !== value) onCommit(latest.current);
  };

  return (
    <input
      {...rest}
      className={`input${mono ? ' is-mono' : ''}${rest.className ? ` ${rest.className}` : ''}`}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => { dirty.current = true; latest.current = e.target.value; setDraft(e.target.value); }}
      onBlur={commit}
      onFocus={(e) => { if (selectOnFocus) e.currentTarget.select(); rest.onFocus?.(e); }}
      onKeyDown={(e) => {
        // The owner gets first refusal, so stepping beats the caret moving.
        if (onKey?.(e)) { e.stopPropagation(); return; }
        if (e.key === 'Enter') { e.currentTarget.blur(); }
        if (e.key === 'Escape') { dirty.current = false; latest.current = value; setDraft(value); e.currentTarget.blur(); }
        e.stopPropagation();
      }}
    />
  );
}

/**
 * A numeric input with a unit.
 *
 * Three ways to change it, because different edits want different gestures:
 * type an exact value, hold an arrow key to walk it, or drag the handle to
 * scrub. Shift steps by ten and Alt by a tenth throughout, matching what people
 * arrive already knowing from other design tools.
 *
 * Continuous changes are marked so the undo stack folds a whole gesture into
 * one step; without that a two-second scrub buries everything before it.
 */
export function NumberInput({ value, onCommit, min, max, step = 1, suffix = 'px', allowKeywords }: {
  value: string;
  /** `coalesce` marks one step of a continuous gesture for the undo stack. */
  onCommit: (v: string, opts?: { coalesce?: string }) => void;
  min?: number; max?: number; step?: number;
  suffix?: string;
  allowKeywords?: string[];
}) {
  const numeric = parseFloat(value);
  const isNumeric = Number.isFinite(numeric) && /^-?[\d.]+/.test(value.trim());
  // Distinct per control instance, so stepping W and then H stays two steps.
  const gesture = useRef(`step:${Math.random().toString(36).slice(2)}`);

  // Key repeat fires faster than React commits, so several keydowns can share
  // one render — and each would then step from the same stale value, turning a
  // held arrow key into a single increment. Stepping from the last value this
  // control produced keeps every repeat counting.
  const stepped = useRef(value);
  const lastProp = useRef(value);
  if (lastProp.current !== value) {
    // Sync only when the incoming value actually changed — an undo, an agent
    // edit, a different selection. Comparing against our own last step instead
    // would reset it whenever a render landed before the store caught up.
    lastProp.current = value;
    stepped.current = value;
  }

  const commitStep = (direction: number, mods: { shiftKey: boolean; altKey: boolean }) => {
    const next = stepValue(stepped.current, direction, {
      step: step * stepMultiplier(mods), min, max, suffix,
    });
    if (next === null) return;
    stepped.current = next;
    onCommit(next, { coalesce: gesture.current });
  };

  return (
    <div className="number-input">
      <TextInput
        value={value}
        selectOnFocus
        onKey={(e) => {
          const direction = e.key === 'ArrowUp' ? 1 : e.key === 'ArrowDown' ? -1 : 0;
          if (!direction) return false;
          // Only claim the key if the value can actually be stepped; on `auto`
          // or a `calc()` the arrow should still move the caret.
          if (stepValue(stepped.current, direction) === null) return false;
          e.preventDefault();
          commitStep(direction, e);
          return true;
        }}
        onCommit={(v) => {
          const t = evaluateInput(v.trim(), value, suffix).trim();
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
          title="Drag to change · Shift ×10 · Alt ×0.1"
          aria-label="Drag to change value"
          onPointerDown={(e) => {
            e.preventDefault();
            const startX = e.clientX;
            const start = numeric;
            const unit = value.trim().replace(/^-?[\d.]+/, '') || suffix;
            const el = e.currentTarget;
            el.setPointerCapture(e.pointerId);
            el.classList.add('is-scrubbing');

            const move = (ev: PointerEvent) => {
              const amount = step * stepMultiplier(ev);
              let next = start + Math.round((ev.clientX - startX) / 2) * amount;
              if (min !== undefined) next = Math.max(min, next);
              if (max !== undefined) next = Math.min(max, next);
              // One gesture, one undo step — see the store's coalescing.
              onCommit(`${formatNumber(next)}${unit}`, { coalesce: gesture.current });
            };
            const up = () => {
              el.classList.remove('is-scrubbing');
              el.removeEventListener('pointermove', move);
              el.removeEventListener('pointerup', up);
            };
            el.addEventListener('pointermove', move);
            el.addEventListener('pointerup', up);
          }}
        ><Icon name="arrowRight" size={11} /></button>
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

/**
 * A row of mutually exclusive choices.
 *
 * Arrow keys move between options and change the value, and only the selected
 * option is in the tab order — the standard radio-group behaviour. It matters
 * here beyond accessibility: it means alignment, direction and weight can be
 * cycled from the keyboard without leaving the panel.
 */
export function SegmentedControl({ value, options, onCommit }: {
  value: string;
  options: { value: string; label: React.ReactNode; title?: string }[];
  onCommit: (v: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  const move = (delta: number) => {
    const index = options.findIndex((o) => o.value === value);
    // An unrecognised current value starts from the near end rather than
    // jumping to the middle of the row.
    const from = index === -1 ? (delta > 0 ? -1 : options.length) : index;
    const next = options[Math.min(Math.max(from + delta, 0), options.length - 1)];
    if (!next || next.value === value) return;
    onCommit(next.value);
    // Focus follows selection, so a second arrow press continues from here.
    requestAnimationFrame(() => {
      ref.current?.querySelector<HTMLButtonElement>('.is-active')?.focus();
    });
  };

  return (
    <div className="segmented" ref={ref} role="radiogroup">
      {options.map((o) => {
        const active = value === o.value;
        const label = o.title ?? (typeof o.label === 'string' ? o.label : undefined);
        return (
          <button
            key={o.value}
            role="radio"
            className={active ? 'is-active' : ''}
            title={label}
            aria-label={label}
            aria-checked={active}
            tabIndex={active || (!options.some((x) => x.value === value) && o === options[0]) ? 0 : -1}
            onClick={() => onCommit(o.value)}
            onKeyDown={(e) => {
              const delta = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1
                : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
              if (!delta) return;
              e.preventDefault();
              e.stopPropagation();
              move(delta);
            }}
          >
            {o.label}
          </button>
        );
      })}
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
        <TokenPicker tokens={tokens} value={token?.usage ?? ''} onPick={onCommit} />
      )}
    </div>
  );
}

type ColorToken = { name: string; usage: string; resolved: string };

/**
 * Colour tokens with their colours.
 *
 * A native select can only list names, so "color.slate" and "color.ink" had to
 * be told apart from memory. Each row shows the swatch, the name and the value
 * it resolves to, filters as you type, and works from the keyboard.
 */
export function TokenPicker({ tokens, value, onPick, title = 'Use a design token' }: {
  tokens: ColorToken[];
  value: string;
  onPick: (usage: string) => void;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const [at, setAt] = useState<{ top: number; left: number; up: boolean } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const current = tokens.find((t) => t.usage === value);
  const shown = tokens.filter((t) => !q || t.name.toLowerCase().includes(q.toLowerCase()) || t.resolved.toLowerCase().includes(q.toLowerCase()));

  const show = () => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    // Fixed to the viewport: the properties panel scrolls and clips.
    const up = r.bottom + 340 > window.innerHeight && r.top > 340;
    setAt({ top: up ? r.top - 6 : r.bottom + 6, left: Math.max(8, Math.min(r.right - 260, window.innerWidth - 268)), up });
    setQ('');
    setHi(Math.max(0, tokens.findIndex((t) => t.usage === value)));
    setOpen(true);
  };
  const pick = (t: ColorToken | undefined) => { if (t) onPick(t.usage); setOpen(false); btn.current?.focus(); };

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!list.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', close, true);
    return () => window.removeEventListener('pointerdown', close, true);
  }, [open]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('.is-hi')?.scrollIntoView({ block: 'nearest' });
  }, [hi, open]);

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`token-pick${current ? ' has-token' : ''}`}
        title={current ? `${current.name} · ${current.resolved}` : title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : show())}
      >
        {current
          ? <><span className="token-dot" style={{ background: current.resolved }} /><span className="token-pick-name">{current.name.replace(/^color\./, '')}</span></>
          : <span className="token-pick-name">token…</span>}
      </button>
      {open && at && (
        <div
          ref={list}
          className="token-menu"
          style={{ left: at.left, ...(at.up ? { bottom: window.innerHeight - at.top } : { top: at.top }) }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, shown.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
            else if (e.key === 'Enter') { e.preventDefault(); pick(shown[hi]); }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); btn.current?.focus(); }
          }}
        >
          <input
            autoFocus
            className="token-filter"
            placeholder="Find a colour"
            value={q}
            onChange={(e) => { setQ(e.target.value); setHi(0); }}
          />
          <div className="token-list" role="listbox" aria-label="Colour tokens">
            {shown.map((t, i) => (
              <button
                key={t.name}
                type="button"
                role="option"
                aria-selected={t.usage === value}
                className={`token-row${i === hi ? ' is-hi' : ''}${t.usage === value ? ' is-current' : ''}`}
                onPointerEnter={() => setHi(i)}
                onClick={() => pick(t)}
              >
                <span className="token-chip" style={{ background: t.resolved }} />
                <span className="token-name">{t.name.replace(/^color\./, '')}</span>
                <span className="token-value">{t.resolved}</span>
              </button>
            ))}
            {!shown.length && <p className="token-empty">No colour matches “{q}”.</p>}
          </div>
        </div>
      )}
    </>
  );
}

export function Row({ children }: { children: React.ReactNode }) {
  return <div className="prop-row">{children}</div>;
}
