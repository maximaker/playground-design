/** SQLite persistence, for running as a long-lived process. */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CanvasDocument } from '@playground/shared';
import type {
  DocSummary, Persistence, ShareRole, StoredAsset, StoredConnection, StoredProject, StoredShare,
  StoredSnapshot,
} from './persistence.ts';

// Anchored to the package, not the working directory: resolving against cwd
// silently creates a second, empty database when the server is started from a
// different folder, which looks exactly like data loss.
const PACKAGE_ROOT = resolve(fileURLToPath(import.meta.url), '../..');
export const DB_PATH = process.env.PLAYGROUND_DB ?? resolve(PACKAGE_ROOT, 'data/playground.db');

export class SqlitePersistence implements Persistence {
  readonly kind = 'sqlite' as const;
  readonly durable = true;
  private db: DatabaseSync;

  constructor(path = DB_PATH) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, data TEXT NOT NULL,
        rev INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        -- Unused in v1 (no accounts), but threaded through now so that adding
        -- ownership later does not require migrating the session layers.
        owner_session TEXT
      );

      CREATE TABLE IF NOT EXISTS connections (
        code TEXT PRIMARY KEY,
        doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        label TEXT, created_at INTEGER NOT NULL,
        redeemed_at INTEGER, last_used_at INTEGER,
        revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS connections_doc ON connections(doc_id);

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS shares (
        token TEXT PRIMARY KEY,
        doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        role TEXT NOT NULL, label TEXT,
        created_at INTEGER NOT NULL, last_used_at INTEGER,
        revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS shares_doc ON shares(doc_id);

      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY,
        doc_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
        mime TEXT NOT NULL, name TEXT, bytes BLOB NOT NULL, created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY,
        doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        rev INTEGER NOT NULL, label TEXT, data TEXT NOT NULL, ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS snapshots_doc ON snapshots(doc_id, ts DESC);
    `);
  }

  async loadDocument(id: string): Promise<CanvasDocument | null> {
    const row = this.db.prepare('SELECT data FROM documents WHERE id = ?').get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as CanvasDocument) : null;
  }

  async saveDocument(doc: CanvasDocument): Promise<void> {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO documents (id, name, data, rev, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data, rev = excluded.rev,
        name = excluded.name, updated_at = excluded.updated_at
    `).run(doc.id, doc.name, JSON.stringify(doc), doc.rev, now, now);
  }

  async deleteDocument(id: string): Promise<void> {
    this.db.prepare('DELETE FROM documents WHERE id = ?').run(id);
  }

  async listDocuments(): Promise<DocSummary[]> {
    const rows = this.db.prepare(
      'SELECT id, name, rev, updated_at, data FROM documents ORDER BY updated_at DESC',
    ).all() as { id: string; name: string; rev: number; updated_at: number; data: string }[];
    return rows.map((r) => {
      const doc = JSON.parse(r.data) as CanvasDocument;
      return {
        id: r.id, name: r.name, rev: r.rev, updatedAt: r.updated_at,
        nodeCount: Object.keys(doc.nodes).length,
        projectId: doc.projectId,
      };
    });
  }

  async saveConnection(c: StoredConnection): Promise<void> {
    this.db.prepare(`
      INSERT INTO connections (code, doc_id, label, created_at, redeemed_at, last_used_at, revoked)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET redeemed_at = excluded.redeemed_at,
        last_used_at = excluded.last_used_at, revoked = excluded.revoked
    `).run(c.code, c.docId, c.label, c.createdAt, c.redeemedAt, c.lastUsedAt, c.revoked ? 1 : 0);
  }

  async loadConnections(docId?: string): Promise<StoredConnection[]> {
    const rows = docId
      ? this.db.prepare('SELECT * FROM connections WHERE doc_id = ? ORDER BY created_at DESC').all(docId)
      : this.db.prepare('SELECT * FROM connections').all();
    return (rows as Record<string, unknown>[]).map(toConnection);
  }

  async loadConnection(code: string): Promise<StoredConnection | null> {
    const row = this.db.prepare('SELECT * FROM connections WHERE code = ?').get(code) as Record<string, unknown> | undefined;
    return row ? toConnection(row) : null;
  }

  async saveProject(p: StoredProject): Promise<void> {
    this.db.prepare('INSERT OR REPLACE INTO projects (id, name, created_at) VALUES (?, ?, ?)')
      .run(p.id, p.name, p.createdAt);
  }

  async loadProjects(): Promise<StoredProject[]> {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY name COLLATE NOCASE').all();
    return (rows as Record<string, unknown>[]).map((r) => ({
      id: String(r.id), name: String(r.name), createdAt: Number(r.created_at),
    }));
  }

  async deleteProject(id: string): Promise<boolean> {
    const before = this.db.prepare('SELECT COUNT(*) n FROM projects WHERE id = ?').get(id) as { n: number };
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    return before.n > 0;
  }

  async saveShare(s: StoredShare): Promise<void> {
    this.db.prepare(`
      INSERT OR REPLACE INTO shares (token, doc_id, role, label, created_at, last_used_at, revoked)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(s.token, s.docId, s.role, s.label, s.createdAt, s.lastUsedAt, s.revoked ? 1 : 0);
  }

  async loadShares(docId: string): Promise<StoredShare[]> {
    const rows = this.db.prepare('SELECT * FROM shares WHERE doc_id = ? ORDER BY created_at DESC').all(docId);
    return (rows as Record<string, unknown>[]).map(shareRow);
  }

  async loadShare(token: string): Promise<StoredShare | null> {
    const row = this.db.prepare('SELECT * FROM shares WHERE token = ?').get(token) as Record<string, unknown> | undefined;
    return row ? shareRow(row) : null;
  }

  async saveAsset(a: StoredAsset): Promise<void> {
    this.db.prepare('INSERT OR REPLACE INTO assets (id, doc_id, mime, name, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(a.id, a.docId, a.mime, a.name, a.bytes, a.createdAt);
  }

  async loadAsset(id: string): Promise<StoredAsset | null> {
    const row = this.db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id), docId: (row.doc_id as string) ?? null, mime: String(row.mime),
      name: (row.name as string) ?? null, bytes: Buffer.from(row.bytes as Uint8Array),
      createdAt: Number(row.created_at),
    };
  }

  async saveSnapshot(s: StoredSnapshot): Promise<void> {
    this.db.prepare('INSERT INTO snapshots (id, doc_id, rev, label, data, ts) VALUES (?, ?, ?, ?, ?, ?)')
      .run(s.id, s.docId, s.rev, s.label, JSON.stringify(s.data), s.ts);
  }

  async loadSnapshots(docId: string) {
    return this.db.prepare('SELECT id, doc_id, rev, label, ts FROM snapshots WHERE doc_id = ? ORDER BY ts DESC')
      .all(docId) as unknown as Omit<StoredSnapshot, 'data'>[];
  }

  async loadSnapshot(docId: string, id: string): Promise<StoredSnapshot | null> {
    const row = this.db.prepare('SELECT * FROM snapshots WHERE id = ? AND doc_id = ?')
      .get(id, docId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id), docId: String(row.doc_id), rev: Number(row.rev),
      label: (row.label as string) ?? null, data: JSON.parse(String(row.data)) as CanvasDocument,
      ts: Number(row.ts),
    };
  }
}

function toConnection(row: Record<string, unknown>): StoredConnection {
  return {
    code: String(row.code), docId: String(row.doc_id), label: (row.label as string) ?? null,
    createdAt: Number(row.created_at),
    redeemedAt: row.redeemed_at === null ? null : Number(row.redeemed_at),
    lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
    revoked: Number(row.revoked) === 1,
  };
}

function shareRow(row: Record<string, unknown>): StoredShare {
  return {
    token: String(row.token), docId: String(row.doc_id),
    role: String(row.role) as ShareRole,
    label: (row.label as string) ?? null,
    createdAt: Number(row.created_at),
    lastUsedAt: row.last_used_at == null ? null : Number(row.last_used_at),
    revoked: Number(row.revoked) === 1,
  };
}
