/**
 * Editor state.
 *
 * The document is held as a mutable object and mutated in place by `applyOp`,
 * with a `version` counter driving re-renders. Cloning the whole document on
 * every op is the obvious alternative and is too slow during a drag, which
 * produces dozens of ops a second on documents with thousands of nodes.
 */

import { create } from 'zustand';
import {
  type CanvasDocument, type CanvasNode, type NodeId, type Op, type OpEnvelope, type Page,
  applyOp, artboardOf, batchId, descendants,
} from '@canvas/shared';

export type Tool = 'move' | 'frame' | 'text' | 'rect' | 'ellipse' | 'image' | 'hand';

export interface Viewport { x: number; y: number; zoom: number }

export interface PeerInfo {
  clientId: string; name: string; color: string;
  kind: 'human' | 'agent'; selection: string[];
  cursor?: { x: number; y: number }; pageId?: string;
}

export interface AgentActivity {
  active: boolean;
  agent: string;
  summary: string | null;
  artboards: NodeId[];
  at: number;
}

export interface Toast { id: string; message: string; tone: 'info' | 'error' | 'success' }

interface UndoEntry { ops: Op[]; selection: NodeId[] }

interface CanvasState {
  docId: string | null;
  doc: CanvasDocument | null;
  version: number;
  rev: number;
  pageId: string | null;

  connection: 'connecting' | 'open' | 'closed';
  /** A non-retryable problem (e.g. the document does not exist). */
  fatalError: string | null;
  peers: PeerInfo[];
  clientId: string;

  selection: NodeId[];
  hovered: NodeId | null;
  editingText: NodeId | null;
  /** Which style variant the properties panel is editing (`null` = base). */
  activeVariant: string | null;

  viewport: Viewport;
  tool: Tool;
  spacePanning: boolean;

  undoStack: UndoEntry[];
  redoStack: UndoEntry[];

  agentActivity: AgentActivity | null;
  toasts: Toast[];

  /** Set by the socket layer; sends ops to the server. */
  send: ((envelopes: OpEnvelope[]) => void) | null;
}

interface CanvasActions {
  loadDocument(doc: CanvasDocument): void;
  setConnection(s: CanvasState['connection']): void;
  setFatalError(message: string | null): void;
  setPeers(p: PeerInfo[]): void;
  setSend(fn: CanvasState['send']): void;

  /** Applies ops locally, pushes undo, and sends them to the server. */
  dispatch(ops: Op[], opts?: { batch?: string; skipUndo?: boolean }): void;
  /** Applies ops received from the server or an agent without touching undo. */
  applyRemote(ops: { op: Op; rev: number }[]): void;
  /**
   * Records a single undo entry for a gesture whose intermediate frames were
   * dispatched with `skipUndo` — a drag or resize should be one undo step, not
   * one per pointermove.
   */
  pushUndo(inverseOps: Op[], selection: NodeId[]): void;
  undo(): void;
  redo(): void;

  select(ids: NodeId[], additive?: boolean): void;
  toggleSelect(id: NodeId): void;
  setHovered(id: NodeId | null): void;
  setEditingText(id: NodeId | null): void;
  setActiveVariant(v: string | null): void;

  setViewport(v: Partial<Viewport>): void;
  setTool(t: Tool): void;
  setSpacePanning(v: boolean): void;
  setPage(id: string): void;

  setAgentActivity(a: AgentActivity | null): void;
  toast(message: string, tone?: Toast['tone']): void;
  dismissToast(id: string): void;
}

const MAX_UNDO = 200;

