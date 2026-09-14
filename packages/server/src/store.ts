/**
 * Document store.
 *
 * The server is the authority: it serializes ops, assigns revisions, and
 * broadcasts. Clients apply optimistically and reconcile against the revision
 * they get back. This is a deliberate simplification over a CRDT for v1 — see
 * README "Deviations from the PRD".
 *
 * Documents live in a synchronous in-memory cache; persistence is async and
 * behind an adapter. Callers `await ensureLoaded(id)` once at the edge, then
 * work synchronously — which is what let a serverless backend be added without
 * making the whole codebase async.
 */

import {
  type CanvasDocument, type Op, type OpEnvelope,
  applyOp, createEmptyDocument, newId,
} from '@playground/shared';
import { persistence, type DocSummary } from './persistence.ts';

export interface AppliedOp extends OpEnvelope {
  rev: number;
  inverse: Op;
  ts: number;
}

type Listener = (ops: AppliedOp[]) => void;

const cache = new Map<string, CanvasDocument>();
const listeners = new Map<string, Set<Listener>>();
const dirty = new Set<string>();
const inflight = new Map<string, Promise<CanvasDocument | null>>();

/**
 * Recent ops per document, for clients that poll instead of holding a socket.
 * Bounded: a client further behind than this gets a full resync instead.
 */
const opLog = new Map<string, AppliedOp[]>();
const OP_LOG_LIMIT = 400;

const HISTORY_LIMIT = 400;
const history_ = new Map<string, HistoryEntry[]>();

export function now(): number { return Date.now(); }

export class StoreError extends Error {}

// ---------------------------------------------------------------------------
// Loading and saving
// ---------------------------------------------------------------------------

/** Brings a document into the synchronous cache. Safe to call repeatedly. */
export async function ensureLoaded(id: string): Promise<CanvasDocument | null> {
  const cached = cache.get(id);
  if (cached) return cached;

  const existing = inflight.get(id);
  if (existing) return existing;

  const load = (async () => {
    const store = await persistence();
    const doc = await store.loadDocument(id);
    if (doc) cache.set(id, doc);
    inflight.delete(id);
    return doc;
  })();

  inflight.set(id, load);
  return load;
}

/** Synchronous cache read. Call `ensureLoaded` first on a cold path. */
export function getDocument(id: string): CanvasDocument | null {
  return cache.get(id) ?? null;
}

// Persist on a short timer rather than per-op: a drag produces dozens of ops a
// second and each one would otherwise rewrite the whole document.
const FLUSH_MS = 400;
let flushTimer: ReturnType<typeof setInterval> | null = null;

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => { void flushAll(); }, FLUSH_MS);
  flushTimer.unref?.();
}

export async function flushAll(): Promise<void> {
  if (!dirty.size) return;
  const store = await persistence();
  for (const id of [...dirty]) {
    dirty.delete(id);
    const doc = cache.get(id);
    if (doc) await store.saveDocument(doc).catch((err) => console.error('[playground] save failed', err));
  }
}

/**
 * Serverless invocations end as soon as the response is sent, so a timer-based
 * flush would never run. There, persist immediately instead.
 */
