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
import { createDocument, ensureLoaded, getDocument, listDocuments } from './store.ts';
import { documentsFor, grant } from './accounts.ts';

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
  /** Epoch ms after which the link stops working. */
  expiresAt: number | null;
  /** Reads and comments only. */
  readOnly: boolean;
  /** When set, the link reaches only these sections' screens. */
  sectionIds: string[] | null;
}

export interface ConnectionOptions {
  expiresAt?: number | null;
  readOnly?: boolean;
  sectionIds?: string[] | null;
}

/** Validates options against the document; throws ConnectionError with what to fix. */
function checkOptions(opts: ConnectionOptions, docId: string | null): ConnectionOptions {
  const out: ConnectionOptions = {};
  if (opts.expiresAt !== undefined && opts.expiresAt !== null) {
    if (!Number.isFinite(opts.expiresAt) || opts.expiresAt <= Date.now()) {
      throw new ConnectionError('expiresAt must be a time in the future (epoch milliseconds or an ISO date).');
    }
    out.expiresAt = opts.expiresAt;
  }
  if (opts.readOnly) out.readOnly = true;
  if (opts.sectionIds?.length) {
    if (!docId) throw new ConnectionError('A project connection cannot be limited to sections; make a document connection.');
    const doc = getDocument(docId);
    const known = new Set((doc?.pages ?? []).flatMap((p) => (p.sections ?? []).map((s) => s.id)));
    const missing = opts.sectionIds.filter((id) => !known.has(id));
    if (missing.length) throw new ConnectionError(`No section ${missing.map((m) => `"${m}"`).join(', ')} in this document.`);
    out.sectionIds = [...new Set(opts.sectionIds)];
  }
  return out;
}

