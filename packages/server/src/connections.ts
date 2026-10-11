/**
 * Agent connections.
 *
 * Paper solves this by running MCP on localhost inside a desktop app. Playground
 * is web-only, so the MCP endpoint is hosted and a connection code binds it to
 * one document.
 *
 * There are no accounts, so this code is the only thing between an agent and
 * write access to a document. That makes short expiry before first use,
 * inactivity expiry after it, and revocation non-negotiable even at this stage —
 * it is hygiene, not authentication.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { persistence, type StoredConnection } from './persistence.ts';
import { ensureLoaded, getDocument, listDocuments } from './store.ts';

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
  /** Set when the connection covers a whole project; `docId` is the document it is on now. */
  projectId: string | null;
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

export async function createConnection(docId: string, label?: string): Promise<Connection> {
  const doc = getDocument(docId);
  if (!doc) throw new Error(`document ${docId} not found`);
  const code = randomCode();
  const createdAt = Date.now();
  const store = await persistence();
  await store.saveConnection({
    code, docId, label: label ?? null, createdAt,
    redeemedAt: null, lastUsedAt: null, revoked: false,
  });
  return { code, docId, docName: doc.name, label: label ?? null, createdAt, redeemedAt: null, lastUsedAt: null, projectId: null };
}

export class ConnectionError extends Error {}

/** The documents filed in a project, most recently changed first. */
export async function projectDocuments(projectId: string): Promise<{ id: string; name: string; updatedAt: number }[]> {
  return (await listDocuments())
    .filter((d) => d.projectId === projectId)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((d) => ({ id: d.id, name: d.name, updatedAt: d.updatedAt }));
}

/**
 * A connection for a whole project.
 *
 * Building an app is rarely one document — screens, a design system, a deck —
 * and a code per document meant reconnecting the agent for each. A project
 * connection starts on one document (the one asked for, or the most recent)
 * and the agent moves between the project's documents with switch_document.
 * It can never reach a document outside the project.
 */
export async function createProjectConnection(projectId: string, label?: string, docId?: string): Promise<Connection> {
  const docs = await projectDocuments(projectId);
  if (!docs.length) throw new ConnectionError('This project has no documents yet. File one into it first.');
  const start = docId ? docs.find((d) => d.id === docId) : docs[0];
  if (!start) throw new ConnectionError(`Document ${docId} is not in this project.`);
  await ensureLoaded(start.id);
  const code = randomCode();
  const createdAt = Date.now();
  const store = await persistence();
  await store.saveConnection({
    code, docId: start.id, label: label ?? null, createdAt,
    redeemedAt: null, lastUsedAt: null, revoked: false, projectId,
  });
  return { code, docId: start.id, docName: start.name, label: label ?? null, createdAt, redeemedAt: null, lastUsedAt: null, projectId };
}

/**
 * Moves a project connection onto another of the project's documents. The
 * choice is stored, so it holds across requests and reconnections.
 */
export async function switchConnectionDocument(connection: Connection, docId: string): Promise<Connection> {
  if (!connection.projectId) {
    throw new ConnectionError('This connection is for one document. Ask for a project connection to move between documents.');
  }
  const docs = await projectDocuments(connection.projectId);
  if (!docs.some((d) => d.id === docId)) {
    throw new ConnectionError(`Document "${docId}" is not in this project. list_documents shows the ones that are.`);
  }
  await ensureLoaded(docId);
  const doc = getDocument(docId);
  if (!doc) throw new ConnectionError(`Document "${docId}" no longer exists.`);
  const store = await persistence();
  const row = await store.loadConnection(connection.code);
  if (row) await store.saveConnection({ ...row, docId });
  connection.docId = docId;
  connection.docName = doc.name;
  return connection;
}

/**
 * Resolves a code to a connection, redeeming it on first use.
 * Returns null for unknown, revoked, or expired codes — the caller must not
 * distinguish between those in its response.
 */
export async function resolveConnection(code: string): Promise<Connection | null> {
  const normalized = code.trim().toUpperCase();
  if (!/^[A-Z0-9-]{4,32}$/.test(normalized)) return null;

  const store = await persistence();
  const all = (await store.loadConnections()).filter((c) => !c.revoked);

  // Constant-time compare so a code cannot be recovered by timing the lookup.
  const target = Buffer.from(normalized);
  let row: StoredConnection | undefined;
  for (const c of all) {
    const candidate = Buffer.from(c.code);
    if (candidate.length === target.length && timingSafeEqual(candidate, target)) { row = c; break; }
  }
  if (!row) return null;

  const t = Date.now();
  if (row.redeemedAt === null) {
    if (t - row.createdAt > UNREDEEMED_TTL_MS) { await revokeConnection(row.code); return null; }
    row.redeemedAt = t;
    row.lastUsedAt = t;
    await store.saveConnection(row);
  } else if (row.lastUsedAt !== null && t - row.lastUsedAt > IDLE_TTL_MS) {
    await revokeConnection(row.code);
    return null;
  }

  await ensureLoaded(row.docId);
  const doc = getDocument(row.docId);
  if (!doc) return null;

  return {
    code: row.code, docId: row.docId, docName: doc.name, label: row.label,
    createdAt: row.createdAt, redeemedAt: row.redeemedAt, lastUsedAt: row.lastUsedAt,
    projectId: row.projectId ?? null,
  };
}

export async function touchConnection(code: string): Promise<void> {
  const store = await persistence();
  const conn = await store.loadConnection(code);
  if (conn) await store.saveConnection({ ...conn, lastUsedAt: Date.now() });
}

export async function listConnections(docId: string): Promise<Omit<Connection, 'docName'>[]> {
  const store = await persistence();
  return (await store.loadConnections(docId))
    .filter((c) => !c.revoked)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(({ revoked, ...rest }) => { void revoked; return { ...rest, projectId: rest.projectId ?? null }; });
}

export async function revokeConnection(code: string): Promise<boolean> {
  const store = await persistence();
  const conn = await store.loadConnection(code);
  if (!conn) return false;
  await store.saveConnection({ ...conn, revoked: true });
  return true;
}
