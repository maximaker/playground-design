/**
 * Realtime sync and the browser RPC channel.
 *
 * Two jobs:
 *  1. Document sync + presence for humans (and for showing agent activity).
 *  2. An RPC channel *into* a connected tab. Most MCP tools run against the
 *     server's copy of the document, but a few need the live browser — computed
 *     styles, measured geometry, rasterized screenshots — because only a real
 *     layout engine knows those. `callTab` is how those tools reach it.
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import type { OpEnvelope } from '@playground/shared';
import { applyOps, ensureLoaded, getDocument, subscribe, StoreError, autoSnapshotIfStale } from './store.ts';
import { redactForViewer, resolveShare, viewerMayApply } from './shares.ts';
import { SESSION_COOKIE, atLeast, cookieValue, roleFor, sessionUser } from './accounts.ts';
import { persistence } from './persistence.ts';

export interface Peer {
  clientId: string;
  name: string;
  color: string;
  kind: 'human' | 'agent';
  /** The account behind this peer, when there is one. Absent for share-link viewers. */
  userId?: string;
  selection: string[];
  cursor?: { x: number; y: number };
  pageId?: string;
}

interface Session {
  ws: WebSocket;
  docId: string;
  peer: Peer;
  unsubscribe: () => void;
  alive: boolean;
  /**
   * False for a session that joined through a share link. Enforced here rather
   * than only in the client, because a hidden toolbar stops an honest viewer
   * from making a mess and nothing else.
   */
  canWrite: boolean;
}

const sessions = new Set<Session>();
const byDoc = new Map<string, Set<Session>>();

/** Pending RPCs awaiting a reply from a tab. */
const pendingRpc = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
let rpcSeq = 0;

const PEER_COLORS = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6'];

export function attachRealtime(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    let session: Session | null = null;
    // The handshake carries the browser's cookies, so the socket authenticates
    // exactly the way the API does. Without this the API gate is decorative:
    // every op already travels over this socket, not over REST.
    const cookie = req.headers.cookie;

    ws.on('message', (raw) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(String(raw)) as Record<string, unknown>; }
      catch { return send(ws, { type: 'error', message: 'invalid JSON' }); }

      switch (msg.type) {
        case 'join': {
          if (session) teardown(session);
          // A viewer joins by share token and never learns the document id; the
          // server resolves it here. The document may also not be in the cache
          // yet on a cold start, so both paths are async.
          void (async () => {
            if (msg.shareToken) {
              const share = await resolveShare(String(msg.shareToken));
              if (!share) return send(ws, { type: 'error', message: 'This link has been revoked or never existed.' });
              if (!session) session = handleJoin(ws, msg, share.docId, false, null);
              return;
            }

            const docId = String(msg.docId ?? '');
            const user = await sessionUser(cookieValue(cookie, SESSION_COOKIE));
            if (!user) {
              return send(ws, { type: 'error', code: 'unauthenticated', message: 'Sign in to open this document.' });
            }
            const role = await roleFor(docId, user.id);
            // As in the REST gate: a document nobody is a member of is open to
            // any signed-in user, which is what everything made before accounts
            // looks like until the first account claims it.
            const unowned = (await (await persistence()).loadMemberships({ docId })).length === 0;
            if (!role && !unowned) {
              return send(ws, { type: 'error', code: 'forbidden', message: 'You do not have access to this document.' });
            }
            await ensureLoaded(docId);
            if (!session) {
              session = handleJoin(ws, msg, docId, unowned || atLeast(role, 'editor'),
                { id: user.id, name: user.name, color: user.color });
            }
          })();
          break;
        }
        case 'ops': {
          if (!session) return send(ws, { type: 'error', message: 'join first' });
          if (!session.canWrite && !viewerMayApply(msg.ops as OpEnvelope[])) {
            return send(ws, {
              type: 'rejected',
              message: 'This is a view-only link. You can comment, but not change the design.',
              doc: getDocument(session.docId),
            });
          }
          handleOps(session, msg.ops as OpEnvelope[]);
          break;
        }
        case 'presence': {
          if (!session) return;
          if (Array.isArray(msg.selection)) session.peer.selection = msg.selection as string[];
          // Assigned unconditionally: leaving the canvas sends no cursor, and
          // only overwriting on a truthy value would leave the last position
          // parked on everyone else's screen forever.
          session.peer.cursor = (msg.cursor as { x: number; y: number } | undefined) ?? undefined;
          if (typeof msg.pageId === 'string') session.peer.pageId = msg.pageId;
          broadcastPeers(session.docId);
          break;
        }
        case 'rpc-result': {
          const entry = pendingRpc.get(String(msg.id));
          if (!entry) return;
          clearTimeout(entry.timer);
          pendingRpc.delete(String(msg.id));
          if (msg.ok) entry.resolve(msg.result);
          else entry.reject(new Error(String(msg.error ?? 'tab RPC failed')));
          break;
        }
        case 'pong': {
          if (session) session.alive = true;
          break;
        }
      }
    });

    ws.on('close', () => { if (session) teardown(session); });
    ws.on('error', () => { if (session) teardown(session); });
  });

  // Drop sessions whose tab went away without closing cleanly, so `hasLiveTab`
  // does not report a tab that cannot answer.
  const ping = setInterval(() => {
    for (const s of sessions) {
      if (!s.alive) { try { s.ws.terminate(); } catch { /* already gone */ } teardown(s); continue; }
      s.alive = false;
      send(s.ws, { type: 'ping' });
    }
  }, 20_000);
  wss.on('close', () => clearInterval(ping));

  return wss;
}

