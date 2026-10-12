/**
 * Secondary top-bar actions, collapsed into a menu.
 *
 * At phone widths the top bar cannot hold the logo, document name, five
 * controls and two panel toggles — something gets pushed off the edge. The
 * primary action and the panel toggles stay; everything else moves here.
 */

import { useEffect, useRef } from 'react';
import { Icon, type IconName } from './Icon.tsx';

export interface OverflowItem {
  label: string;
  icon: IconName;
  run: () => void;
  disabled?: boolean;
  /** Items with the same group sit together under its heading. */
  group?: string;
}

export function OverflowMenu({ items, onClose }: { items: OverflowItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    // Deferred so the click that opened it does not immediately close it.
    const id = setTimeout(() => window.addEventListener('pointerdown', onPointer), 0);
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(id);
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // Consecutive items of one group share a heading; ungrouped items have none.
  const groups: { name?: string; items: OverflowItem[] }[] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && last.name === item.group) last.items.push(item);
    else groups.push({ name: item.group, items: [item] });
  }

  return (
    <>
      {/* On a phone the menu is a sheet from the bottom, under the thumb; the scrim closes it. */}
      <div className="overflow-scrim" aria-hidden />
      <div className="overflow-menu" ref={ref} role="menu">
        {groups.map((g, i) => (
          <div key={g.name ?? i} className="overflow-group" role="group" aria-label={g.name}>
            {g.name && <div className="overflow-heading">{g.name}</div>}
            {g.items.map((item) => (
              <button
                key={item.label}
                role="menuitem"
                className="context-item"
                disabled={item.disabled}
                onClick={() => { item.run(); onClose(); }}
              >
                <span><Icon name={item.icon} size={14} /> {item.label}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}
