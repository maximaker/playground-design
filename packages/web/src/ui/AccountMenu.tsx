/**
 * The signed-in person, and the way out.
 *
 * An avatar rather than a name in the bar: the topbar is already full at
 * 820px, and the avatar carries the person's presence colour — the same colour
 * their cursor has in the document, so the two read as the same person.
 */

import { useEffect, useRef, useState } from 'react';
import { type Account, signOut } from '../state/session.ts';
import { Icon } from './Icon.tsx';

export function initials(name: string): string {
  const parts = name.trim().split(/[\s@._-]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

export function Avatar({ name, color, size = 22, title }: {
  name: string; color: string; size?: number; title?: string;
}) {
  return (
    <span
      className="avatar-chip"
      style={{ background: color, width: size, height: size, fontSize: size * 0.42 }}
      title={title ?? name}
      aria-hidden
    >{initials(name)}</span>
  );
}

export function AccountMenu({ user, onSignedOut }: {
  user: Account;
  onSignedOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const id = setTimeout(() => window.addEventListener('pointerdown', onPointer), 0);
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(id);
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="account-menu" ref={ref}>
      <button
        className="account-button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`Account — ${user.name}`}
        title={`${user.name} · ${user.email}`}
      >
        <Avatar name={user.name} color={user.color} />
      </button>

      {open && (
        <div className="account-popover" role="dialog" aria-label="Account">
          <div className="account-identity">
            <Avatar name={user.name} color={user.color} size={32} />
            <div>
              <strong>{user.name}</strong>
              <span className="dim">{user.email}</span>
            </div>
          </div>
          <button
            className="account-item"
            onClick={async () => { await signOut(); onSignedOut(); }}
          >
            <Icon name="logout" size={14} /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}
