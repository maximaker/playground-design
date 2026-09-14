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

export interface Peer {
  clientId: string;
  name: string;
  color: string;
  kind: 'human' | 'agent';
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
}

const sessions = new Set<Session>();
const byDoc = new Map<string, Set<Session>>();

/** Pending RPCs awaiting a reply from a tab. */
const pendingRpc = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
let rpcSeq = 0;

const PEER_COLORS = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6'];

export function attachRealtime(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    let session: Session | null = null;

    ws.on('message', (raw) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(String(raw)) as Record<string, unknown>; }
      catch { return send(ws, { type: 'error', message: 'invalid JSON' }); }

      switch (msg.type) {
        case 'join': {
          if (session) teardown(session);
          // The document may not be in the cache yet on a cold start.
          void ensureLoaded(String(msg.docId ?? '')).then(() => {
            if (!session) session = handleJoin(ws, msg);
          });
          break;
        }
        case 'ops': {
          if (!session) return send(ws, { type: 'error', message: 'join first' });
          handleOps(session, msg.ops as OpEnvelope[]);
          break;
        }
        case 'presence': {
          if (!session) return;
          if (Array.isArray(msg.selection)) session.peer.selection = msg.selection as string[];
          if (msg.cursor) session.peer.cursor = msg.cursor as { x: number; y: number };
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

function handleJoin(ws: WebSocket, msg: Record<string, unknown>): Session | null {
  const docId = String(msg.docId ?? '');
  const doc = getDocument(docId);
  if (!doc) { send(ws, { type: 'error', message: `document ${docId} not found` }); return null; }

  const clientId = String(msg.clientId ?? `c_${Math.random().toString(36).slice(2, 10)}`);
  const existing = byDoc.get(docId)?.size ?? 0;
  const peer: Peer = {
    clientId,
    name: String(msg.name ?? `Guest ${existing + 1}`),
    color: PEER_COLORS[existing % PEER_COLORS.length]!,
    kind: msg.kind === 'agent' ? 'agent' : 'human',
    selection: [],
  };

  const session: Session = {
    ws, docId, peer, alive: true,
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

  send(ws, { type: 'joined', clientId, peer, doc, rev: doc.rev });
  broadcastPeers(docId);
  void autoSnapshotIfStale(docId).catch(() => {});
  return session;
}

function handleOps(session: Session, envelopes: OpEnvelope[]): void {
  if (!Array.isArray(envelopes) || envelopes.length === 0) return;
  try {
    applyOps(session.docId, envelopes.map((e) => ({
      ...e,
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
