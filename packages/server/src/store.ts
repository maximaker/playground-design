/**
 * Document store.
 *
 * The server is the authority: it serializes ops, assigns revisions, and
 * broadcasts. Clients apply optimistically and reconcile against the revision
 * they get back. This is a deliberate simplification over a CRDT for v1 — see
 * README "Deviations from the PRD".
 */

import {
  type CanvasDocument, type Op, type OpEnvelope,
  applyOp, createEmptyDocument, newId,
} from '@canvas/shared';
import { db, now } from './db.ts';

export interface AppliedOp extends OpEnvelope {
  rev: number;
  inverse: Op;
  ts: number;
}

type Listener = (ops: AppliedOp[]) => void;

const cache = new Map<string, CanvasDocument>();
const listeners = new Map<string, Set<Listener>>();
const dirty = new Set<string>();

// Persist on a short timer rather than per-op: a drag produces dozens of ops a
// second and each one would otherwise rewrite the whole document JSON.
const FLUSH_MS = 400;
setInterval(flushAll, FLUSH_MS).unref?.();

export function flushAll(): void {
  for (const id of [...dirty]) {
    const doc = cache.get(id);
    if (!doc) { dirty.delete(id); continue; }
    db.prepare('UPDATE documents SET data = ?, rev = ?, name = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(doc), doc.rev, doc.name, now(), id);
    dirty.delete(id);
  }
}

process.on('exit', flushAll);
process.on('SIGINT', () => { flushAll(); process.exit(0); });
process.on('SIGTERM', () => { flushAll(); process.exit(0); });

// ---------------------------------------------------------------------------

export function createDocument(name = 'Untitled', seed?: CanvasDocument): CanvasDocument {
  const doc = seed ?? createEmptyDocument(name);
  doc.name = name;
  const t = now();
  db.prepare('INSERT INTO documents (id, name, data, rev, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(doc.id, doc.name, JSON.stringify(doc), doc.rev, t, t);
  cache.set(doc.id, doc);
  return doc;
}

export function listDocuments(): { id: string; name: string; rev: number; updated_at: number; nodeCount: number }[] {
  const rows = db.prepare('SELECT id, name, rev, updated_at, data FROM documents ORDER BY updated_at DESC').all() as
    { id: string; name: string; rev: number; updated_at: number; data: string }[];
  return rows.map((r) => {
    const cached = cache.get(r.id);
    const nodeCount = cached
      ? Object.keys(cached.nodes).length
      : Object.keys((JSON.parse(r.data) as CanvasDocument).nodes).length;
    return { id: r.id, name: cached?.name ?? r.name, rev: cached?.rev ?? r.rev, updated_at: r.updated_at, nodeCount };
  });
}

export function getDocument(id: string): CanvasDocument | null {
  const cached = cache.get(id);
  if (cached) return cached;
  const row = db.prepare('SELECT data FROM documents WHERE id = ?').get(id) as { data: string } | undefined;
  if (!row) return null;
  const doc = JSON.parse(row.data) as CanvasDocument;
  cache.set(id, doc);
  return doc;
}

export function deleteDocument(id: string): boolean {
  const res = db.prepare('DELETE FROM documents WHERE id = ?').run(id);
  cache.delete(id);
  dirty.delete(id);
  return res.changes > 0;
}

export class StoreError extends Error {}

/**
 * Applies a batch of ops atomically: if any op throws, the document is rolled
 * back to its pre-batch state and nothing is broadcast.
 */
export function applyOps(docId: string, envelopes: OpEnvelope[]): AppliedOp[] {
  const doc = getDocument(docId);
  if (!doc) throw new StoreError(`document ${docId} not found`);
  if (envelopes.length === 0) return [];

  const rollback = structuredClone(doc);
  const applied: AppliedOp[] = [];
  const ts = now();

  try {
    for (const env of envelopes) {
      const inverse = applyOp(doc, env.op);
      doc.rev += 1;
      applied.push({ ...env, inverse, rev: doc.rev, ts });
    }
  } catch (err) {
    // Restore in place so any handle already held by a caller stays valid.
    Object.assign(doc, rollback);
    cache.set(docId, doc);
    throw new StoreError(err instanceof Error ? err.message : String(err));
  }

  const insert = db.prepare(
    'INSERT INTO ops (doc_id, rev, op, inverse, origin, batch, ts) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (const a of applied) {
    insert.run(docId, a.rev, JSON.stringify(a.op), JSON.stringify(a.inverse), JSON.stringify(a.origin), a.batch ?? null, ts);
  }

  dirty.add(docId);
  broadcast(docId, applied);
  return applied;
}

export function subscribe(docId: string, fn: Listener): () => void {
  let set = listeners.get(docId);
  if (!set) { set = new Set(); listeners.set(docId, set); }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) listeners.delete(docId);
  };
}

