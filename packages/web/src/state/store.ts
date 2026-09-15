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
  type CanvasDocument, type CanvasNode, type Comment, type NodeId, type Op, type OpEnvelope, type Page,
  applyOp, artboardOf, batchId, descendants, touchedNodes,
} from '@playground/shared';
import { styleOps, textOps, treeNodeId } from './keys.ts';
import { type CanvasPrefs, loadCanvasPrefs, saveCanvasPrefs } from './canvasPrefs.ts';

export type Tool = 'move' | 'frame' | 'text' | 'rect' | 'ellipse' | 'image' | 'hand' | 'note' | 'comment';

export interface Viewport { x: number; y: number; zoom: number }

export interface PeerInfo {
  clientId: string; name: string; color: string;
  kind: 'human' | 'agent'; selection: string[];
  cursor?: { x: number; y: number }; pageId?: string;
}

/** The half of a peer that changes constantly. */
export interface PeerCursor {
  clientId: string; name: string; color: string;
  kind: 'human' | 'agent';
  cursor?: { x: number; y: number };
  pageId?: string;
}

/** Everything about a peer except where their pointer is this instant. */
function sameIdentity(a: PeerInfo[], b: PeerInfo[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((p, i) => {
    const q = b[i]!;
    return p.clientId === q.clientId && p.name === q.name && p.color === q.color
      && p.pageId === q.pageId && p.selection.length === q.selection.length
      && p.selection.every((id, j) => id === q.selection[j]);
  });
}

export interface AgentChange {
  /** Who made it, for the review bar. */
  agent: string;
  at: number;
  /** Layers that still exist and can be shown. */
  nodeIds: NodeId[];
  /** Layers that were deleted — countable, not highlightable. */
  removed: number;
  /**
   * Inverses of the agent's ops, newest first, so the whole run can be taken
   * back in one action. Collected as the ops are applied because that is the
   * only moment the inverses exist — recomputing them later would mean
   * reconstructing a document state that has already moved on.
   */
  inverses: Op[];
  /** The op count, which is what the review bar counts. */
  ops: number;
}

export interface AgentActivity {
  active: boolean;
  agent: string;
  summary: string | null;
  artboards: NodeId[];
  at: number;
}

export interface Toast { id: string; message: string; tone: 'info' | 'error' | 'success' }

interface UndoEntry {
  ops: Op[];
  selection: NodeId[];
  /**
   * Set when the edit is one step of a continuous gesture — a scrub, a held
   * arrow key. Consecutive steps sharing a key fold into the entry that is
   * already on the stack, because that entry's inverse already restores the
   * value the gesture started from. Without this a two-second drag leaves
   * ninety undo steps and Cmd-Z stops meaning anything.
   */
  coalesceKey?: string;
  at?: number;
}

/** How long a gesture can pause before the next step starts a new undo entry. */
const COALESCE_WINDOW_MS = 900;

interface CanvasState {
  docId: string | null;
  /**
   * True for a tab opened through a share link. The server refuses writes from
   * such a session regardless; this is what stops the UI from *offering* edits
   * it knows will bounce, and from showing an optimistic change that is about
   * to be taken back.
   */
  readOnly: boolean;
  /** This tab's pointer in world coordinates, broadcast to peers. */
  pointer: { x: number; y: number } | null;
  /** Peers again, but the fast-moving half — see `setPeers`. */
  peerCursors: PeerCursor[];
  /**
   * What an agent changed while you were watching, so it can be reviewed rather
   * than taken on trust. History records that a change happened; this records
   * *which layers*, which is the question you actually have.
   */
  agentChange: AgentChange | null;
  /** The comment thread currently expanded on the canvas. */
  openComment: string | null;
  showResolvedComments: boolean;
  /**
   * A comment being written but not yet posted. Kept local so an accidental
   * click with the comment tool does not leave an empty pin on the design for
   * everyone else to wonder about.
   */
  draftComment: Comment | null;
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
  /** Dot grid, edge rulers and snapping — a per-person preference, stored locally. */
  canvasPrefs: CanvasPrefs;
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
  setReadOnly(readOnly: boolean): void;
  setPeers(p: PeerInfo[]): void;
  setPointer(pointer: { x: number; y: number } | null): void;
  dismissAgentChange(): void;
  revertAgentChange(): void;
  setOpenComment(id: string | null): void;
  setDraftComment(comment: Comment | null): void;
  setShowResolvedComments(show: boolean): void;
  setSend(fn: CanvasState['send']): void;

  /** Applies ops locally, pushes undo, and sends them to the server. */
  dispatch(ops: Op[], opts?: { batch?: string; skipUndo?: boolean; coalesce?: string }): void;
  /** Applies ops received from the server or an agent without touching undo. */
  applyRemote(ops: { op: Op; rev: number; origin?: { kind: string; id?: string; label?: string } }[]): void;
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
  setNodeStyles(
    keys: string[],
    styles: Record<string, string>,
    selector?: string,
    opts?: { coalesce?: string },
  ): void;

  setViewport(v: Partial<Viewport>): void;
  setCanvasPrefs(v: Partial<CanvasPrefs>): void;
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

/**
 * Adds an entry to the undo stack, folding it into the previous one when both
 * belong to the same continuous gesture. The older entry is kept: its inverse
 * restores the state the gesture began from, which is what one Cmd-Z should do.
 */
function pushEntry(stack: UndoEntry[], entry: UndoEntry): UndoEntry[] {
  const last = stack[stack.length - 1];
  if (
    entry.coalesceKey &&
    last?.coalesceKey === entry.coalesceKey &&
    entry.at! - (last.at ?? 0) < COALESCE_WINDOW_MS
  ) {
    return [...stack.slice(0, -1), { ...last, at: entry.at }];
  }
  return [...stack, entry].slice(-MAX_UNDO);
}

export const useCanvas = create<CanvasState & CanvasActions>((set, get) => ({
  agentChange: null,
  docId: null,
  readOnly: false,
  pointer: null,
  peerCursors: [],
  openComment: null,
  showResolvedComments: false,
  draftComment: null,
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
  canvasPrefs: loadCanvasPrefs(),
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
  setReadOnly(readOnly) { set({ readOnly }); },
  /**
   * Peers arrive as one list, but it is split into two slices deliberately.
   *
   * A cursor moves twenty times a second; a selection changes on a click. The
   * overlay measures a rect per selected node, and measuring inside an artboard
   * iframe forces that document to lay out — so letting cursor churn invalidate
   * the selection slice would put the editor into permanent layout thrash the
   * moment a second person joined. `peers` is replaced only when the parts that
   * cost something to render actually change.
   */
  setPeers(incoming) {
    const peers = incoming.filter((p) => p.clientId !== get().clientId);
    set({ peerCursors: peers.map((p) => ({
      clientId: p.clientId, name: p.name, color: p.color, kind: p.kind,
      cursor: p.cursor, pageId: p.pageId,
    })) });
    if (!sameIdentity(get().peers, peers)) set({ peers });
  },

  /**
   * This tab's pointer, in canvas world coordinates rather than screen ones.
   *
   * Everyone is at a different zoom and scroll position, so a screen point is
   * meaningless to a peer — sending it would put their cursor somewhere else on
   * the design. World coordinates are the only shared frame of reference.
   */
  dismissAgentChange() { set({ agentChange: null }); },

  /** Takes back an agent's run, as a normal local edit so it is itself undoable. */
  revertAgentChange() {
    const change = get().agentChange;
    if (!change?.inverses.length) return;
    set({ agentChange: null });
    get().dispatch(change.inverses);
    get().toast(`Reverted ${change.ops} change${change.ops === 1 ? '' : 's'} from ${change.agent}`, 'success');
  },

  setOpenComment(openComment) { set({ openComment, draftComment: null }); },
  setDraftComment(draftComment) { set({ draftComment, openComment: null }); },
  setShowResolvedComments(showResolvedComments) { set({ showResolvedComments }); },

  setPointer(pointer) {
    // Kept out of `set` when unchanged: pointermove fires constantly and every
    // set here would re-render every subscriber.
    const prev = get().pointer;
    if (prev?.x === pointer?.x && prev?.y === pointer?.y) return;
    set({ pointer });
  },
  setSend(send) { set({ send }); },

  dispatch(ops, opts) {
    const { doc, send, selection, undoStack, readOnly } = get();
    if (!doc || ops.length === 0) return;
    // Commenting is the reason a review link exists, so it is the one thing a
    // viewer may do. The server enforces the same rule; this only keeps the UI
    // from showing an optimistic change that is about to be taken back.
    if (readOnly && !ops.every((op) => op.t === 'comment')) {
      get().toast('This is a view-only link. You can comment, but not change the design.', 'info');
      return;
    }
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
      undoStack: opts?.skipUndo ? undoStack : pushEntry(undoStack, {
        ops: inverses, selection, coalesceKey: opts?.coalesce, at: Date.now(),
      }),
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
    const agentInverses: Op[] = [];
    const agentTouched = new Set<NodeId>();
    let agentLabel: string | null = null;
    let agentRemoved = 0;

    for (const { op, rev, origin } of ops) {
      // The server echoes our own ops back; skip anything we already applied.
      if (rev <= doc.rev) continue;
      try {
        const inverse = applyOp(doc, op);
        doc.rev = rev;
        applied.push(op);

        if (origin?.kind === 'agent') {
          agentLabel = origin.label ?? agentLabel ?? 'An agent';
          agentInverses.unshift(inverse);
          const touched = touchedNodes(op);
          for (const id of [...touched.nodes, ...touched.structure]) {
            // Only nodes that survived: a deleted one has nothing to point at.
            if (doc.nodes[id]) agentTouched.add(id);
          }
          if (op.t === 'remove') agentRemoved += op.ids.length;
        }
      } catch { /* a diverged op is recovered by the server's `rejected` resync */ }
    }

    if (agentLabel) {
      const prev = get().agentChange;
      // Runs from the same agent accumulate rather than replacing each other:
      // an agent makes twenty calls to do one thing, and twenty review bars in
      // a row would be noise you learn to dismiss without reading.
      const sameRun = prev && prev.agent === agentLabel && Date.now() - prev.at < 60_000;
      set({
        agentChange: {
          agent: agentLabel,
          at: Date.now(),
          nodeIds: [...new Set([...(sameRun ? prev!.nodeIds : []), ...agentTouched])],
          removed: (sameRun ? prev!.removed : 0) + agentRemoved,
          inverses: [...agentInverses, ...(sameRun ? prev!.inverses : [])],
          ops: (sameRun ? prev!.ops : 0) + agentInverses.length,
        },
      });
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

  setNodeStyles(keys, styles, selector, opts) {
    const ops = styleOps(get().doc, keys, styles, selector, get().editingVariant);
    if (ops.length) get().dispatch(ops, opts);
  },

  setViewport(v) { set({ viewport: { ...get().viewport, ...v } }); },
  setCanvasPrefs(v) {
    const next = { ...get().canvasPrefs, ...v };
    set({ canvasPrefs: next });
    saveCanvasPrefs(next);
  },
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
