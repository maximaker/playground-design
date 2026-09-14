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
  applyOp, artboardOf, batchId, descendants, touchedNodes,
} from '@playground/shared';
import { styleOps, textOps, treeNodeId } from './keys.ts';

export type Tool = 'move' | 'frame' | 'text' | 'rect' | 'ellipse' | 'image' | 'hand' | 'note';

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
  /**
   * Per-node change counters. Node components subscribe to their own entry, so
   * a style edit re-renders one element rather than the whole document.
   */
  nodeVersions: Record<NodeId, number>;
  /** Bumped when children lists, tokens, pages or components change. */
  structureVersion: number;
  /**
   * Bumped only by changes that can affect an artboard's generated stylesheet
   * or font set — variant styles, font-family, tokens, structure.
   *
   * Rebuilding those means walking an artboard's whole subtree, so keying them
   * to the document-wide version made every drag frame O(nodes).
   */
  styleEpoch: number;
  rev: number;
  pageId: string | null;

  connection: 'connecting' | 'open' | 'closed';
  /** How this client is syncing. Polling has no presence and no agent RPC. */
  transport: 'websocket' | 'polling';
  /** A non-retryable problem (e.g. the document does not exist). */
  fatalError: string | null;
  peers: PeerInfo[];
  clientId: string;

  selection: NodeId[];
  hovered: NodeId | null;
  /** Node to show distance readouts to, set while Alt/Option is held. */
  measureTo: NodeId | null;
  /** Prompt cards are selected separately from design nodes. */
  selectedNote: string | null;
  editingText: NodeId | null;
  /** Which style variant the properties panel is editing (`null` = base). */
  activeVariant: string | null;
  /**
   * When set, edits to the component definition are recorded into this variant
   * rather than the base component.
   */
  editingVariant: { componentId: string; match: Record<string, string> } | null;

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
  setTransport(t: CanvasState['transport']): void;
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
  setMeasureTo(id: NodeId | null): void;
  selectNote(id: string | null): void;
  setEditingText(id: NodeId | null): void;
  setActiveVariant(v: string | null): void;
  setEditingVariant(v: { componentId: string; match: Record<string, string> } | null): void;
  /** Writes text to a node or, for a key inside an instance, to its override. */
  setNodeText(key: string, text: string): void;
  /** Writes styles, routing each key to a node or an instance override. */
  setNodeStyles(keys: string[], styles: Record<string, string>, selector?: string): void;

  setViewport(v: Partial<Viewport>): void;
  setTool(t: Tool): void;
  setSpacePanning(v: boolean): void;
  setPage(id: string): void;

  setAgentActivity(a: AgentActivity | null): void;
  toast(message: string, tone?: Toast['tone']): void;
  dismissToast(id: string): void;
}

const MAX_UNDO = 200;

/**
 * Applies the change-tracking side of a batch of ops.
 *
 * A change to a component definition has to invalidate every instance of that
 * component, because those instances render the definition.
 */
function trackChanges(
  doc: CanvasDocument,
  ops: Op[],
  versions: Record<NodeId, number>,
): { nodeVersions: Record<NodeId, number>; structureBump: number; styleBump: number } {
  const next = { ...versions };
  let structureBump = 0;
  let styleBump = 0;

  const bump = (id: NodeId) => { next[id] = (next[id] ?? 0) + 1; };

  const definitionRoots = Object.values(doc.components ?? {});

  for (const op of ops) {
    const touched = touchedNodes(op);
    if (touched.global) { structureBump = 1; styleBump = 1; }
    for (const id of touched.structure) { bump(id); structureBump = 1; styleBump = 1; }

    // Only these can change an artboard's generated stylesheet or font set.
    if (op.t === 'styles') {
      const affects = op.updates.some(
        (u) => u.selector !== undefined || Object.keys(u.styles).some((k) => k === 'font-family'),
      );
      if (affects) styleBump = 1;
    }
    if (op.t === 'tokens' || op.t === 'variant' || op.t === 'override' || op.t === 'props') styleBump = 1;
    if (op.t === 'breakpoints') styleBump = 1;

    for (const id of touched.nodes) {
      bump(id);
      // Walk up to see whether this node belongs to a component definition.
      let cursor: NodeId | null = id;
      let guard = 0;
      while (cursor && guard++ < 200) {
        const owner = definitionRoots.find((c) => c.root === cursor);
        if (owner) {
          for (const node of Object.values(doc.nodes)) {
            if (node.type === 'instance' && node.componentRef === owner.id) bump(node.id);
          }
          break;
        }
        cursor = doc.nodes[cursor]?.parent ?? null;
      }
    }
  }

  return { nodeVersions: next, structureBump, styleBump };
}