function broadcast(docId: string, ops: AppliedOp[]): void {
  const set = listeners.get(docId);
  if (!set) return;
  for (const fn of set) {
    try { fn(ops); } catch { /* a broken subscriber must not fail the write */ }
  }
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export function opsSince(docId: string, rev: number, limit = 1000): AppliedOp[] {
  const rows = db.prepare(
    'SELECT rev, op, inverse, origin, batch, ts FROM ops WHERE doc_id = ? AND rev > ? ORDER BY rev ASC LIMIT ?',
  ).all(docId, rev, limit) as { rev: number; op: string; inverse: string; origin: string; batch: string | null; ts: number }[];
  return rows.map((r) => ({
    rev: r.rev,
    op: JSON.parse(r.op) as Op,
    inverse: JSON.parse(r.inverse) as Op,
    origin: JSON.parse(r.origin) as OpEnvelope['origin'],
    batch: r.batch ?? undefined,
    ts: r.ts,
  }));
}

export interface HistoryEntry {
  rev: number;
  label: string;
  origin: OpEnvelope['origin'];
  batch?: string;
  ts: number;
  opCount: number;
}

/** Op log collapsed into human-readable, batch-level entries. */
export function history(docId: string, limit = 100): HistoryEntry[] {
  const rows = db.prepare(
    'SELECT rev, op, origin, batch, ts FROM ops WHERE doc_id = ? ORDER BY rev DESC LIMIT ?',
  ).all(docId, limit * 4) as { rev: number; op: string; origin: string; batch: string | null; ts: number }[];

  const out: HistoryEntry[] = [];
  for (const r of rows) {
    const op = JSON.parse(r.op) as Op;
    const origin = JSON.parse(r.origin) as OpEnvelope['origin'];
    const prev = out[out.length - 1];
    if (prev && r.batch && prev.batch === r.batch) {
      prev.opCount += 1;
      prev.rev = Math.max(prev.rev, r.rev);
      continue;
    }
    out.push({ rev: r.rev, label: describeOp(op), origin, batch: r.batch ?? undefined, ts: r.ts, opCount: 1 });
    if (out.length >= limit) break;
  }
  return out;
}

function describeOp(op: Op): string {
  switch (op.t) {
    case 'insert': return `Added ${op.nodes.length} ${op.nodes.length === 1 ? 'layer' : 'layers'}`;
    case 'remove': return `Deleted ${op.ids.length} ${op.ids.length === 1 ? 'layer' : 'layers'}`;
    case 'styles': return `Restyled ${op.updates.length} ${op.updates.length === 1 ? 'layer' : 'layers'}`;
    case 'text': return 'Edited text';
    case 'rename': return 'Renamed layer';
    case 'attrs': return 'Changed attributes';
    case 'meta': return 'Toggled visibility or lock';
    case 'move': return `Moved ${op.moves.length} ${op.moves.length === 1 ? 'layer' : 'layers'}`;
    case 'tag': return 'Changed element tag';
    case 'doc': return 'Renamed document';
    case 'tokens': return 'Updated tokens';
    case 'page': return `${op.action === 'add' ? 'Added' : op.action === 'remove' ? 'Removed' : 'Renamed'} page`;
    case 'note': return `${op.action === 'add' ? 'Added' : op.action === 'remove' ? 'Removed' : 'Updated'} a note`;
    case 'component': return `${op.action === 'add' ? 'Created' : op.action === 'remove' ? 'Deleted' : 'Updated'} a component`;
    case 'override': return `Overrode ${op.updates.length} component ${op.updates.length === 1 ? 'layer' : 'layers'}`;
  }
}

export function createSnapshot(docId: string, label?: string): { id: string; rev: number } {
  const doc = getDocument(docId);
  if (!doc) throw new StoreError(`document ${docId} not found`);
  const id = newId('snap');
  db.prepare('INSERT INTO snapshots (id, doc_id, rev, label, data, ts) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, docId, doc.rev, label ?? null, JSON.stringify(doc), now());
  return { id, rev: doc.rev };
}

export function listSnapshots(docId: string): { id: string; rev: number; label: string | null; ts: number }[] {
  return db.prepare('SELECT id, rev, label, ts FROM snapshots WHERE doc_id = ? ORDER BY ts DESC')
    .all(docId) as { id: string; rev: number; label: string | null; ts: number }[];
}

/**
 * Restores a snapshot as a *new* revision rather than rewinding, so the op log
 * stays append-only and the restore itself is undoable.
 */
export function restoreSnapshot(docId: string, snapshotId: string): CanvasDocument {
  const row = db.prepare('SELECT data FROM snapshots WHERE id = ? AND doc_id = ?')
    .get(snapshotId, docId) as { data: string } | undefined;
  if (!row) throw new StoreError('snapshot not found');
  const snap = JSON.parse(row.data) as CanvasDocument;
  const doc = getDocument(docId);
  if (!doc) throw new StoreError(`document ${docId} not found`);

  doc.nodes = snap.nodes;
  doc.pages = snap.pages;
  doc.tokens = snap.tokens;
  doc.themes = snap.themes;
  doc.rev += 1;
  dirty.add(docId);
  broadcast(docId, [{
    op: { t: 'doc' }, origin: { kind: 'system', id: 'restore' },
    rev: doc.rev, inverse: { t: 'doc' }, ts: now(),
  }]);
  return doc;
}

export function autoSnapshotIfStale(docId: string): void {
  const last = db.prepare('SELECT ts FROM snapshots WHERE doc_id = ? ORDER BY ts DESC LIMIT 1')
    .get(docId) as { ts: number } | undefined;
  const FIFTEEN_MIN = 15 * 60 * 1000;
  if (!last || now() - last.ts > FIFTEEN_MIN) createSnapshot(docId, 'Autosave');
}
