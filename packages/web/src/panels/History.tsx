/**
 * Version history, and what has changed since a version.
 *
 * Shows the op log collapsed into batch-level entries, attributed to whoever
 * made the change — the reason agent writes are wrapped in labeled transactions
 * is so this panel can say "Claude Code added 12 layers" instead of showing an
 * anonymous diff.
 *
 * A saved version doubles as a handover checkpoint: "compare" answers the
 * question a developer actually has, which is not what the design is but what
 * moved after they started building it.
 */

import { useCallback, useEffect, useState } from 'react';
import { useCanvas } from '../state/store.ts';
import { Icon } from '../ui/Icon.tsx';

interface Entry {
  rev: number; label: string; opCount: number; ts: number;
  origin: { kind: string; id: string; label?: string };
}

interface Snapshot { id: string; rev: number; label: string | null; ts: number }

interface FieldChange { field: string; before?: string; after?: string }
interface NodeChange {
  id: string; kind: 'added' | 'removed' | 'changed'; name: string; type: string;
  artboard?: { id: string; name: string }; fields: FieldChange[];
}
interface Changes {
  since: { id: string; label: string | null };
  same: boolean;
  counts: { added: number; removed: number; changed: number };
  nodes: NodeChange[];
  byArtboard: { id: string | null; name: string; changes: number }[];
  tokens: FieldChange[];
}

export function History() {
  const docId = useCanvas((s) => s.docId);
  const rev = useCanvas((s) => s.rev);
  const toast = useCanvas((s) => s.toast);

  const [entries, setEntries] = useState<Entry[]>([]);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [changes, setChanges] = useState<Changes | null>(null);
  const select = useCanvas((s) => s.select);

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

  const compare = async (snapshot: Snapshot) => {
    if (!docId) return;
    const res = await fetch(`/api/documents/${docId}/changes?since=${snapshot.id}`);
    if (!res.ok) { toast('Could not compare with that version', 'error'); return; }
    setChanges(await res.json() as Changes);
  };

  // Recomputed whenever the document moves: a comparison that is one edit out
  // of date is worse than none, because it looks current.
  useEffect(() => {
    if (!changes || !docId) return;
    void fetch(`/api/documents/${docId}/changes?since=${changes.since.id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((next: Changes | null) => next && setChanges(next))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev]);

  // A comparison is a lens too: while one is open the canvas outlines what
  // moved, so "6 changes on Landing — 1440" is somewhere you can look rather
  // than a number.
  const setHighlight = useCanvas((s) => s.setHighlight);
  useEffect(() => {
    if (!changes) { setHighlight(null); return; }
    setHighlight({ kind: 'changes', ids: changes.nodes.map((n) => n.id) });
    return () => setHighlight(null);
  }, [changes, setHighlight]);

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
              <button
                className="button subtle"
                title="What has changed since this version"
                onClick={() => void compare(s)}
              >Compare</button>
              <button className="button subtle" onClick={() => restore(s)}>Restore</button>
            </div>
          ))}
        </div>
      )}

      {changes && (
        <div className="history-group changes">
          <div className="changes-head">
            <h4>Since “{changes.since.label ?? 'that version'}”</h4>
            <button className="icon-button" aria-label="Close comparison" onClick={() => setChanges(null)}>
              <Icon name="close" size={12} />
            </button>
          </div>

          {changes.same ? (
            <p className="panel-empty dim">Nothing has changed since then.</p>
          ) : (
            <>
              <p className="changes-counts dim">
                {changes.counts.changed} changed · {changes.counts.added} added · {changes.counts.removed} removed
                {changes.tokens.length ? ` · ${changes.tokens.length} token${changes.tokens.length === 1 ? '' : 's'}` : ''}
              </p>

              {changes.byArtboard.length > 1 && (
                <p className="changes-boards dim">
                  {changes.byArtboard.map((b) => `${b.name}: ${b.changes}`).join(' · ')}
                </p>
              )}

              {changes.tokens.map((t) => (
                <div key={t.field} className="change-row">
                  <span className="change-kind change-token">token</span>
                  <div>
                    <strong>{t.field}</strong>
                    <span className="dim">{t.before ?? '—'} → {t.after ?? 'removed'}</span>
                  </div>
                </div>
              ))}

              {changes.nodes.map((n) => (
                <button key={n.id} className="change-row is-clickable" onClick={() => select([n.id])}>
                  <span className={`change-kind change-${n.kind}`}>{n.kind}</span>
                  <div>
                    <strong>{n.name}</strong>
                    {n.artboard && <span className="dim">{n.artboard.name}</span>}
                    {/* Three at most: a node with fifteen changed declarations
                        is a rewrite, and listing them is not how anyone reads
                        that. The Spec panel has the full picture. */}
                    {n.fields.slice(0, 3).map((f) => (
                      <span key={f.field} className="change-field">
                        {f.field.replace(/^styles\./, '')}
                        <code>{f.before ?? '—'}</code>→<code>{f.after ?? '—'}</code>
                      </span>
                    ))}
                    {n.fields.length > 3 && <span className="dim">+{n.fields.length - 3} more</span>}
                  </div>
                </button>
              ))}
            </>
          )}
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