export const useCanvas = create<CanvasState & CanvasActions>((set, get) => ({
  docId: null,
  doc: null,
  version: 0,
  rev: 0,
  pageId: null,
  connection: 'connecting',
  fatalError: null,
  peers: [],
  clientId: `c_${Math.random().toString(36).slice(2, 10)}`,
  selection: [],
  hovered: null,
  editingText: null,
  activeVariant: null,
  viewport: { x: 80, y: 80, zoom: 0.55 },
  tool: 'move',
  spacePanning: false,
  undoStack: [],
  redoStack: [],
  agentActivity: null,
  toasts: [],
  send: null,

  loadDocument(doc) {
    set({
      doc, docId: doc.id, rev: doc.rev, pageId: doc.pages[0]?.id ?? null,
      version: get().version + 1, selection: [], undoStack: [], redoStack: [],
      fatalError: null,
    });
  },

  setConnection(connection) { set({ connection }); },
  setFatalError(fatalError) { set({ fatalError }); },
  setPeers(peers) { set({ peers: peers.filter((p) => p.clientId !== get().clientId) }); },
  setSend(send) { set({ send }); },

  dispatch(ops, opts) {
    const { doc, send, selection, undoStack } = get();
    if (!doc || ops.length === 0) return;
    const batch = opts?.batch ?? batchId();

    const inverses: Op[] = [];
    try {
      for (const op of ops) inverses.unshift(applyOp(doc, op));
    } catch (err) {
      // Roll back whatever applied before the failure so local state stays sane.
      for (const inv of inverses) { try { applyOp(doc, inv); } catch { /* best effort */ } }
      get().toast(err instanceof Error ? err.message : String(err), 'error');
      return;
    }

    doc.rev += ops.length;
    set({
      version: get().version + 1,
      rev: doc.rev,
      undoStack: opts?.skipUndo ? undoStack : [...undoStack, { ops: inverses, selection }].slice(-MAX_UNDO),
      redoStack: opts?.skipUndo ? get().redoStack : [],
    });

    send?.(ops.map((op) => ({
      op, batch,
      origin: { kind: 'human', id: get().clientId },
    })));
  },

  applyRemote(ops) {
    const { doc } = get();
    if (!doc) return;
    let changed = false;
    for (const { op, rev } of ops) {
      // The server echoes our own ops back; skip anything we already applied.
      if (rev <= doc.rev) continue;
      try { applyOp(doc, op); doc.rev = rev; changed = true; }
      catch { /* a diverged op is recovered by the server's `rejected` resync */ }
    }
    if (changed) set({ version: get().version + 1, rev: doc.rev });
  },

  pushUndo(inverseOps, selection) {
    if (!inverseOps.length) return;
    set({
      undoStack: [...get().undoStack, { ops: inverseOps, selection }].slice(-MAX_UNDO),
      redoStack: [],
    });
  },

  undo() {
    const { undoStack, doc } = get();
    const entry = undoStack[undoStack.length - 1];
    if (!entry || !doc) return;
    const selectionBefore = get().selection;

    const redoOps: Op[] = [];
    for (const op of entry.ops) {
      try { redoOps.unshift(applyOp(doc, op)); }
      catch { get().toast('Could not undo — the document changed underneath.', 'error'); return; }
    }
    doc.rev += entry.ops.length;

    set({
      version: get().version + 1,
      rev: doc.rev,
      undoStack: undoStack.slice(0, -1),
      redoStack: [...get().redoStack, { ops: redoOps, selection: selectionBefore }].slice(-MAX_UNDO),
      selection: entry.selection.filter((id) => doc.nodes[id]),
    });

    get().send?.(entry.ops.map((op) => ({ op, origin: { kind: 'human' as const, id: get().clientId } })));
  },

  redo() {
    const { redoStack, doc } = get();
    const entry = redoStack[redoStack.length - 1];
    if (!entry || !doc) return;
    const selectionBefore = get().selection;

    const undoOps: Op[] = [];
    for (const op of entry.ops) {
      try { undoOps.unshift(applyOp(doc, op)); }
      catch { get().toast('Could not redo — the document changed underneath.', 'error'); return; }
    }
    doc.rev += entry.ops.length;

    set({
      version: get().version + 1,
      rev: doc.rev,
      redoStack: redoStack.slice(0, -1),
      undoStack: [...get().undoStack, { ops: undoOps, selection: selectionBefore }].slice(-MAX_UNDO),
      selection: entry.selection.filter((id) => doc.nodes[id]),
    });

    get().send?.(entry.ops.map((op) => ({ op, origin: { kind: 'human' as const, id: get().clientId } })));
  },

  select(ids, additive) {
    const current = get().selection;
    const next = additive ? [...new Set([...current, ...ids])] : ids;
    if (next.length === current.length && next.every((id, i) => id === current[i])) return;
    set({ selection: next, editingText: null, activeVariant: null });
  },

  toggleSelect(id) {
    const current = get().selection;
    set({ selection: current.includes(id) ? current.filter((x) => x !== id) : [...current, id] });
  },

  setHovered(hovered) { if (get().hovered !== hovered) set({ hovered }); },
  setEditingText(editingText) { set({ editingText }); },
  setActiveVariant(activeVariant) { set({ activeVariant }); },

  setViewport(v) { set({ viewport: { ...get().viewport, ...v } }); },
  setTool(tool) { set({ tool }); },
  setSpacePanning(spacePanning) { set({ spacePanning }); },
  setPage(pageId) { set({ pageId, selection: [] }); },

  setAgentActivity(agentActivity) { set({ agentActivity }); },

  toast(message, tone = 'info') {
    const id = `t_${Math.random().toString(36).slice(2, 8)}`;
    set({ toasts: [...get().toasts, { id, message, tone }] });
    setTimeout(() => get().dismissToast(id), tone === 'error' ? 8000 : 3500);
  },

  dismissToast(id) { set({ toasts: get().toasts.filter((t) => t.id !== id) }); },
}));

// ---------------------------------------------------------------------------
// Selectors and derived helpers
// ---------------------------------------------------------------------------

export function getDoc(): CanvasDocument | null { return useCanvas.getState().doc; }

export function getNodeById(id: NodeId | null | undefined): CanvasNode | undefined {
  if (!id) return undefined;
  return useCanvas.getState().doc?.nodes[id];
}

export function currentPage(): Page | undefined {
  const { doc, pageId } = useCanvas.getState();
  if (!doc) return undefined;
  return doc.pages.find((p) => p.id === pageId) ?? doc.pages[0];
}

/** Drops nodes whose ancestor is also selected — what "move the selection" means. */
export function topLevelSelection(ids: NodeId[]): NodeId[] {
  const doc = getDoc();
  if (!doc) return ids;
  const set = new Set(ids);
  return ids.filter((id) => {
    let p = doc.nodes[id]?.parent;
    while (p) { if (set.has(p)) return false; p = doc.nodes[p]?.parent; }
    return true;
  });
}

export function selectionArtboards(ids: NodeId[]): NodeId[] {
  const doc = getDoc();
  if (!doc) return [];
  return [...new Set(ids.map((id) => artboardOf(doc, id)).filter((x): x is NodeId => !!x))];
}

export function subtreeSize(id: NodeId): number {
  const doc = getDoc();
  return doc ? 1 + descendants(doc, id).length : 1;
}
