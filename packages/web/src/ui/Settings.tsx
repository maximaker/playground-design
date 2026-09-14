/**
 * Appearance controls.
 *
 * Interface scale is here rather than relying on browser zoom because browser
 * zoom scales the canvas too — which is the one thing that must stay at its
 * true size while you are designing.
 */

import { useEffect, useRef } from 'react';
import { type Appearance, type Theme, SCALE_RANGE } from '../state/appearance.ts';
import { Icon, type IconName } from './Icon.tsx';

const THEMES: { value: Theme; icon: IconName; label: string }[] = [
  { value: 'light', icon: 'sun', label: 'Light' },
  { value: 'dark', icon: 'moon', label: 'Dark' },
  { value: 'system', icon: 'contrast', label: 'System' },
];

const DENSITIES = [
  { value: 12, label: 'Compact' },
  { value: 13, label: 'Default' },
  { value: 15, label: 'Roomy' },
];

export function Settings({ appearance, onChange, onClose }: {
  appearance: Appearance;
  onChange: (next: Appearance) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    // Deferred so the click that opened the popover does not immediately close it.
    const id = setTimeout(() => window.addEventListener('pointerdown', onPointer), 0);
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(id);
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div className="settings-popover" ref={ref} role="dialog" aria-label="Appearance">
      <div className="settings-group">
        <span>Theme</span>
        <div className="segmented">
          {THEMES.map((t) => (
            <button
              key={t.value}
              className={appearance.theme === t.value ? 'is-active' : ''}
              onClick={() => onChange({ ...appearance, theme: t.value })}
              title={t.label}
              aria-label={t.label}
              aria-pressed={appearance.theme === t.value}
            >
              <Icon name={t.icon} size={14} />
            </button>
          ))}
        </div>
      </div>

      <div className="settings-group">
        <span>Interface size</span>
        <div className="settings-scale">
          <Icon name="minus" size={12} />
          <input
            type="range"
            min={SCALE_RANGE.min}
            max={SCALE_RANGE.max}
            step={SCALE_RANGE.step}
            value={appearance.scale}
            aria-label="Interface size"
            onChange={(e) => onChange({ ...appearance, scale: Number(e.target.value) })}
          />
          <Icon name="plus" size={14} />
          <output>{Math.round(appearance.scale * 100)}%</output>
        </div>
        <p className="panel-hint" style={{ padding: 0 }}>
          Scales the panels and toolbar only — the canvas keeps its true size, so what you are
          designing stays accurate.
        </p>
      </div>

      <div className="settings-group">
        <span>Density</span>
        <div className="segmented">
          {DENSITIES.map((d) => (
            <button
              key={d.value}
              className={appearance.base === d.value ? 'is-active' : ''}
              onClick={() => onChange({ ...appearance, base: d.value })}
              aria-pressed={appearance.base === d.value}
            >{d.label}</button>
          ))}
        </div>
      </div>
    </div>
  );
}
