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
  projectId?: string;
}

export interface StoredProject {
  id: string;
  name: string;
  createdAt: number;
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

export type ShareRole = 'view';

export interface StoredShare {
  token: string;
  docId: string;
  role: ShareRole;
  label: string | null;
  createdAt: number;
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

/**
 * A person with an account.
 *
 * `passwordHash` is the only credential for now. The record is shaped for the
 * other two sign-in methods to arrive without a migration: an email-link login
 * sets `emailVerifiedAt` and leaves the hash null, and an OAuth identity is a
 * row in `identities` pointing here.
 */
export interface StoredUser {
  id: string;
  /** Lower-cased and trimmed. Unique across the instance. */
  email: string;
  name: string;
  passwordHash: string | null;
  createdAt: number;
  /**
   * Null until there is a mail service to verify with. Deliberately not a gate:
   * an instance with no SMTP configured would otherwise lock out every account
   * it created, including the first one.
   */
  emailVerifiedAt: number | null;
  /** Stable presence colour, so a person looks the same to everyone, every session. */
  color: string;
}

export interface StoredSession {
  token: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
}

export type MemberRole = 'owner' | 'editor' | 'viewer';

export interface StoredMembership {
  docId: string;
  userId: string;
  role: MemberRole;
  createdAt: number;
}

/**
 * A cached picture of a document, keyed to the revision it was taken at.
 *
 * Derived data, so it lives beside the document rather than in it: rendering
 * one costs a browser page and about a second, which is fine once and absurd on
 * every library load.
 */
export interface StoredThumbnail {
  docId: string;
  rev: number;
  mime: string;
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

  saveProject(project: StoredProject): Promise<void>;
  loadProjects(): Promise<StoredProject[]>;
  deleteProject(id: string): Promise<boolean>;

  saveShare(share: StoredShare): Promise<void>;
  loadShares(docId: string): Promise<StoredShare[]>;
  loadShare(token: string): Promise<StoredShare | null>;

  saveAsset(asset: StoredAsset): Promise<void>;
  loadAsset(id: string): Promise<StoredAsset | null>;

  saveUser(user: StoredUser): Promise<void>;
  loadUser(id: string): Promise<StoredUser | null>;
  loadUserByEmail(email: string): Promise<StoredUser | null>;
  countUsers(): Promise<number>;
  listUsers(ids?: string[]): Promise<StoredUser[]>;

  saveSession(session: StoredSession): Promise<void>;
  loadSession(token: string): Promise<StoredSession | null>;
  deleteSession(token: string): Promise<void>;
  deleteSessionsForUser(userId: string): Promise<void>;

  saveMembership(m: StoredMembership): Promise<void>;
  loadMembership(docId: string, userId: string): Promise<StoredMembership | null>;
  loadMemberships(opts: { docId?: string; userId?: string }): Promise<StoredMembership[]>;
  deleteMembership(docId: string, userId: string): Promise<void>;

  saveThumbnail(thumb: StoredThumbnail): Promise<void>;
  loadThumbnail(docId: string): Promise<StoredThumbnail | null>;

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
