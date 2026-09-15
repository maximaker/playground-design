/**
 * Appearance controls.
 *
 * Interface scale is here rather than relying on browser zoom because browser
 * zoom scales the canvas too — which is the one thing that must stay at its
 * true size while you are designing.
 */

import { useEffect, useRef } from 'react';
import { type Appearance, type Theme, SCALE_RANGE } from '../state/appearance.ts';
import type { CanvasPrefs } from '../state/canvasPrefs.ts';
import { useCanvas } from '../state/store.ts';
import { Icon, type IconName } from './Icon.tsx';

const CANVAS_TOGGLES: { key: keyof CanvasPrefs; label: string; hint: string }[] = [
  { key: 'grid', label: 'Dot grid', hint: 'The dotted background under the artboards.' },
  { key: 'rulers', label: 'Rulers', hint: 'Pixel rulers along the top and left edges.' },
  { key: 'snap', label: 'Snapping', hint: 'Dragging catches on edges and centres. Hold ⌘ to suspend it for one drag.' },
];

const THEMES: { value: Theme; icon: IconName; label: string }[] = [
  { value: 'light', icon: 'sun', label: 'Light' },
  { value: 'dark', icon: 'moon', label: 'Dark' },
  { value: 'system', icon: 'contrast', label: 'System' },
];

/**
 * One step of the scale, rounded onto the step grid.
 *
 * Floating point turns 0.85 + 0.05 into 0.8999999999999999, which then shows as
 * 90% here and never lands on a round number again.
 */
function step(scale: number, direction: 1 | -1): number {
  const next = scale + direction * SCALE_RANGE.step;
  const snapped = Math.round(next / SCALE_RANGE.step) * SCALE_RANGE.step;
  return Math.min(SCALE_RANGE.max, Math.max(SCALE_RANGE.min, Number(snapped.toFixed(2))));
}

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
  // Canvas preferences live in the canvas store rather than in `appearance`:
  // the canvas and its drag handlers read them, and neither has the appearance
  // prop threaded through it.
  const canvasPrefs = useCanvas((s) => s.canvasPrefs);
  const setCanvasPrefs = useCanvas((s) => s.setCanvasPrefs);

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
          {/*
            * These were decorative glyphs, which is worse than not having them:
            * a minus beside a slider reads as a control, and clicking it did
            * nothing. Stepping is also the only way to hit an exact value with
            * a keyboard or an unsteady hand.
            */}
          <button
            className="icon-button"
            title="Smaller interface"
            aria-label="Smaller interface"
            disabled={appearance.scale <= SCALE_RANGE.min}
            onClick={() => onChange({ ...appearance, scale: step(appearance.scale, -1) })}
          ><Icon name="minus" size={12} /></button>
          <input
            type="range"
            min={SCALE_RANGE.min}
            max={SCALE_RANGE.max}
            step={SCALE_RANGE.step}
            value={appearance.scale}
            aria-label="Interface size"
            onChange={(e) => onChange({ ...appearance, scale: Number(e.target.value) })}
          />
          <button
            className="icon-button"
            title="Larger interface"
            aria-label="Larger interface"
            disabled={appearance.scale >= SCALE_RANGE.max}
            onClick={() => onChange({ ...appearance, scale: step(appearance.scale, 1) })}
          ><Icon name="plus" size={14} /></button>
          <output>{Math.round(appearance.scale * 100)}%</output>
        </div>
        <p className="panel-hint" style={{ padding: 0 }}>
          Scales the panels and toolbar only — the canvas keeps its true size, so what you are
          designing stays accurate.
        </p>
      </div>

      <div className="settings-group">
        <span>Canvas</span>
        <div className="settings-toggles">
          {CANVAS_TOGGLES.map((t) => (
            <button
              key={t.key}
              className="settings-toggle"
              aria-pressed={canvasPrefs[t.key]}
              onClick={() => setCanvasPrefs({ [t.key]: !canvasPrefs[t.key] })}
            >
              <span>
                {t.label}
                <span className="toggle-hint">{t.hint}</span>
              </span>
              <span className="switch" />
            </button>
          ))}
        </div>
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