export const useCanvas = create<CanvasState & CanvasActions>((set, get) => ({
  docId: null,
  doc: null,
  version: 0,
  nodeVersions: {},
  structureVersion: 0,
  styleEpoch: 0,
  rev: 0,
  pageId: null,
  connection: 'connecting',
  transport: 'websocket',
  fatalError: null,
  peers: [],
  clientId: `c_${Math.random().toString(36).slice(2, 10)}`,
  selection: [],
  hovered: null,
  measureTo: null,
  selectedNote: null,
  editingText: null,
  activeVariant: null,
  editingVariant: null,
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
      nodeVersions: {}, structureVersion: get().structureVersion + 1,
      styleEpoch: get().styleEpoch + 1,
      fatalError: null,
    });
  },

  setConnection(connection) { set({ connection }); },
  setTransport(transport) { set({ transport }); },
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
    const tracked = trackChanges(doc, ops, get().nodeVersions);
    set({
      version: get().version + 1,
      nodeVersions: tracked.nodeVersions,
      structureVersion: get().structureVersion + tracked.structureBump,
      styleEpoch: get().styleEpoch + tracked.styleBump,
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
    const applied: Op[] = [];
    for (const { op, rev } of ops) {
      // The server echoes our own ops back; skip anything we already applied.
      if (rev <= doc.rev) continue;
      try { applyOp(doc, op); doc.rev = rev; applied.push(op); }
      catch { /* a diverged op is recovered by the server's `rejected` resync */ }
    }
    if (applied.length) {
      const tracked = trackChanges(doc, applied, get().nodeVersions);
      set({
        version: get().version + 1,
        nodeVersions: tracked.nodeVersions,
        structureVersion: get().structureVersion + tracked.structureBump,
        styleEpoch: get().styleEpoch + tracked.styleBump,
        rev: doc.rev,
      });
    }
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
    const tracked = trackChanges(doc, entry.ops, get().nodeVersions);

    set({
      version: get().version + 1,
      nodeVersions: tracked.nodeVersions,
      structureVersion: get().structureVersion + tracked.structureBump,
      styleEpoch: get().styleEpoch + tracked.styleBump,
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
    const tracked = trackChanges(doc, entry.ops, get().nodeVersions);

    set({
      version: get().version + 1,
      nodeVersions: tracked.nodeVersions,
      structureVersion: get().structureVersion + tracked.structureBump,
      styleEpoch: get().styleEpoch + tracked.styleBump,
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
    set({ selection: next, editingText: null, activeVariant: null, selectedNote: null });
  },

  toggleSelect(id) {
    const current = get().selection;
    set({ selection: current.includes(id) ? current.filter((x) => x !== id) : [...current, id] });
  },

  setHovered(hovered) { if (get().hovered !== hovered) set({ hovered }); },
  setMeasureTo(measureTo) { if (get().measureTo !== measureTo) set({ measureTo }); },
  selectNote(selectedNote) { set({ selectedNote, selection: selectedNote ? [] : get().selection }); },
  setEditingText(editingText) { set({ editingText }); },
  setActiveVariant(activeVariant) { set({ activeVariant }); },
  setEditingVariant(editingVariant) { set({ editingVariant }); },

  setNodeText(key, text) {
    const ops = textOps(get().doc, key, text, get().editingVariant);
    if (ops.length) get().dispatch(ops);
  },

  setNodeStyles(keys, styles, selector) {
    const ops = styleOps(get().doc, keys, styles, selector, get().editingVariant);
    if (ops.length) get().dispatch(ops);
  },

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

// Diagnostics hook. Exposing the store makes it possible to profile the editor
// from the console against a real document, which is the only way to find the
// costs that only appear at scale.
if (typeof window !== 'undefined') {
  (window as unknown as { __playground?: unknown }).__playground = { store: useCanvas };
}

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
/**
 * Reduces a selection to the nodes that actually live in the tree, dropping any
 * whose ancestor is also selected. Keys inside a component instance collapse to
 * the instance itself — that is the thing that can be moved or deleted.
 */
export function topLevelSelection(keys: string[]): NodeId[] {
  const doc = getDoc();
  const ids = [...new Set(keys.map(treeNodeId))];
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

/** A node's own change counter, for per-node subscriptions. */
export function useNodeVersion(id: NodeId): number {
  return useCanvas((s) => s.nodeVersions[id] ?? 0);
}

export function subtreeSize(id: NodeId): number {
  const doc = getDoc();
  return doc ? 1 + descendants(doc, id).length : 1;
}
