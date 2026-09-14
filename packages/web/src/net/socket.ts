/**
 * Realtime connection to the server.
 *
 * Carries document ops and presence, and answers RPCs from agents that need
 * something only a live browser knows — computed styles, measured geometry, or
 * a rasterized screenshot.
 */

import type { CanvasDocument, OpEnvelope, Op } from '@playground/shared';
import { useCanvas } from '../state/store.ts';
import { findElement, nodeRect } from '../canvas/registry.ts';
import { rasterizeNode } from './rasterize.ts';

const WS_URL = () => {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
};

export interface Connection { close(): void }

/**
 * How long to give the WebSocket before starting to poll as well.
 *
 * Serverless hosts (Vercel among them) cannot hold a WebSocket open at all.
 * Waiting out reconnection attempts first left the editor showing "Connecting"
 * for several seconds on every load there, so instead the two race: a local
 * socket opens in milliseconds and wins, and where sockets are impossible the
 * document is up almost as fast. If the socket connects later, polling stops.
 */
const WS_GRACE_MS = 1200;
const POLL_INTERVAL_MS = 1500;

/**
 * What this tab is connected to.
 *
 * A viewer holds only a share token and never learns the document id — that id
 * is the edit credential, so handing it over would make the read-only link a
 * formality. Every request a viewer makes is therefore addressed by token.
 */
export type Source =
  | { kind: 'doc'; id: string }
  | { kind: 'share'; token: string };

