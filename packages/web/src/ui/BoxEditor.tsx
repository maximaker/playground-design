/**
 * The box model, drawn and editable.
 *
 * Padding was a single text field taking "16px or 8px 16px", which asks the
 * person to hold the CSS shorthand's clock-face ordering in their head, and
 * margin had no control at all — it could only be reached by nudging a layer
 * in flex flow and hoping. Both are spatial properties, and the fastest way to
 * say "more space above this" is to point at the space above it.
 *
 * So: the devtools diagram, with every number editable in place and draggable
 * like every other number in the inspector. The rings are drawn in neutral
 * greys rather than devtools' orange and green, because in this interface
 * those colours already mean brand and state.
 */

import { useRef, useState } from 'react';
import { Icon } from './Icon.tsx';

export interface BoxValues {
  margin: string;
  padding: string;
  /** Measured content box, when the canvas could supply one. */
  size?: { width: number; height: number };
}

type Side = 'top' | 'right' | 'bottom' | 'left';
const SIDES: Side[] = ['top', 'right', 'bottom', 'left'];

/**
 * Split a shorthand on top-level whitespace.
 *
 * Not `value.split(/\s+/)`: `var(--space-4)` survives that, but
 * `calc(2px + 1rem)` does not, and a splitter that mangles one value in ten is
 * worse than no splitter at all.
 */
export function splitSides(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of value.trim()) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (current) out.push(current);
      current = '';
    } else current += ch;
  }
  if (current) out.push(current);
  return out;
}

/** The CSS clock face: 1 value is all, 2 is vertical/horizontal, 3 adds bottom. */
export function sidesOf(value: string): Record<Side, string> {
  const p = splitSides(value || '');
  if (p.length === 0) return { top: '', right: '', bottom: '', left: '' };
  if (p.length === 1) return { top: p[0]!, right: p[0]!, bottom: p[0]!, left: p[0]! };
  if (p.length === 2) return { top: p[0]!, right: p[1]!, bottom: p[0]!, left: p[1]! };
  if (p.length === 3) return { top: p[0]!, right: p[1]!, bottom: p[2]!, left: p[1]! };
  return { top: p[0]!, right: p[1]!, bottom: p[2]!, left: p[3]! };
}

/** Back to the shortest shorthand that says the same thing. */
export function shorthandOf(sides: Record<Side, string>): string {
  const v = (s: Side) => sides[s] || '0';
  if (v('top') === v('right') && v('right') === v('bottom') && v('bottom') === v('left')) {
    return v('top') === '0' ? '' : v('top');
  }
  if (v('top') === v('bottom') && v('left') === v('right')) return `${v('top')} ${v('right')}`;
  if (v('left') === v('right')) return `${v('top')} ${v('right')} ${v('bottom')}`;
  return `${v('top')} ${v('right')} ${v('bottom')} ${v('left')}`;
}