function fromRow(row: StoredConnection, docName: string): Connection {
  return {
    code: row.code, docId: row.docId, docName, label: row.label,
    createdAt: row.createdAt, redeemedAt: row.redeemedAt, lastUsedAt: row.lastUsedAt,
    projectId: row.projectId ?? null,
    expiresAt: row.expiresAt ?? null,
    readOnly: !!row.readOnly,
    sectionIds: row.sectionIds?.length ? row.sectionIds : null,
  };
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

export class ConnectionError extends Error {}

export async function createConnection(docId: string, label?: string, options: ConnectionOptions = {}): Promise<Connection> {
  const doc = getDocument(docId);
  if (!doc) throw new Error(`document ${docId} not found`);
  const opts = checkOptions(options, docId);
  const row: StoredConnection = {
    code: randomCode(), docId, label: label ?? null, createdAt: Date.now(),
    redeemedAt: null, lastUsedAt: null, revoked: false, ...opts,
  };
  await (await persistence()).saveConnection(row);
  return fromRow(row, doc.name);
}

/*
 * Account links (Settings → Agents), the family standard: one link per agent
 * for everything its owner can open, like Studio OS, Notes and Artifactory.
 * Stored as a connection whose projectId is `account:<userId>`, so no schema
 * change; `docId` is the document it is on now, and tools take a documentId
 * to act on another. They are listed and revoked in Settings, so they do not
 * expire on their own.
 */
const ACCOUNT = 'account:';

/** The user an account link belongs to, or null for document/project links. */
export function accountOf(c: { projectId?: string | null }): string | null {
  return c.projectId?.startsWith(ACCOUNT) ? c.projectId.slice(ACCOUNT.length) : null;
}

/** Documents a user can open (theirs, shared with them, or owned by nobody), newest first. */
export async function accountDocuments(userId: string): Promise<{ id: string; name: string; updatedAt: number; projectId: string | null }[]> {
  const mine = await documentsFor(userId);
  const owned = new Set((await (await persistence()).loadMemberships({})).map((m) => m.docId));
  return (await listDocuments())
    .filter((d) => mine.has(d.id) || !owned.has(d.id))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((d) => ({ id: d.id, name: d.name, updatedAt: d.updatedAt, projectId: d.projectId ?? null }));
}

/** A new document for an account link's owner, owned by them like one made in the app. */
export async function createAccountDocument(userId: string, name: string) {
  const doc = await createDocument(name.trim() || 'Untitled');
  await grant(doc.id, userId, 'owner');
  return doc;
}

export async function createAccountConnection(userId: string, label?: string): Promise<Connection> {
  const docs = await accountDocuments(userId);
  const start = docs[0] ? getDocument(docs[0].id) ?? (await ensureLoaded(docs[0].id)) : await createAccountDocument(userId, 'Untitled');
  if (!start) throw new ConnectionError('Could not open a document for this link.');
  const row: StoredConnection = {
    code: randomCode(), docId: start.id, label: label ?? null, createdAt: Date.now(),
    redeemedAt: null, lastUsedAt: null, revoked: false, projectId: `${ACCOUNT}${userId}`,
  };
  await (await persistence()).saveConnection(row);
  return fromRow(row, start.name);
}

export async function listAccountConnections(userId: string) {
  const rows = (await (await persistence()).loadConnections()).filter((c) => !c.revoked && c.projectId === `${ACCOUNT}${userId}`);
  return rows
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((r) => ({ code: r.code, label: r.label, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt }));
}

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
export async function createProjectConnection(
  projectId: string, label?: string, docId?: string, options: ConnectionOptions = {},
): Promise<Connection> {
  const docs = await projectDocuments(projectId);
  if (!docs.length) throw new ConnectionError('This project has no documents yet. File one into it first.');
  const start = docId ? docs.find((d) => d.id === docId) : docs[0];
  if (!start) throw new ConnectionError(`Document ${docId} is not in this project.`);
  await ensureLoaded(start.id);
  const opts = checkOptions(options, null);
  const row: StoredConnection = {
    code: randomCode(), docId: start.id, label: label ?? null, createdAt: Date.now(),
    redeemedAt: null, lastUsedAt: null, revoked: false, projectId, ...opts,
  };
  await (await persistence()).saveConnection(row);
  return fromRow(row, start.name);
}

/**
 * Moves a project connection onto another of the project's documents. The
 * choice is stored, so it holds across requests and reconnections.
 */
export async function switchConnectionDocument(connection: Connection, docId: string): Promise<Connection> {
  if (!connection.projectId) {
    throw new ConnectionError('This connection is for one document. Make an account link in Settings → Agents to move between documents.');
  }
  const account = accountOf(connection);
  const docs = account ? await accountDocuments(account) : await projectDocuments(connection.projectId);
  if (!docs.some((d) => d.id === docId)) {
    throw new ConnectionError(account
      ? `No document "${docId}" you can open. list_documents shows the ones you can.`
      : `Document "${docId}" is not in this project. list_documents shows the ones that are.`);
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
  // Possession of the code is proven by now, so saying why it stopped working is safe — and useful.
  if (row.expiresAt && t > row.expiresAt) {
    throw new ConnectionError(
      `This connection link expired at ${new Date(row.expiresAt).toISOString()}. Ask for a new one from the Connect agent panel.`);
  }
  const account = accountOf(row);
  if (account) {
    row.redeemedAt ??= t;
    row.lastUsedAt = t;
    // The document it was on may be gone; carry on from the newest one.
    if (!(await ensureLoaded(row.docId))) {
      const next = (await accountDocuments(account))[0] ?? (await createAccountDocument(account, 'Untitled'));
      row.docId = next.id;
    }
    await store.saveConnection(row);
  } else if (row.redeemedAt === null) {
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

  return fromRow(row, doc.name);
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
    .map((row) => {
      const { docName, ...rest } = fromRow(row, ''); void docName;
      return { ...rest, ...(rest.expiresAt && rest.expiresAt < Date.now() ? { expired: true } : {}) };
    });
}

export async function revokeConnection(code: string): Promise<boolean> {
  const store = await persistence();
  const conn = await store.loadConnection(code);
  if (!conn) return false;
  await store.saveConnection({ ...conn, revoked: true });
  return true;
}
