/**
 * Version history.
 *
 * Shows the op log collapsed into batch-level entries, attributed to whoever
 * made the change — the reason agent writes are wrapped in labeled transactions
 * is so this panel can say "Claude Code added 12 layers" instead of showing an
 * anonymous diff.
 */

import { useCallback, useEffect, useState } from 'react';
import { useCanvas } from '../state/store.ts';
import { Icon } from '../ui/Icon.tsx';

interface Entry {
  rev: number; label: string; opCount: number; ts: number;
  origin: { kind: string; id: string; label?: string };
}

interface Snapshot { id: string; rev: number; label: string | null; ts: number }

export function History() {
  const docId = useCanvas((s) => s.docId);
  const rev = useCanvas((s) => s.rev);
  const toast = useCanvas((s) => s.toast);

  const [entries, setEntries] = useState<Entry[]>([]);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);

  const refresh = useCallback(async () => {
    if (!docId) return;
    const [h, s] = await Promise.all([
      fetch(`/api/documents/${docId}/history`).then((r) => r.json() as Promise<{ history: Entry[] }>),
      fetch(`/api/documents/${docId}/snapshots`).then((r) => r.json() as Promise<{ snapshots: Snapshot[] }>),
    ]);
    setEntries(h.history);
    setSnapshots(s.snapshots);
  }, [docId]);

  useEffect(() => { void refresh(); }, [refresh, rev]);

  const saveSnapshot = async () => {
    const label = window.prompt('Name this version', `Version ${snapshots.length + 1}`);
    if (!label || !docId) return;
    await fetch(`/api/documents/${docId}/snapshots`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label }),
    });
    toast('Version saved', 'success');
    await refresh();
  };

  const restore = async (snapshot: Snapshot) => {
    if (!docId) return;
    const ok = window.confirm(
      `Restore "${snapshot.label ?? 'this version'}"? Current work is kept in history and this restore is itself undoable.`,
    );
    if (!ok) return;
    await fetch(`/api/documents/${docId}/snapshots/${snapshot.id}/restore`, { method: 'POST' });
    toast('Version restored', 'success');
  };

  return (
    <div className="history">
      <button className="button subtle full" onClick={saveSnapshot}>Save a named version</button>

      {snapshots.length > 0 && (
        <div className="history-group">
          <h4>Versions</h4>
          {snapshots.map((s) => (
            <div key={s.id} className="history-row">
              <div>
                <strong>{s.label ?? 'Untitled'}</strong>
                <span className="dim">rev {s.rev} · {relative(s.ts)}</span>
              </div>
              <button className="button subtle" onClick={() => restore(s)}>Restore</button>
            </div>
          ))}
        </div>
      )}

      <div className="history-group">
        <h4>Changes</h4>
        {entries.length === 0 && <p className="panel-empty dim">Nothing yet.</p>}
        {entries.map((e) => (
          <div key={e.rev} className={`history-entry origin-${e.origin.kind}`}>
            <span className="history-origin">
              <Icon
                name={e.origin.kind === 'agent' ? 'agent' : e.origin.kind === 'system' ? 'settings' : 'edit'}
                size={12}
              />
            </span>
            <div>
              <strong>{e.label}</strong>
              {e.opCount > 1 && <span className="dim"> ({e.opCount} ops)</span>}
              <span className="dim">
                {e.origin.label ?? (e.origin.kind === 'human' ? 'You' : e.origin.kind)} · {relative(e.ts)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function relative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}