export function connectDocument(source: Source): Connection {
  const readOnly = source.kind === 'share';
  const syncUrl = (rev: number) => source.kind === 'share'
    ? `/api/shares/${source.token}/sync?rev=${rev}`
    : `/api/documents/${source.id}/sync?rev=${rev}`;

  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 0;
  let presenceTimer: number | undefined;
  let pollTimer: number | undefined;
  let graceTimer: number | undefined;
  let polling = false;

  const store = useCanvas;

  /** HTTP polling fallback: fetch ops since our revision, or resync wholesale. */
  const poll = async () => {
    if (closed) return;
    try {
      const rev = store.getState().rev;
      const res = await fetch(syncUrl(rev));
      if (!res.ok) throw new Error(`sync failed: ${res.status}`);
      const body = (await res.json()) as {
        resync?: boolean; document?: CanvasDocument;
        ops?: { op: Op; rev: number; origin: { kind: string; label?: string } }[];
      };

      if (body.resync && body.document) store.getState().loadDocument(body.document);
      else if (body.ops?.length) store.getState().applyRemote(body.ops);

      store.getState().setConnection('open');
    } catch {
      store.getState().setConnection('closed');
    } finally {
      if (!closed) pollTimer = window.setTimeout(poll, POLL_INTERVAL_MS);
    }
  };

  const stopPolling = () => {
    polling = false;
    clearTimeout(pollTimer);
    clearTimeout(graceTimer);
  };

  const startPolling = async () => {
    if (polling || closed) return;
    polling = true;
    store.getState().setTransport('polling');

    // Load the document once up front, since there is no `joined` message.
    try {
      const res = await fetch(source.kind === 'share'
        ? `/api/shares/${source.token}`
        : `/api/documents/${source.id}`);
      if (res.ok) {
        const body = (await res.json()) as { document: CanvasDocument };
        store.getState().loadDocument(body.document);
        store.getState().setConnection('open');
        // A viewer has nowhere to send ops, and the server would refuse them
        // anyway; leaving `send` unset keeps the store from pretending.
        if (!readOnly && source.kind === 'doc') {
          const id = source.id;
          store.getState().setSend((envelopes: OpEnvelope[]) => {
            // Fire-and-forget: the optimistic local apply already happened.
            void fetch(`/api/documents/${id}/ops`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ ops: envelopes }),
            });
          });
        }
      } else if (res.status === 404) {
        store.getState().setFatalError(readOnly
          ? 'This link has been revoked or never existed.'
          : `document ${(source as { id: string }).id} not found`);
        closed = true;
        return;
      }
    } catch {
      store.getState().setConnection('closed');
    }
    pollTimer = window.setTimeout(poll, POLL_INTERVAL_MS);
  };

  const open = () => {
    if (closed) return;
    store.getState().setConnection(retry === 0 ? 'connecting' : 'connecting');
    ws = new WebSocket(WS_URL());

    ws.onopen = () => {
      retry = 0;
      // The socket won the race; polling is redundant from here.
      stopPolling();
      ws!.send(JSON.stringify({
        type: 'join',
        ...(source.kind === 'share' ? { shareToken: source.token } : { docId: source.id }),
        clientId: store.getState().clientId,
        name: localStorage.getItem('canvas.name') ?? undefined,
      }));
    };

    ws.onmessage = (ev) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(ev.data as string) as Record<string, unknown>; } catch { return; }
      handle(msg);
    };

    ws.onclose = () => {
      if (closed) return;
      if (!polling) {
        store.getState().setConnection('closed');
        // Back off, but stay responsive: a dev server restart should reconnect fast.
        const delay = Math.min(10_000, 400 * 2 ** retry++);
        setTimeout(open, delay);
      }
    };

    ws.onerror = () => ws?.close();
  };

  const send = (msg: unknown) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  const handle = (msg: Record<string, unknown>) => {
    switch (msg.type) {
      case 'joined': {
        store.getState().loadDocument(msg.doc as CanvasDocument);
        store.getState().setConnection('open');
        store.getState().setTransport('websocket');
        if (msg.canWrite !== false) {
          store.getState().setSend((envelopes: OpEnvelope[]) => send({ type: 'ops', ops: envelopes }));
        }
        break;
      }
      case 'ops': {
        const ops = msg.ops as { op: Op; rev: number; origin: { kind: string; label?: string } }[];
        store.getState().applyRemote(ops);
        const agentOps = ops.filter((o) => o.origin?.kind === 'agent');
        if (agentOps.length) {
          const label = agentOps[0]!.origin.label ?? 'An agent';
          store.getState().toast(`${label} made ${agentOps.length} change${agentOps.length === 1 ? '' : 's'}`, 'info');
        }
        break;
      }
      case 'rejected': {
        // Our optimistic state diverged; take the server's document.
        store.getState().toast(String(msg.message ?? 'Change rejected'), 'error');
        if (msg.doc) store.getState().loadDocument(msg.doc as CanvasDocument);
        break;
      }
      case 'peers': {
        store.getState().setPeers(msg.peers as never);
        break;
      }
      case 'notify': {
        const payload = msg.payload as { kind: string; active: boolean; agent: string; summary: string | null; artboards?: string[] };
        if (payload.kind === 'agent-working') {
          store.getState().setAgentActivity(payload.active
            ? { active: true, agent: payload.agent, summary: payload.summary, artboards: payload.artboards ?? [], at: Date.now() }
            : null);
          if (!payload.active && payload.summary) store.getState().toast(`${payload.agent}: ${payload.summary}`, 'success');
        }
        break;
      }
      case 'ping': {
        send({ type: 'pong' });
        break;
      }
      case 'rpc': {
        void handleRpc(msg, send);
        break;
      }
      case 'error': {
        const message = String(msg.message ?? 'Server error');
        store.getState().toast(message, 'error');
        // A missing document will never appear by retrying; stop the loop and
        // let the UI say so rather than spinning on "Reconnecting…".
        if (/not found/i.test(message)) {
          store.getState().setFatalError(message);
          closed = true;
          store.getState().setConnection('closed');
          ws?.close();
        }
        break;
      }
    }
  };

  // Presence is throttled: selection changes fire on every click and the server
  // rebroadcasts to every peer.
  const unsubscribe = store.subscribe((state, prev) => {
    if (state.selection === prev.selection && state.pageId === prev.pageId) return;
    clearTimeout(presenceTimer);
    presenceTimer = window.setTimeout(
      () => send({ type: 'presence', selection: state.selection, pageId: state.pageId }),
      80,
    );
  });

  open();
  // If the socket has not opened by now, this host probably cannot hold one.
  graceTimer = window.setTimeout(() => {
    if (!closed && ws?.readyState !== WebSocket.OPEN) void startPolling();
  }, WS_GRACE_MS);

  return {
    close() {
      closed = true;
      unsubscribe();
      clearTimeout(presenceTimer);
      clearTimeout(pollTimer);
      clearTimeout(graceTimer);
      ws?.close();
    },
  };
}

