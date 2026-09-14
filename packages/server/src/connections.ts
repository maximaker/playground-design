/**
 * Agent connections.
 *
 * Paper solves this by running MCP on localhost inside a desktop app. Canvas is
 * web-only, so the MCP endpoint is hosted and a connection code binds it to one
 * document.
 *
 * There are no accounts in v1, so this code is the only thing between an agent
 * and write access to a document. That makes short expiry before first use,
 * inactivity expiry after it, and revocation non-negotiable even at this stage —
 * it is hygiene, not authentication.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { db, now } from './db.ts';
import { getDocument } from './store.ts';

/** Minutes a freshly minted code stays valid before anyone redeems it. */
const UNREDEEMED_TTL_MS = 30 * 60 * 1000;
/** Days a redeemed connection survives without use. */
const IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface Connection {
  code: string;
  docId: string;
  docName: string;
  label: string | null;
  createdAt: number;
  redeemedAt: number | null;
  lastUsedAt: number | null;
}

interface Row {
  code: string; doc_id: string; label: string | null;
  created_at: number; redeemed_at: number | null; last_used_at: number | null; revoked: number;
}

// Unambiguous alphabet: no O/0, I/1, so a code read off a screen types correctly.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomCode(): string {
  const bytes = randomBytes(16);
  let s = '';
  for (let i = 0; i < 16; i++) {
    if (i > 0 && i % 4 === 0) s += '-';
    s += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return s;
}

export function createConnection(docId: string, label?: string): Connection {
  const doc = getDocument(docId);
  if (!doc) throw new Error(`document ${docId} not found`);
  const code = randomCode();
  const t = now();
  db.prepare('INSERT INTO connections (code, doc_id, label, created_at) VALUES (?, ?, ?, ?)')
    .run(code, docId, label ?? null, t);
  return { code, docId, docName: doc.name, label: label ?? null, createdAt: t, redeemedAt: null, lastUsedAt: null };
}

/**
 * Resolves a code to a connection, redeeming it on first use.
 * Returns null for unknown, revoked, or expired codes — the caller must not
 * distinguish between those in its response.
 */
export function resolveConnection(code: string): Connection | null {
  const normalized = code.trim().toUpperCase();
  if (!/^[A-Z0-9-]{4,32}$/.test(normalized)) return null;

  const rows = db.prepare('SELECT * FROM connections WHERE revoked = 0').all() as unknown as Row[];

  // Constant-time compare so a code cannot be recovered by timing the lookup.
  const target = Buffer.from(normalized);
  let row: Row | undefined;
  for (const r of rows) {
    const candidate = Buffer.from(r.code);
    if (candidate.length === target.length && timingSafeEqual(candidate, target)) { row = r; break; }
  }
  if (!row) return null;

  const t = now();
  if (row.redeemed_at === null) {
    if (t - row.created_at > UNREDEEMED_TTL_MS) { revokeConnection(row.code); return null; }
    db.prepare('UPDATE connections SET redeemed_at = ?, last_used_at = ? WHERE code = ?').run(t, t, row.code);
    row.redeemed_at = t;
  } else if (row.last_used_at !== null && t - row.last_used_at > IDLE_TTL_MS) {
    revokeConnection(row.code);
    return null;
  }

  const doc = getDocument(row.doc_id);
  if (!doc) return null;

  return {
    code: row.code, docId: row.doc_id, docName: doc.name, label: row.label,
    createdAt: row.created_at, redeemedAt: row.redeemed_at, lastUsedAt: row.last_used_at,
  };
}

export function touchConnection(code: string): void {
  db.prepare('UPDATE connections SET last_used_at = ? WHERE code = ?').run(now(), code);
}

export function listConnections(docId: string): Omit<Connection, 'docName'>[] {
  const rows = db.prepare(
    'SELECT * FROM connections WHERE doc_id = ? AND revoked = 0 ORDER BY created_at DESC',
  ).all(docId) as unknown as Row[];
  return rows.map((r) => ({
    code: r.code, docId: r.doc_id, label: r.label,
    createdAt: r.created_at, redeemedAt: r.redeemed_at, lastUsedAt: r.last_used_at,
  }));
}

export function revokeConnection(code: string): boolean {
  return db.prepare('UPDATE connections SET revoked = 1 WHERE code = ?').run(code).changes > 0;
}
