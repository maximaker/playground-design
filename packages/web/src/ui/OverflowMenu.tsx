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

  return (
    <div className="overflow-menu" ref={ref} role="menu">
      {items.map((item) => (
        <button
          key={item.label}
          role="menuitem"
          className="context-item"
          onClick={() => { item.run(); onClose(); }}
        >
          <span><Icon name={item.icon} size={14} /> {item.label}</span>
        </button>
      ))}
    </div>
  );
}
