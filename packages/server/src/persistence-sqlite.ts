/** SQLite persistence, for running as a long-lived process. */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CanvasDocument } from '@playground/shared';
import type {
  DocSummary, MemberRole, Persistence, ShareRole, StoredAsset, StoredConnection, StoredMembership,
  StoredInvite, StoredProject, StoredSession, StoredShare, StoredSnapshot, StoredThumbnail,
  StoredUser,
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
    // The thumbnail cache changed shape when component previews arrived. It is
    // a cache: dropping it costs one re-render per picture, and migrating it
    // costs code that would exist forever for no benefit.
    try {
      const cols = this.db.prepare("PRAGMA table_info('thumbnails')").all() as { name: string }[];
      if (cols.length && !cols.some((c) => c.name === 'key')) this.db.exec('DROP TABLE thumbnails');
    } catch { /* no such table yet */ }

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

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT NOT NULL,
        password_hash TEXT,
        created_at INTEGER NOT NULL,
        email_verified_at INTEGER,
        color TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

      -- Who may open which document, and as what. A document with no rows here
      -- belongs to nobody, which is what every document created before accounts
      -- existed looks like; the first account claims those.
      CREATE TABLE IF NOT EXISTS memberships (
        doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (doc_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS memberships_user ON memberships(user_id);

      CREATE TABLE IF NOT EXISTS invites (
        token TEXT PRIMARY KEY,
        doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        email TEXT,
        invited_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        accepted_by TEXT, accepted_at INTEGER,
        revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS invites_doc ON invites(doc_id);

      CREATE TABLE IF NOT EXISTS thumbnails (
        doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        stamp TEXT NOT NULL, mime TEXT NOT NULL, bytes BLOB NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY (doc_id, key)
      );
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

  // --- Accounts -------------------------------------------------------------

  async saveUser(u: StoredUser): Promise<void> {
    this.db.prepare(`
      INSERT INTO users (id, email, name, password_hash, created_at, email_verified_at, color)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET email = excluded.email, name = excluded.name,
        password_hash = excluded.password_hash, email_verified_at = excluded.email_verified_at,
        color = excluded.color
    `).run(u.id, u.email, u.name, u.passwordHash, u.createdAt, u.emailVerifiedAt, u.color);
  }

  async loadUser(id: string): Promise<StoredUser | null> {
    return userRow(this.db.prepare('SELECT * FROM users WHERE id = ?').get(id));
  }

  async loadUserByEmail(email: string): Promise<StoredUser | null> {
    return userRow(this.db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(email));
  }

  async countUsers(): Promise<number> {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    return row.n;
  }

  async listUsers(ids?: string[]): Promise<StoredUser[]> {
    if (ids && ids.length === 0) return [];
    const rows = ids
      ? this.db.prepare(`SELECT * FROM users WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)
      : this.db.prepare('SELECT * FROM users ORDER BY created_at').all();
    return (rows as unknown[]).map((r) => userRow(r)!).filter(Boolean);
  }

  async saveSession(s: StoredSession): Promise<void> {
    this.db.prepare(`
      INSERT INTO sessions (token, user_id, created_at, expires_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(token) DO UPDATE SET expires_at = excluded.expires_at,
        last_seen_at = excluded.last_seen_at
    `).run(s.token, s.userId, s.createdAt, s.expiresAt, s.lastSeenAt);
  }

  async loadSession(token: string): Promise<StoredSession | null> {
    const r = this.db.prepare('SELECT * FROM sessions WHERE token = ?').get(token) as
      { token: string; user_id: string; created_at: number; expires_at: number; last_seen_at: number } | undefined;
    return r ? {
      token: r.token, userId: r.user_id, createdAt: r.created_at,
      expiresAt: r.expires_at, lastSeenAt: r.last_seen_at,
    } : null;
  }

  async deleteSession(token: string): Promise<void> {
    this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  async deleteSessionsForUser(userId: string): Promise<void> {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  async saveInvite(i: StoredInvite): Promise<void> {
    this.db.prepare(`
      INSERT INTO invites (token, doc_id, role, email, invited_by, created_at, expires_at,
                           accepted_by, accepted_at, revoked)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(token) DO UPDATE SET role = excluded.role, accepted_by = excluded.accepted_by,
        accepted_at = excluded.accepted_at, revoked = excluded.revoked
    `).run(i.token, i.docId, i.role, i.email, i.invitedBy, i.createdAt, i.expiresAt,
      i.acceptedBy, i.acceptedAt, i.revoked ? 1 : 0);
  }

  async loadInvite(token: string): Promise<StoredInvite | null> {
    return inviteRow(this.db.prepare('SELECT * FROM invites WHERE token = ?').get(token));
  }

  async loadInvites(docId: string): Promise<StoredInvite[]> {
    const rows = this.db.prepare(
      'SELECT * FROM invites WHERE doc_id = ? ORDER BY created_at DESC').all(docId);
    return (rows as unknown[]).map((r) => inviteRow(r)!).filter(Boolean);
  }

  async saveMembership(m: StoredMembership): Promise<void> {
    this.db.prepare(`
      INSERT INTO memberships (doc_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(doc_id, user_id) DO UPDATE SET role = excluded.role
    `).run(m.docId, m.userId, m.role, m.createdAt);
  }

  async loadMembership(docId: string, userId: string): Promise<StoredMembership | null> {
    return membershipRow(this.db.prepare(
      'SELECT * FROM memberships WHERE doc_id = ? AND user_id = ?').get(docId, userId));
  }

  async loadMemberships(opts: { docId?: string; userId?: string }): Promise<StoredMembership[]> {
    const where: string[] = [];
    const args: string[] = [];
    if (opts.docId) { where.push('doc_id = ?'); args.push(opts.docId); }
    if (opts.userId) { where.push('user_id = ?'); args.push(opts.userId); }
    const rows = this.db.prepare(
      `SELECT * FROM memberships${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`).all(...args);
    return (rows as unknown[]).map((r) => membershipRow(r)!).filter(Boolean);
  }

  async deleteMembership(docId: string, userId: string): Promise<void> {
    this.db.prepare('DELETE FROM memberships WHERE doc_id = ? AND user_id = ?').run(docId, userId);
  }

  async saveThumbnail(t: StoredThumbnail): Promise<void> {
    this.db.prepare(`
      INSERT INTO thumbnails (doc_id, key, stamp, mime, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(doc_id, key) DO UPDATE SET stamp = excluded.stamp, mime = excluded.mime,
        bytes = excluded.bytes, created_at = excluded.created_at
    `).run(t.docId, t.key, t.stamp, t.mime, t.bytes, t.createdAt);
  }

  async loadThumbnail(docId: string, key: string): Promise<StoredThumbnail | null> {
    const r = this.db.prepare('SELECT * FROM thumbnails WHERE doc_id = ? AND key = ?').get(docId, key) as
      { doc_id: string; key: string; stamp: string; mime: string; bytes: Uint8Array; created_at: number } | undefined;
    return r ? {
      docId: r.doc_id, key: r.key, stamp: r.stamp, mime: r.mime,
      bytes: Buffer.from(r.bytes), createdAt: r.created_at,
    } : null;
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

// SQLite hands back snake_case rows; these two keep the mapping in one place.

function userRow(r: unknown): StoredUser | null {
  if (!r) return null;
  const row = r as {
    id: string; email: string; name: string; password_hash: string | null;
    created_at: number; email_verified_at: number | null; color: string;
  };
  return {
    id: row.id, email: row.email, name: row.name, passwordHash: row.password_hash,
    createdAt: row.created_at, emailVerifiedAt: row.email_verified_at, color: row.color,
  };
}

function inviteRow(r: unknown): StoredInvite | null {
  if (!r) return null;
  const row = r as {
    token: string; doc_id: string; role: MemberRole; email: string | null; invited_by: string;
    created_at: number; expires_at: number; accepted_by: string | null; accepted_at: number | null;
    revoked: number;
  };
  return {
    token: row.token, docId: row.doc_id, role: row.role, email: row.email,
    invitedBy: row.invited_by, createdAt: row.created_at, expiresAt: row.expires_at,
    acceptedBy: row.accepted_by, acceptedAt: row.accepted_at, revoked: !!row.revoked,
  };
}

function membershipRow(r: unknown): StoredMembership | null {
  if (!r) return null;
  const row = r as { doc_id: string; user_id: string; role: MemberRole; created_at: number };
  return { docId: row.doc_id, userId: row.user_id, role: row.role, createdAt: row.created_at };
}
