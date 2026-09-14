/**
 * Persistence.
 *
 * Two backends behind one interface: SQLite when the server runs as a long-
 * lived process, and Vercel Blob when it runs as serverless functions with no
 * filesystem. The document cache stays synchronous either way — routes call
 * `ensureLoaded` once, then work against memory — so adding a serverless
 * backend did not turn the whole codebase async.
 */

import type { CanvasDocument } from '@playground/shared';

export interface DocSummary {
  id: string;
  name: string;
  rev: number;
  updatedAt: number;
  nodeCount: number;
}

export interface StoredConnection {
  code: string;
  docId: string;
  label: string | null;
  createdAt: number;
  redeemedAt: number | null;
  lastUsedAt: number | null;
  revoked: boolean;
}

export interface StoredAsset {
  id: string;
  docId: string | null;
  mime: string;
  name: string | null;
  bytes: Buffer;
  createdAt: number;
}

export interface StoredSnapshot {
  id: string;
  docId: string;
  rev: number;
  label: string | null;
  data: CanvasDocument;
  ts: number;
}

export interface Persistence {
  readonly kind: 'sqlite' | 'blob' | 'memory';
  /** True when the backend survives a process restart. */
  readonly durable: boolean;

  loadDocument(id: string): Promise<CanvasDocument | null>;
  saveDocument(doc: CanvasDocument): Promise<void>;
  deleteDocument(id: string): Promise<void>;
  listDocuments(): Promise<DocSummary[]>;

  saveConnection(conn: StoredConnection): Promise<void>;
  loadConnections(docId?: string): Promise<StoredConnection[]>;
  loadConnection(code: string): Promise<StoredConnection | null>;

  saveAsset(asset: StoredAsset): Promise<void>;
  loadAsset(id: string): Promise<StoredAsset | null>;

  saveSnapshot(snapshot: StoredSnapshot): Promise<void>;
  loadSnapshots(docId: string): Promise<Omit<StoredSnapshot, 'data'>[]>;
  loadSnapshot(docId: string, id: string): Promise<StoredSnapshot | null>;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

let instance: Persistence | null = null;

export async function persistence(): Promise<Persistence> {
  if (instance) return instance;

  // A Blob token is the signal that this is a serverless deployment; there is
  // no filesystem to put SQLite on there.
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    const { BlobPersistence } = await import('./persistence-blob.ts');
    instance = new BlobPersistence(process.env.BLOB_READ_WRITE_TOKEN);
    return instance;
  }

  try {
    const { SqlitePersistence } = await import('./persistence-sqlite.ts');
    instance = new SqlitePersistence();
  } catch (err) {
    // Better to run with an explicit warning than to fail to boot.
    console.warn('[playground] SQLite unavailable, falling back to in-memory storage:', err);
    const { MemoryPersistence } = await import('./persistence-memory.ts');
    instance = new MemoryPersistence();
  }
  return instance;
}

/** For tests, which need a clean backend per run. */
export function setPersistence(p: Persistence | null): void {
  instance = p;
}
