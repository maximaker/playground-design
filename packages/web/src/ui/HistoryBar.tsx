/**
 * History along the bottom of the canvas.
 *
 * It was a rail panel, which put it in the same column as layers and components
 * — things the document *is* — when it is really a record of what has been done
 * to it, and something you glance at rather than work in. A strip along the
 * bottom says the last thing that happened in one line and opens upward when
 * you want the rest, which is the shape of the question people actually ask:
 * "what just changed?", occasionally "and what did it look like on Tuesday?".
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useCanvas } from '../state/store.ts';
import { Icon } from './Icon.tsx';

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

export function HistoryBar() {
  const docId = useCanvas((s) => s.docId);
  const rev = useCanvas((s) => s.rev);
  const toast = useCanvas((s) => s.toast);
  const select = useCanvas((s) => s.select);
  const readOnly = useCanvas((s) => s.readOnly);
  const setHighlight = useCanvas((s) => s.setHighlight);

  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [changes, setChanges] = useState<Changes | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    if (!docId) return;
    // Guarded rather than trusted: a share-link viewer has no document id and no
    // access to these endpoints, and reading `.history` off a 401 body crashed
    // the whole editor for them — a blank page where the design should be.
    const read = async <T,>(path: string, key: string): Promise<T[]> => {
      try {
        const res = await fetch(path);
        if (!res.ok) return [];
        const body = (await res.json()) as Record<string, T[]>;
        return body[key] ?? [];
      } catch {
        return [];
      }
    };
    setEntries(await read<Entry>(`/api/documents/${docId}/history`, 'history'));
    setSnapshots(await read<Snapshot>(`/api/documents/${docId}/snapshots`, 'snapshots'));
  }, [docId]);

  useEffect(() => { void refresh(); }, [refresh, rev]);

  // A comparison is a lens: while one is open the canvas outlines what moved.
  useEffect(() => {
    if (!changes) { setHighlight(null); return; }
    setHighlight({ kind: 'changes', ids: changes.nodes.map((n) => n.id) });
    return () => setHighlight(null);
  }, [changes, setHighlight]);

  // Kept current: a comparison one edit out of date is worse than none,
  // because it looks current.
  useEffect(() => {
    if (!changes || !docId) return;
    void fetch(`/api/documents/${docId}/changes?since=${changes.since.id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((next: Changes | null) => next && setChanges(next))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Nothing to show someone who cannot read the document's history: a viewer
  // arrived through a share link, which grants the design and nothing else.
  if (!docId || readOnly) return null;

  const latest = entries[0];

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
    setOpen(true);
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
    <div className={`history-bar${open ? ' is-open' : ''}`} ref={ref}>
      {open && (
        <div className="history-bar-body">
          <div className="history-bar-columns">
            <section>
              <h4>Versions</h4>
              {!readOnly && (
                <button className="button subtle full" onClick={saveSnapshot}>Save a named version</button>
              )}
              {snapshots.length === 0 && (
                <p className="dim history-hint">
                  A named version is a point to compare against later — mark one before handing work
                  over, and “what changed since” has an answer.
                </p>
              )}
              {snapshots.map((s) => (
                <div key={s.id} className="history-row">
                  <div>
                    <strong>{s.label ?? 'Untitled'}</strong>
                    <span className="dim">rev {s.rev} · {relative(s.ts)}</span>
                  </div>
                  <button className="button subtle" onClick={() => void compare(s)}>Compare</button>
                  {!readOnly && (
                    <button className="button subtle" onClick={() => void restore(s)}>Restore</button>
                  )}
                </div>
              ))}
            </section>

            <section>
              <h4>{changes ? `Since “${changes.since.label ?? 'that version'}”` : 'Changes'}</h4>
              {changes ? (
                changes.same
                  ? <p className="dim history-hint">Nothing has changed since then.</p>
                  : (
                    <>
                      <p className="dim history-hint">
                        {changes.counts.changed} changed · {changes.counts.added} added ·{' '}
                        {changes.counts.removed} removed
                        {changes.tokens.length ? ` · ${changes.tokens.length} token${changes.tokens.length === 1 ? '' : 's'}` : ''}
                        {' '}— outlined on the canvas.
                      </p>
                      {changes.nodes.slice(0, 40).map((n) => (
                        <button key={n.id} className="change-row is-clickable" onClick={() => select([n.id])}>
                          <span className={`change-kind change-${n.kind}`}>{n.kind}</span>
                          <div>
                            <strong>{n.name}</strong>
                            {n.artboard && <span className="dim">{n.artboard.name}</span>}
                            {n.fields.slice(0, 2).map((f) => (
                              <span key={f.field} className="change-field">
                                {f.field.replace(/^styles\./, '')}
                                <code>{f.before ?? '—'}</code>→<code>{f.after ?? '—'}</code>
                              </span>
                            ))}
                            {n.fields.length > 2 && <span className="dim">+{n.fields.length - 2} more</span>}
                          </div>
                        </button>
                      ))}
                      <button className="button subtle" onClick={() => setChanges(null)}>Stop comparing</button>
                    </>
                  )
              ) : (
                <>
                  {entries.length === 0 && <p className="dim history-hint">Nothing yet.</p>}
                  {entries.slice(0, 40).map((e) => (
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
                </>
              )}
            </section>
          </div>
        </div>
      )}

      <button
        className="history-bar-strip"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        title={open ? 'Hide history' : 'Show history and versions'}
      >
        <Icon name="history" size={13} />
        <span className="history-bar-latest">
          {latest
            ? <>
                <strong>{latest.label}</strong>
                <span className="dim">
                  {latest.origin.label ?? (latest.origin.kind === 'human' ? 'You' : latest.origin.kind)}
                  {' · '}{relative(latest.ts)}
                </span>
              </>
            : <span className="dim">No changes yet</span>}
        </span>
        {changes && !changes.same && (
          <span className="history-bar-badge">
            {changes.counts.changed + changes.counts.added + changes.counts.removed} since “{changes.since.label ?? 'a version'}”
          </span>
        )}
        <Icon name={open ? 'chevronDown' : 'chevronUp'} size={12} />
      </button>
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
