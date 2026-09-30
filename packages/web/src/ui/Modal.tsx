/**
 * The one modal.
 *
 * Five dialogs each drew their own backdrop, and each closed on a click outside
 * and nothing else: Escape did nothing, focus stayed on the button behind the
 * dialog, and the canvas shortcuts kept firing — Backspace in the export sheet
 * deleted the selection. What every dialog needs is the same, so it lives here.
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from './Icon.tsx';

const FOCUSABLE = 'input, textarea, select, button:not([aria-label="Close"]), [href], [tabindex]:not([tabindex="-1"])';

export function Modal({ title, wide, onClose, children }: {
  title: ReactNode;
  wide?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    // The first control, or the dialog itself when there is none: focus has to
    // be inside for Escape and Tab to mean the dialog rather than the canvas.
    const first = ref.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? ref.current)?.focus({ preventScroll: true });
    return () => opener?.focus?.({ preventScroll: true });
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key !== 'Tab' || !ref.current) return;
    // Tab wraps within the dialog, so it cannot wander into the editor behind.
    const items = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE + ', [aria-label="Close"]'))
      .filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (e.shiftKey && (index <= 0)) { e.preventDefault(); items[items.length - 1]!.focus(); }
    else if (!e.shiftKey && index === items.length - 1) { e.preventDefault(); items[0]!.focus(); }
  };

  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div
        ref={ref}
        className={`modal${wide ? ' is-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        tabIndex={-1}
        onPointerDown={(e) => e.stopPropagation()}
        // Capture phase, because several fields inside stop propagation to keep
        // their keys from the canvas, and Escape has to reach the dialog first.
        // Stopped after, so the editor's global shortcuts never see a key typed
        // into a dialog.
        onKeyDownCapture={onKeyDown}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <h2 id="modal-title">{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close" title="Close  Esc"><Icon name="close" size={14} /></button>
        </header>
        <div className="modal-body">
          {children}
        </div>
      </div>
    </div>
  );
}