async function handleRpc(msg: Record<string, unknown>, send: (m: unknown) => void): Promise<void> {
  const id = msg.id;
  const params = (msg.params ?? {}) as Record<string, unknown>;
  try {
    const result = await runRpc(String(msg.method), params);
    send({ type: 'rpc-result', id, ok: true, result });
  } catch (err) {
    send({ type: 'rpc-result', id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

async function runRpc(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case 'computedStyles': {
      const ids = (params.ids ?? []) as string[];
      const properties = params.properties as string[] | undefined;
      const out: Record<string, unknown> = {};
      for (const id of ids) {
        const el = findElement(id);
        if (!el) { out[id] = null; continue; }
        const computed = el.ownerDocument.defaultView!.getComputedStyle(el);
        const styles: Record<string, string> = {};
        if (properties?.length) {
          for (const p of properties) styles[p] = computed.getPropertyValue(p);
        } else {
          // The full computed set is hundreds of properties; send the ones that
          // actually explain a layout.
          for (const p of NOTABLE_PROPERTIES) styles[p] = computed.getPropertyValue(p);
        }
        const rect = el.getBoundingClientRect();
        out[id] = {
          computed: styles,
          box: { width: round(rect.width), height: round(rect.height) },
          scrollSize: { width: el.scrollWidth, height: el.scrollHeight },
          overflowing: el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1,
        };
      }
      return out;
    }

    case 'screenshot': {
      return rasterizeNode(
        String(params.nodeId),
        Number(params.scale ?? 1),
        String(params.format ?? 'png'),
      );
    }

    case 'setSelection': {
      const ids = (params.ids ?? []) as string[];
      useCanvas.getState().select(ids);
      const rect = ids[0] ? nodeRect(ids[0]) : null;
      if (rect) scrollRectIntoView(rect);
      return { ok: true };
    }

    case 'measure': {
      const ids = (params.ids ?? []) as string[];
      return Object.fromEntries(ids.map((id) => {
        const el = findElement(id);
        if (!el) return [id, null];
        const r = el.getBoundingClientRect();
        return [id, { width: round(r.width), height: round(r.height) }];
      }));
    }

    default:
      throw new Error(`unknown RPC method "${method}"`);
  }
}

const NOTABLE_PROPERTIES = [
  'display', 'position', 'flex-direction', 'align-items', 'justify-content', 'gap', 'flex',
  'width', 'height', 'min-width', 'max-width', 'padding', 'margin', 'box-sizing',
  'background-color', 'color', 'font-family', 'font-size', 'font-weight', 'line-height',
  'border-radius', 'border', 'box-shadow', 'opacity', 'overflow', 'z-index', 'text-align',
];

function round(n: number): number { return Math.round(n * 100) / 100; }

/** Pans the canvas so a rect is comfortably in view. */
function scrollRectIntoView(rect: DOMRect): void {
  const { viewport, setViewport } = useCanvas.getState();
  const margin = 120;
  let { x, y } = viewport;
  if (rect.left < margin) x += margin - rect.left;
  if (rect.top < margin) y += margin - rect.top;
  if (rect.right > window.innerWidth - margin) x -= rect.right - (window.innerWidth - margin);
  if (rect.bottom > window.innerHeight - margin) y -= rect.bottom - (window.innerHeight - margin);
  if (x !== viewport.x || y !== viewport.y) setViewport({ x, y });
}
