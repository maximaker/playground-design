/**
 * Visual gradient editor.
 *
 * Reads whatever CSS is already there — including gradients typed by hand,
 * pasted, or imported from a live page — and writes valid CSS back, so it never
 * becomes the only way to author one.
 */

import { useMemo, useState } from 'react';
import {
  type Gradient, type GradientType,
  DEFAULT_GRADIENT, parseGradient, serializeGradient,
} from '@canvas/shared';
import { TextInput } from './controls.tsx';

interface Props {
  value: string;
  onCommit: (value: string) => void;
  tokens?: { name: string; usage: string; resolved: string }[];
}

const TYPES: { value: GradientType; label: string }[] = [
  { value: 'linear', label: 'Linear' },
  { value: 'radial', label: 'Radial' },
  { value: 'conic', label: 'Conic' },
];

export function GradientEditor({ value, onCommit, tokens }: Props) {
  const parsed = useMemo(() => parseGradient(value), [value]);
  const [selected, setSelected] = useState(0);

  if (!parsed) {
    return (
      <div className="gradient-empty">
        <TextInput value={value} onCommit={onCommit} placeholder="linear-gradient(…) or url(…)" mono />
        <button className="button subtle full" onClick={() => onCommit(serializeGradient(DEFAULT_GRADIENT))}>
          + Add a gradient
        </button>
      </div>
    );
  }

  const update = (next: Gradient) => onCommit(serializeGradient(next));
  const stops = [...parsed.stops].sort((a, b) => a.position - b.position);
  const active = stops[Math.min(selected, stops.length - 1)];

  const setStop = (index: number, patch: Partial<{ color: string; position: number }>) => {
    update({ ...parsed, stops: stops.map((s, i) => (i === index ? { ...s, ...patch } : s)) });
  };

  const addStop = (position: number) => {
    // New stops take the colour already showing at that position, so adding one
    // never changes how the gradient looks until it is moved.
    const before = [...stops].reverse().find((s) => s.position <= position) ?? stops[0]!;
    update({ ...parsed, stops: [...stops, { color: before.color, position }] });
    setSelected(stops.filter((s) => s.position < position).length);
  };

  return (
    <div className="gradient-editor">
      <div className="gradient-types">
        {TYPES.map((t) => (
          <button
            key={t.value}
            className={parsed.type === t.value ? 'is-active' : ''}
            onClick={() => update({ ...parsed, type: t.value })}
          >{t.label}</button>
        ))}
        <button
          className={parsed.repeating ? 'is-active' : ''}
          title="Repeating"
          onClick={() => update({ ...parsed, repeating: !parsed.repeating })}
        >↻</button>
      </div>

      <div
        className="gradient-track"
        style={{ background: serializeGradient({ ...parsed, type: 'linear', angle: 90, repeating: false }) }}
        onDoubleClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          addStop(Math.round(((e.clientX - rect.left) / rect.width) * 100));
        }}
        title="Double-click to add a stop"
      >
        {stops.map((stop, i) => (
          <button
            key={i}
            className={`gradient-stop${i === selected ? ' is-active' : ''}`}
            style={{ left: `${stop.position}%`, background: stop.color }}
            onPointerDown={(e) => {
              e.stopPropagation();
              setSelected(i);
              const track = e.currentTarget.parentElement!.getBoundingClientRect();
              const el = e.currentTarget;
              el.setPointerCapture(e.pointerId);
              const move = (ev: PointerEvent) => {
                const pct = Math.max(0, Math.min(100, ((ev.clientX - track.left) / track.width) * 100));
                setStop(i, { position: Math.round(pct) });
              };
              const up = () => {
                el.removeEventListener('pointermove', move);
                el.removeEventListener('pointerup', up);
              };
              el.addEventListener('pointermove', move);
              el.addEventListener('pointerup', up);
            }}
          />
        ))}
      </div>

      {active && (
        <div className="gradient-stop-editor">
          <label className="swatch" style={{ background: active.color }}>
            <input
              type="color"
              value={/^#[0-9a-f]{6}$/i.test(active.color) ? active.color : '#000000'}
              onChange={(e) => setStop(selected, { color: e.target.value })}
            />
          </label>
          <TextInput value={active.color} onCommit={(color) => setStop(selected, { color })} mono />
          <input
            className="input gradient-position"
            type="number"
            min={0}
            max={100}
            value={Math.round(active.position)}
            onChange={(e) => setStop(selected, { position: Number(e.target.value) })}
          />
          {tokens && tokens.length > 0 && (
            <select
              className="token-pick"
              title="Use a token"
              value=""
              onChange={(e) => e.target.value && setStop(selected, { color: e.target.value })}
            >
              <option value="">token…</option>
              {tokens.map((t) => <option key={t.name} value={t.usage}>{t.name}</option>)}
            </select>
          )}
          <button
            className="icon-button"
            title="Remove this stop"
            disabled={stops.length <= 2}
            onClick={() => {
              update({ ...parsed, stops: stops.filter((_, i) => i !== selected) });
              setSelected(0);
            }}
          >✕</button>
        </div>
      )}

      {parsed.type !== 'radial' && (
        <div className="gradient-angle">
          <span className="field-label">Angle</span>
          <input
            type="range"
            min={0}
            max={360}
            value={Math.round(parsed.angle)}
            onChange={(e) => update({ ...parsed, angle: Number(e.target.value) })}
          />
          <span className="gradient-angle-value">{Math.round(parsed.angle)}°</span>
        </div>
      )}

      {parsed.type === 'radial' && (
        <TextInput
          value={parsed.shape ?? ''}
          placeholder="circle at center"
          onCommit={(shape) => update({ ...parsed, shape: shape || undefined })}
          mono
        />
      )}

      <button className="button subtle full" onClick={() => onCommit('')}>Remove gradient</button>
    </div>
  );
}