/**
 * Stamps a comment or reply with the account that actually sent it.
 *
 * The client fills in a name, and for a share-link viewer that is all there is.
 * For someone signed in it is a claim the server can check, and the same rule
 * applies as to presence: a name a tab can choose for itself is not identity.
 * This is also the fix for comments arriving as "Guest" from people who were
 * signed in the whole time.
 */
function attributed(op: OpEnvelope['op'], session: Session): OpEnvelope['op'] {
  if (!session.peer.userId || op.t !== 'comment') return op;
  if (op.action === 'add') {
    return { ...op, comment: { ...op.comment, author: session.peer.name } };
  }
  if (op.action === 'reply' && op.reply) {
    return { ...op, reply: { ...op.reply, author: session.peer.name } };
  }
  return op;
}

function handleJoin(
  ws: WebSocket,
  msg: Record<string, unknown>,
  docId: string,
  canWrite: boolean,
  /** The signed-in person, or null for a share-link viewer. */
  account: { id: string; name: string; color: string } | null,
): Session | null {
  const doc = getDocument(docId);
  if (!doc) { send(ws, { type: 'error', message: `document ${docId} not found` }); return null; }

  const clientId = String(msg.clientId ?? `c_${Math.random().toString(36).slice(2, 10)}`);
  const existing = byDoc.get(docId)?.size ?? 0;
  const peer: Peer = {
    clientId,
    // An account's own name and colour win over anything the client sends:
    // presence is an identity claim, and one a tab can set is worth nothing.
    // A share-link viewer has no account, so they stay a guest.
    name: account?.name ?? String(msg.name ?? `Guest ${existing + 1}`),
    color: account?.color ?? PEER_COLORS[existing % PEER_COLORS.length]!,
    kind: msg.kind === 'agent' ? 'agent' : 'human',
    userId: account?.id,
    selection: [],
  };

  const session: Session = {
    ws, docId, peer, alive: true, canWrite,
    unsubscribe: subscribe(docId, (ops) => {
      // Echo every op, including the sender's own, so clients can reconcile the
      // revision numbers they optimistically guessed.
      send(ws, { type: 'ops', ops });
    }),
  };

  sessions.add(session);
  let set = byDoc.get(docId);
  if (!set) { set = new Set(); byDoc.set(docId, set); }
  set.add(session);

  send(ws, {
    type: 'joined', clientId, peer, rev: doc.rev,
    // A viewer must not receive the real document id, which is the edit
    // credential — otherwise the read-only link is a formality.
    doc: canWrite ? doc : redactForViewer(doc, String(msg.shareToken ?? '')),
    canWrite,
  });
  broadcastPeers(docId);
  void autoSnapshotIfStale(docId).catch(() => {});
  return session;
}

function handleOps(session: Session, envelopes: OpEnvelope[]): void {
  if (!Array.isArray(envelopes) || envelopes.length === 0) return;
  try {
    applyOps(session.docId, envelopes.map((e) => ({
      ...e,
      op: attributed(e.op, session),
      origin: e.origin ?? { kind: 'human', id: session.peer.clientId, label: session.peer.name },
    })));
  } catch (err) {
    const doc = getDocument(session.docId);
    // A rejected op means the client's optimistic state has diverged; hand it
    // the authoritative document rather than leaving it silently wrong.
    send(session.ws, {
      type: 'rejected',
      message: err instanceof StoreError ? err.message : String(err),
      doc,
    });
  }
}

function teardown(session: Session): void {
  session.unsubscribe();
  sessions.delete(session);
  byDoc.get(session.docId)?.delete(session);
  if (byDoc.get(session.docId)?.size === 0) byDoc.delete(session.docId);
  broadcastPeers(session.docId);
}

function broadcastPeers(docId: string): void {
  const set = byDoc.get(docId);
  if (!set) return;
  const peers = [...set].map((s) => s.peer);
  for (const s of set) send(s.ws, { type: 'peers', peers });
}

function send(ws: WebSocket, msg: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ---------------------------------------------------------------------------
// Public helpers used by the MCP layer
// ---------------------------------------------------------------------------

export function hasLiveTab(docId: string): boolean {
  return [...(byDoc.get(docId) ?? [])].some((s) => s.peer.kind === 'human');
}

export function peersOf(docId: string): Peer[] {
  return [...(byDoc.get(docId) ?? [])].map((s) => s.peer);
}

/** Union of every human peer's selection — what `get_selection` reports. */
export function selectionOf(docId: string): string[] {
  const ids = new Set<string>();
  for (const s of byDoc.get(docId) ?? []) {
    if (s.peer.kind === 'human') for (const id of s.peer.selection) ids.add(id);
  }
  return [...ids];
}

export class NoTabError extends Error {
  constructor(method: string) {
    super(
      `"${method}" needs the document open in a browser tab, and none is connected. ` +
      `Open the document in Playground and retry, or use a tool that reads the stored document instead.`,
    );
  }
}

/** Calls a method inside a connected tab. Rejects with NoTabError if none. */
export function callTab<T = unknown>(docId: string, method: string, params: unknown, timeoutMs = 15_000): Promise<T> {
  const target = [...(byDoc.get(docId) ?? [])].find((s) => s.peer.kind === 'human' && s.ws.readyState === WebSocket.OPEN);
  if (!target) return Promise.reject(new NoTabError(method));

  const id = `rpc_${++rpcSeq}`;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRpc.delete(id);
      reject(new Error(`tab did not respond to "${method}" within ${timeoutMs}ms`));
    }, timeoutMs);
    pendingRpc.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    send(target.ws, { type: 'rpc', id, method, params });
  });
}

/** Pushes a transient notice to every tab on a document (agent activity chips). */
export function notifyTabs(docId: string, payload: unknown): void {
  for (const s of byDoc.get(docId) ?? []) send(s.ws, { type: 'notify', payload });
}
