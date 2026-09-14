/**
 * Share links.
 *
 * The document URL is an edit credential — anyone holding it can change the
 * file — so showing work to someone has been all-or-nothing. A share link is a
 * separate, revocable token that only opens a read-only view.
 *
 * The panel is blunt about the difference, because getting it wrong is the kind
 * of mistake you find out about afterwards.
 */

import { useCallback, useEffect, useState } from 'react';
import { useCanvas } from '../state/store.ts';
import { Icon } from '../ui/Icon.tsx';

interface ShareRow {
  token: string;
  role: 'view';
  label: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  url: string;
}

export function Share({ onClose }: { onClose: () => void }) {
  const docId = useCanvas((s) => s.docId);
  const toast = useCanvas((s) => s.toast);

  const [links, setLinks] = useState<ShareRow[]>([]);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [justMade, setJustMade] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!docId) return;
    const res = await fetch(`/api/documents/${docId}/shares`);
    if (!res.ok) return;
    const body = (await res.json()) as { shares: ShareRow[] };
    setLinks(body.shares);
  }, [docId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const create = async () => {
    if (!docId) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/documents/${docId}/shares`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: label.trim() || undefined }),
      });
      const body = (await res.json()) as { url: string };
      setJustMade(body.url);
      setLabel('');
      await copy(body.url);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast('Link copied', 'info');
    } catch {
      toast('Could not reach the clipboard — select the link and copy it.', 'error');
    }
  };

  const revoke = async (token: string) => {
    await fetch(`/api/shares/${token}`, { method: 'DELETE' });
    if (justMade?.endsWith(token)) setJustMade(null);
    await refresh();
  };

  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div className="modal" onPointerDown={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>Share a link</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close"><Icon name="close" size={15} /></button>
        </header>

        <div className="modal-body">
          <p className="modal-lede">
            A share link opens this document <strong>read-only</strong>, live — whoever holds it sees
            changes as they happen but cannot make any. It does not reveal the document’s own URL,
            which is what grants editing.
          </p>

          <div className="connect-create">
            <label className="field is-wide">
              <span className="field-label">What is this link for? (optional)</span>
              <input
                className="input"
                value={label}
                placeholder="e.g. Engineering review"
                onChange={(e) => setLabel(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void create(); e.stopPropagation(); }}
              />
            </label>
            <button className="button primary" onClick={create} disabled={busy}>
              {busy ? 'Creating…' : 'Create link'}
            </button>
          </div>

          {justMade && (
            <div className="code-display">
              <code>{justMade}</code>
              <button className="button" onClick={() => copy(justMade)}>Copy</button>
            </div>
          )}

          {links.length > 0 && (
            <>
              <h3 className="share-heading">Active links</h3>
              <ul className="share-list">
                {links.map((l) => (
                  <li key={l.token}>
                    <div className="share-meta">
                      <strong>{l.label ?? 'View-only link'}</strong>
                      <span className="dim">
                        {l.lastUsedAt ? `opened ${relative(l.lastUsedAt)}` : 'not opened yet'}
                      </span>
                    </div>
                    <button className="button subtle" onClick={() => copy(l.url)}>Copy</button>
                    <button
                      className="button subtle"
                      title="Stop this link working, for everyone who has it"
                      onClick={() => revoke(l.token)}
                    >Revoke</button>
                  </li>
                ))}
              </ul>
            </>
          )}

          <p className="panel-hint">
            Anyone with a link can view. There are no accounts yet, so revoking is the only way to
            take access back — and it takes effect immediately, for everyone holding that link.
          </p>
        </div>
      </div>
    </div>
  );
}

function relative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