async function markDirty(id: string): Promise<void> {
  const store = await persistence();
  if (store.kind === 'blob') {
    const doc = cache.get(id);
    if (doc) await store.saveDocument(doc).catch((err) => console.error('[playground] save failed', err));
    return;
  }
  dirty.add(id);
  scheduleFlush();
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export async function createDocument(name = 'Untitled', seed?: CanvasDocument): Promise<CanvasDocument> {
  const doc = seed ?? createEmptyDocument(name);
  doc.name = name;
  cache.set(doc.id, doc);
  const store = await persistence();
  await store.saveDocument(doc);
  return doc;
}

export async function listDocuments(): Promise<DocSummary[]> {
  const store = await persistence();
  const stored = await store.listDocuments();
  // The cache is fresher than storage between flushes.
  return stored.map((s) => {
    const live = cache.get(s.id);
    return live
      ? { ...s, name: live.name, rev: live.rev, nodeCount: Object.keys(live.nodes).length }
      : s;
  });
}

export async function deleteDocument(id: string): Promise<boolean> {
  const store = await persistence();
  const existed = (await store.loadDocument(id)) !== null || cache.has(id);
  await store.deleteDocument(id);
  cache.delete(id);
  dirty.delete(id);
  opLog.delete(id);
  history_.delete(id);
  return existed;
}

/**
 * Applies a batch of ops atomically: if any op throws, the document is rolled
 * back to its pre-batch state and nothing is broadcast.
 */
export function applyOps(docId: string, envelopes: OpEnvelope[]): AppliedOp[] {
  const doc = getDocument(docId);
  if (!doc) throw new StoreError(`document ${docId} not found`);
  if (envelopes.length === 0) return [];

  // Only the nodes an op can touch need capturing, so a rollback does not mean
  // cloning the whole document on every edit.
  const rollback = snapshotFor(doc, envelopes);
  const applied: AppliedOp[] = [];
  const ts = now();

  try {
    for (const env of envelopes) {
      const inverse = applyOp(doc, env.op);
      doc.rev += 1;
      applied.push({ ...env, inverse, rev: doc.rev, ts });
    }
  } catch (err) {
    restore(doc, rollback);
    throw new StoreError(err instanceof Error ? err.message : String(err));
  }

  const log = opLog.get(docId) ?? [];
  log.push(...applied);
  opLog.set(docId, log.slice(-OP_LOG_LIMIT));

  recordHistory(docId, applied);
  void markDirty(docId);
  broadcast(docId, applied);
  return applied;
}

interface Snapshot {
  nodes: Record<string, unknown>;
  pages: unknown;
  tokens: unknown;
  components: unknown;
  rev: number;
  name: string;
}

function snapshotFor(doc: CanvasDocument, envelopes: OpEnvelope[]): Snapshot {
  return {
    // Structural ops can reshape arbitrary parts of the tree, so those still
    // need a full copy; everything else is far more common and stays cheap.
    nodes: envelopes.some((e) => isStructural(e.op))
      ? structuredClone(doc.nodes)
      : Object.fromEntries(
          affectedIds(envelopes).flatMap((id) => (doc.nodes[id] ? [[id, structuredClone(doc.nodes[id])]] : [])),
        ),
    pages: structuredClone(doc.pages),
    tokens: structuredClone(doc.tokens),
    components: structuredClone(doc.components ?? {}),
    rev: doc.rev,
    name: doc.name,
  };
}

function restore(doc: CanvasDocument, snapshot: Snapshot): void {
  Object.assign(doc.nodes, snapshot.nodes as CanvasDocument['nodes']);
  doc.pages = snapshot.pages as CanvasDocument['pages'];
  doc.tokens = snapshot.tokens as CanvasDocument['tokens'];
  doc.components = snapshot.components as CanvasDocument['components'];
  doc.rev = snapshot.rev;
  doc.name = snapshot.name;
}

function isStructural(op: Op): boolean {
  return op.t === 'insert' || op.t === 'remove' || op.t === 'move' || op.t === 'page' || op.t === 'component';
}

function affectedIds(envelopes: OpEnvelope[]): string[] {
  const ids: string[] = [];
  for (const { op } of envelopes) {
    switch (op.t) {
      case 'styles': case 'text': case 'rename': case 'attrs': case 'meta': case 'tag': case 'props':
        ids.push(...op.updates.map((u) => u.id)); break;
      case 'override':
        ids.push(...op.updates.map((u) => u.id)); break;
      default: break;
    }
  }
  return ids;
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
  for (const fn of listeners.get(docId) ?? []) {
    try { fn(ops); } catch { /* a broken subscriber must not fail the write */ }
  }
}

/**
 * Ops after `rev`, for polling clients. Returns null when the caller is further
 * behind than the log reaches, which means they need a full resync.
 */
export function opsSince(docId: string, rev: number): AppliedOp[] | null {
  const log = opLog.get(docId) ?? [];
  if (!log.length) return rev >= (getDocument(docId)?.rev ?? 0) ? [] : null;
  if (rev < log[0]!.rev - 1) return null;
  return log.filter((o) => o.rev > rev);
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export interface HistoryEntry {
  rev: number;
  label: string;
  origin: OpEnvelope['origin'];
  batch?: string;
  ts: number;
  opCount: number;
}

function recordHistory(docId: string, applied: AppliedOp[]): void {
  const entries = history_.get(docId) ?? [];
  for (const a of applied) {
    const last = entries[entries.length - 1];
    if (last && a.batch && last.batch === a.batch) {
      last.opCount += 1;
      last.rev = a.rev;
      continue;
    }
    entries.push({
      rev: a.rev, label: describeOp(a.op), origin: a.origin,
      batch: a.batch, ts: a.ts, opCount: 1,
    });
  }
  history_.set(docId, entries.slice(-HISTORY_LIMIT));
}

export function history(docId: string, limit = 100): HistoryEntry[] {
  return [...(history_.get(docId) ?? [])].reverse().slice(0, limit);
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
    case 'variant': return 'Edited a component variant';
    case 'props': return 'Changed component properties';
    case 'breakpoints': return 'Changed breakpoints';
  }
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

export async function createSnapshot(docId: string, label?: string): Promise<{ id: string; rev: number }> {
  const doc = getDocument(docId);
  if (!doc) throw new StoreError(`document ${docId} not found`);
  const id = newId('snap');
  const store = await persistence();
  await store.saveSnapshot({
    id, docId, rev: doc.rev, label: label ?? null, data: structuredClone(doc), ts: now(),
  });
  return { id, rev: doc.rev };
}

export async function listSnapshots(docId: string) {
  const store = await persistence();
  return store.loadSnapshots(docId);
}

/**
 * Restores a snapshot as a *new* revision rather than rewinding, so the op log
 * stays append-only and the restore itself is undoable.
 */
export async function restoreSnapshot(docId: string, snapshotId: string): Promise<CanvasDocument> {
  const store = await persistence();
  const snap = await store.loadSnapshot(docId, snapshotId);
  if (!snap) throw new StoreError('snapshot not found');
  const doc = getDocument(docId);
  if (!doc) throw new StoreError(`document ${docId} not found`);

  doc.nodes = snap.data.nodes;
  doc.pages = snap.data.pages;
  doc.tokens = snap.data.tokens;
  doc.themes = snap.data.themes;
  doc.components = snap.data.components;
  doc.rev += 1;
  await markDirty(docId);
  broadcast(docId, [{
    op: { t: 'doc' }, origin: { kind: 'system', id: 'restore' },
    rev: doc.rev, inverse: { t: 'doc' }, ts: now(),
  }]);
  return doc;
}

export async function autoSnapshotIfStale(docId: string): Promise<void> {
  const store = await persistence();
  const snaps = await store.loadSnapshots(docId);
  const FIFTEEN_MIN = 15 * 60 * 1000;
  if (!snaps.length || now() - snaps[0]!.ts > FIFTEEN_MIN) await createSnapshot(docId, 'Autosave');
}
