/**
 * Persistence. Uses node:sqlite (built into Node 22+) so the server has no
 * native build step — important because this is meant to be cloned and run.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Anchored to the package, not the working directory: resolving against cwd
// silently creates a second, empty database when the server is started from a
// different folder, which looks exactly like data loss.
const PACKAGE_ROOT = resolve(fileURLToPath(import.meta.url), '../..');

export const DB_PATH = process.env.CANVAS_DB ?? resolve(PACKAGE_ROOT, 'data/canvas.db');

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS documents (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  data        TEXT NOT NULL,
  rev         INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  -- Unused in v1 (no accounts), but threaded through now so that adding
  -- ownership later does not require migrating the realtime/MCP session layer.
  owner_session TEXT
);

CREATE TABLE IF NOT EXISTS ops (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  rev        INTEGER NOT NULL,
  op         TEXT NOT NULL,
  inverse    TEXT NOT NULL,
  origin     TEXT NOT NULL,
  batch      TEXT,
  ts         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ops_doc_rev ON ops(doc_id, rev);

CREATE TABLE IF NOT EXISTS connections (
  code         TEXT PRIMARY KEY,
  doc_id       TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  label        TEXT,
  created_at   INTEGER NOT NULL,
  redeemed_at  INTEGER,
  last_used_at INTEGER,
  revoked      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS connections_doc ON connections(doc_id);

CREATE TABLE IF NOT EXISTS assets (
  id         TEXT PRIMARY KEY,
  doc_id     TEXT REFERENCES documents(id) ON DELETE CASCADE,
  mime       TEXT NOT NULL,
  name       TEXT,
  bytes      BLOB NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshots (
  id         TEXT PRIMARY KEY,
  doc_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  rev        INTEGER NOT NULL,
  label      TEXT,
  data       TEXT NOT NULL,
  ts         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS snapshots_doc ON snapshots(doc_id, ts DESC);
`);

export function now(): number { return Date.now(); }