export function BoxEditor({ values, onCommit, disabled }: {
  values: BoxValues;
  onCommit: (prop: 'margin' | 'padding', value: string, opts?: { coalesce?: string }) => void;
  disabled?: boolean;
}) {
  // Linked is the common case — a card has one padding, not four — but it is a
  // preference rather than a state of the document, so it is not stored in it.
  const [linked, setLinked] = useState({ margin: true, padding: true });

  const edit = (prop: 'margin' | 'padding') => (side: Side, next: string, opts?: { coalesce?: string }) => {
    const sides = sidesOf(values[prop]);
    const updated = linked[prop]
      ? { top: next, right: next, bottom: next, left: next }
      : { ...sides, [side]: next };
    onCommit(prop, shorthandOf(updated), opts);
  };

  const margin = sidesOf(values.margin);
  const padding = sidesOf(values.padding);

  return (
    <div className={`box-editor${disabled ? ' is-disabled' : ''}`}>
      <div className="box-ring is-margin">
        <span className="box-ring-label">margin</span>
        <LinkToggle
          on={linked.margin}
          onToggle={() => setLinked((l) => ({ ...l, margin: !l.margin }))}
          what="margin"
        />
        {SIDES.map((side) => (
          <BoxField
            key={side} side={side} value={margin[side]}
            onCommit={(v, o) => edit('margin')(side, v, o)}
            disabled={disabled}
            label={`Margin ${side}`}
          />
        ))}

        <div className="box-ring is-padding">
          <span className="box-ring-label">padding</span>
          <LinkToggle
            on={linked.padding}
            onToggle={() => setLinked((l) => ({ ...l, padding: !l.padding }))}
            what="padding"
          />
          {SIDES.map((side) => (
            <BoxField
              key={side} side={side} value={padding[side]}
              onCommit={(v, o) => edit('padding')(side, v, o)}
              disabled={disabled}
              label={`Padding ${side}`}
            />
          ))}

          <div className="box-content">
            {values.size
              ? `${Math.round(values.size.width)} × ${Math.round(values.size.height)}`
              : 'content'}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Editing all four sides at once, which is what a card's padding usually is. */
function LinkToggle({ on, onToggle, what }: { on: boolean; onToggle: () => void; what: string }) {
  return (
    <button
      className={`box-link${on ? ' is-on' : ''}`}
      onClick={onToggle}
      aria-pressed={on}
      title={on ? `All four sides of ${what} together` : `Each side of ${what} on its own`}
      aria-label={on ? `${what}: all sides together` : `${what}: sides separately`}
    ><Icon name={on ? 'link' : 'unlink'} size={10} /></button>
  );
}

/**
 * One number in the diagram.
 *
 * A span until you touch it, an input once you do: four inputs per ring with
 * their own borders would out-draw the diagram they sit in, and the diagram is
 * the thing that makes this readable.
 */
function BoxField({ side, value, onCommit, disabled, label }: {
  side: Side;
  value: string;
  onCommit: (value: string, opts?: { coalesce?: string }) => void;
  disabled?: boolean;
  label: string;
}) {
  const [editing, setEditing] = useState(false);
  const gesture = useRef(`box:${Math.random().toString(36).slice(2)}`);
  const shown = display(value);

  if (editing && !disabled) {
    return (
      <input
        className={`box-field is-${side} is-editing`}
        defaultValue={value}
        autoFocus
        aria-label={label}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => { commit(e.currentTarget.value); setEditing(false); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { commit(e.currentTarget.value); setEditing(false); }
          if (e.key === 'Escape') setEditing(false);
          e.stopPropagation();
        }}
      />
    );
  }

  return (
    <button
      className={`box-field is-${side}`}
      disabled={disabled}
      aria-label={label}
      title={`${label}${value ? `: ${value}` : ''} — click to type, drag to change`}
      onDoubleClick={() => setEditing(true)}
      onPointerDown={(e) => {
        if (disabled || e.button !== 0) return;
        const startX = e.clientX;
        const startY = e.clientY;
        const start = parseFloat(value) || 0;
        const unit = value.trim().replace(/^-?[\d.]+/, '') || 'px';
        const el = e.currentTarget;
        let dragged = false;
        el.setPointerCapture(e.pointerId);

        const move = (ev: PointerEvent) => {
          // Vertical sides read vertically: dragging down on the top edge is
          // the same direction as the space it is describing growing.
          const delta = side === 'top' || side === 'bottom'
            ? ev.clientY - startY
            : ev.clientX - startX;
          const signed = side === 'top' || side === 'left' ? -delta : delta;
          if (!dragged && Math.abs(delta) < 3) return;
          dragged = true;
          el.classList.add('is-scrubbing');
          const amount = ev.shiftKey ? 10 : 1;
          const next = Math.max(0, start + Math.round(signed / 2) * amount);
          onCommit(`${next}${unit === '%' ? '%' : 'px'}`, { coalesce: gesture.current });
        };
        const up = () => {
          el.classList.remove('is-scrubbing');
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          // A click that never moved is a request to type, not a nil drag.
          if (!dragged) setEditing(true);
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
      }}
    >{shown}</button>
  );

  function commit(next: string) {
    const t = next.trim();
    if (!t) return onCommit('0');
    onCommit(/^-?[\d.]+$/.test(t) ? `${t}px` : t);
  }
}

/** `16px` reads as `16`; a token or a calc keeps its own spelling, shortened. */
function display(value: string): string {
  const v = (value || '').trim();
  if (!v || v === '0' || v === '0px') return '0';
  const px = /^(-?[\d.]+)px$/.exec(v);
  if (px) return px[1]!;
  const token = /^var\(\s*--([\w-]+)\s*\)$/.exec(v);
  if (token) return token[1]!.replace(/^space-/, '');
  return v.length > 6 ? `${v.slice(0, 5)}…` : v;
}
