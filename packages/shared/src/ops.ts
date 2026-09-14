/**
 * Document mutation operations.
 *
 * Every edit — human, agent, or paste — goes through `applyOp`. Ops are the
 * unit of realtime broadcast, undo, and version history. `applyOp` returns the
 * inverse op, so undo is just applying what it hands back.
 *
 * Concurrency is server-authoritative: the server serializes ops and assigns
 * revisions, and clients rebase by refetching on conflict. This is a deliberate
 * simplification over a CRDT for v1 (see README "Deviations from the PRD").
 */

import {
  type CanvasDocument, type CanvasNode, type NodeId, type StyleMap, type Page,
  type Token, descendants, isAncestorOf, newId,
} from './model.ts';

export type Op =
  | { t: 'insert'; nodes: CanvasNode[]; parent: NodeId | null; index: number; page?: string }
  | { t: 'remove'; ids: NodeId[] }
  | { t: 'styles'; updates: { id: NodeId; styles: StyleMap; selector?: string }[] }
  | { t: 'text'; updates: { id: NodeId; text: string }[] }
  | { t: 'rename'; updates: { id: NodeId; name: string }[] }
  | { t: 'attrs'; updates: { id: NodeId; attrs: Record<string, string | null> }[] }
  | { t: 'meta'; updates: { id: NodeId; locked?: boolean; visible?: boolean }[] }
  | { t: 'move'; moves: { id: NodeId; parent: NodeId | null; index: number; page?: string }[] }
  | { t: 'tag'; updates: { id: NodeId; tag: string }[] }
  | { t: 'doc'; name?: string }
  | { t: 'tokens'; tokens: Token[] }
  | { t: 'page'; action: 'add' | 'remove' | 'rename'; page: Page };

export interface OpEnvelope {
  op: Op;
  /** Who made the edit, for attribution in history and the activity log. */
  origin: { kind: 'human' | 'agent' | 'system'; id: string; label?: string };
  /** Groups ops that should undo together (one drag, one agent tool call). */
  batch?: string;
  rev?: number;
  ts?: number;
}

export class OpError extends Error {}

/** Applies `op` to `doc` in place and returns the op that reverses it. */
export function applyOp(doc: CanvasDocument, op: Op): Op {
  switch (op.t) {
    case 'insert': return applyInsert(doc, op);
    case 'remove': return applyRemove(doc, op);
    case 'styles': return applyStyles(doc, op);
    case 'text': return applyText(doc, op);
    case 'rename': return applyRename(doc, op);
    case 'attrs': return applyAttrs(doc, op);
    case 'meta': return applyMeta(doc, op);
    case 'move': return applyMove(doc, op);
    case 'tag': return applyTag(doc, op);
    case 'doc': return applyDocMeta(doc, op);
    case 'tokens': return applyTokens(doc, op);
    case 'page': return applyPage(doc, op);
  }
}

function applyInsert(doc: CanvasDocument, op: Extract<Op, { t: 'insert' }>): Op {
  const roots: NodeId[] = [];
  const byId = new Map(op.nodes.map((n) => [n.id, n]));

  for (const n of op.nodes) {
    if (doc.nodes[n.id]) throw new OpError(`node ${n.id} already exists`);
    doc.nodes[n.id] = { ...n };
    // A node whose parent is not part of this insert batch is a root of it.
    if (!n.parent || !byId.has(n.parent)) roots.push(n.id);
  }

  if (op.parent === null) {
    const page = doc.pages.find((p) => p.id === op.page) ?? doc.pages[0];
    if (!page) throw new OpError('no page to insert into');
    const idx = clamp(op.index, 0, page.artboards.length);
    page.artboards.splice(idx, 0, ...roots);
    for (const id of roots) doc.nodes[id]!.parent = null;
  } else {
    const parent = doc.nodes[op.parent];
    if (!parent) throw new OpError(`parent ${op.parent} not found`);
    const idx = clamp(op.index, 0, parent.children.length);
    parent.children.splice(idx, 0, ...roots);
    for (const id of roots) doc.nodes[id]!.parent = op.parent;
  }

  return { t: 'remove', ids: roots };
}

function applyRemove(doc: CanvasDocument, op: Extract<Op, { t: 'remove' }>): Op {
  // Removing an ancestor already removes its descendants; drop redundant ids so
  // the inverse op does not try to re-insert the same node twice.
  const ids = op.ids.filter((id) => doc.nodes[id] && !op.ids.some((o) => o !== id && isAncestorOf(doc, o, id)));
  if (ids.length === 0) return { t: 'insert', nodes: [], parent: null, index: 0 };

  const first = doc.nodes[ids[0]!]!;
  const parentId = first.parent;
  const page = parentId === null ? doc.pages.find((p) => p.artboards.includes(ids[0]!)) : undefined;
  const siblings = parentId === null ? page!.artboards : doc.nodes[parentId]!.children;
  const index = siblings.indexOf(ids[0]!);

  const captured: CanvasNode[] = [];
  for (const id of ids) {
    const all = [id, ...descendants(doc, id)];
    for (const nid of all) captured.push({ ...doc.nodes[nid]!, children: [...doc.nodes[nid]!.children] });
  }

  for (const id of ids) {
    const node = doc.nodes[id]!;
    const sibs = node.parent === null
      ? doc.pages.find((p) => p.artboards.includes(id))?.artboards
      : doc.nodes[node.parent]?.children;
    if (sibs) {
      const i = sibs.indexOf(id);
      if (i >= 0) sibs.splice(i, 1);
    }
    for (const nid of [id, ...descendants(doc, id)]) delete doc.nodes[nid];
  }

  return { t: 'insert', nodes: captured, parent: parentId, index, page: page?.id };
}

function applyStyles(doc: CanvasDocument, op: Extract<Op, { t: 'styles' }>): Op {
  const inverse: { id: NodeId; styles: StyleMap; selector?: string }[] = [];
  for (const u of op.updates) {
    const node = doc.nodes[u.id];
    if (!node) continue;
    const target = u.selector ? variantStyles(node, u.selector) : node.styles;
    const before: StyleMap = {};
    for (const key of Object.keys(u.styles)) {
      // An empty value means "remove this declaration"; the inverse restores it.
      before[key] = target[key] ?? '';
      const v = u.styles[key]!;
      if (v === '') delete target[key];
      else target[key] = v;
    }
    inverse.push({ id: u.id, styles: before, selector: u.selector });
  }
  return { t: 'styles', updates: inverse };
}

function variantStyles(node: CanvasNode, selector: string): StyleMap {
  let v = node.variants.find((x) => x.selector === selector);
  if (!v) { v = { selector, styles: {} }; node.variants.push(v); }
  return v.styles;
}

function applyText(doc: CanvasDocument, op: Extract<Op, { t: 'text' }>): Op {
  const inverse: { id: NodeId; text: string }[] = [];
  for (const u of op.updates) {
    const node = doc.nodes[u.id];
    if (!node) continue;
    inverse.push({ id: u.id, text: node.text ?? '' });
    node.text = u.text;
  }
  return { t: 'text', updates: inverse };
}

function applyRename(doc: CanvasDocument, op: Extract<Op, { t: 'rename' }>): Op {
  const inverse: { id: NodeId; name: string }[] = [];
  for (const u of op.updates) {
    const node = doc.nodes[u.id];
    if (!node) continue;
    inverse.push({ id: u.id, name: node.name });
    node.name = u.name;
  }
  return { t: 'rename', updates: inverse };
}

function applyAttrs(doc: CanvasDocument, op: Extract<Op, { t: 'attrs' }>): Op {
  const inverse: { id: NodeId; attrs: Record<string, string | null> }[] = [];
  for (const u of op.updates) {
    const node = doc.nodes[u.id];
    if (!node) continue;
    const before: Record<string, string | null> = {};
    for (const k of Object.keys(u.attrs)) {
      before[k] = node.attrs[k] ?? null;
      const v = u.attrs[k];
      if (v === null || v === undefined) delete node.attrs[k];
      else node.attrs[k] = v;
    }
    inverse.push({ id: u.id, attrs: before });
  }
  return { t: 'attrs', updates: inverse };
}

function applyMeta(doc: CanvasDocument, op: Extract<Op, { t: 'meta' }>): Op {
  const inverse: { id: NodeId; locked?: boolean; visible?: boolean }[] = [];
  for (const u of op.updates) {
    const node = doc.nodes[u.id];
    if (!node) continue;
    inverse.push({ id: u.id, locked: node.locked, visible: node.visible });
    if (u.locked !== undefined) node.locked = u.locked;
    if (u.visible !== undefined) node.visible = u.visible;
  }
  return { t: 'meta', updates: inverse };
}

function applyMove(doc: CanvasDocument, op: Extract<Op, { t: 'move' }>): Op {
  const inverse: { id: NodeId; parent: NodeId | null; index: number; page?: string }[] = [];
  for (const m of op.moves) {
    const node = doc.nodes[m.id];
    if (!node) continue;
    if (m.parent && (m.parent === m.id || isAncestorOf(doc, m.id, m.parent))) {
      throw new OpError(`cannot move ${m.id} into its own subtree`);
    }

    const oldPage = node.parent === null ? doc.pages.find((p) => p.artboards.includes(m.id)) : undefined;
    const oldSibs = node.parent === null ? oldPage?.artboards : doc.nodes[node.parent]?.children;
    const oldIndex = oldSibs?.indexOf(m.id) ?? -1;
    inverse.push({ id: m.id, parent: node.parent, index: oldIndex, page: oldPage?.id });

    if (oldSibs && oldIndex >= 0) oldSibs.splice(oldIndex, 1);

    if (m.parent === null) {
      const page = doc.pages.find((p) => p.id === m.page) ?? oldPage ?? doc.pages[0]!;
      page.artboards.splice(clamp(m.index, 0, page.artboards.length), 0, m.id);
      node.parent = null;
    } else {
      const parent = doc.nodes[m.parent];
      if (!parent) throw new OpError(`parent ${m.parent} not found`);
      parent.children.splice(clamp(m.index, 0, parent.children.length), 0, m.id);
      node.parent = m.parent;
    }
  }
  // Undo in reverse so interdependent moves unwind correctly.
  return { t: 'move', moves: inverse.reverse() };
}

function applyTag(doc: CanvasDocument, op: Extract<Op, { t: 'tag' }>): Op {
  const inverse: { id: NodeId; tag: string }[] = [];
  for (const u of op.updates) {
    const node = doc.nodes[u.id];
    if (!node) continue;
    inverse.push({ id: u.id, tag: node.tag });
    node.tag = u.tag;
  }
  return { t: 'tag', updates: inverse };
}

function applyDocMeta(doc: CanvasDocument, op: Extract<Op, { t: 'doc' }>): Op {
  const before = doc.name;
  if (op.name !== undefined) doc.name = op.name;
  return { t: 'doc', name: before };
}

function applyTokens(doc: CanvasDocument, op: Extract<Op, { t: 'tokens' }>): Op {
  const before = doc.tokens.map((t) => ({ ...t, values: { ...t.values } }));
  doc.tokens = op.tokens;
  const themes = new Set<string>(['default']);
  for (const t of op.tokens) for (const k of Object.keys(t.values)) themes.add(k);
  doc.themes = [...themes];
  return { t: 'tokens', tokens: before };
}

function applyPage(doc: CanvasDocument, op: Extract<Op, { t: 'page' }>): Op {
  if (op.action === 'add') {
    doc.pages.push(op.page);
    return { t: 'page', action: 'remove', page: op.page };
  }
  if (op.action === 'remove') {
    const i = doc.pages.findIndex((p) => p.id === op.page.id);
    if (i < 0) throw new OpError(`page ${op.page.id} not found`);
    const [removed] = doc.pages.splice(i, 1);
    for (const a of removed!.artboards) {
      for (const nid of [a, ...descendants(doc, a)]) delete doc.nodes[nid];
    }
    return { t: 'page', action: 'add', page: removed! };
  }
  const page = doc.pages.find((p) => p.id === op.page.id);
  if (!page) throw new OpError(`page ${op.page.id} not found`);
  const before = { ...page };
  page.name = op.page.name;
  return { t: 'page', action: 'rename', page: before };
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n) || n < 0) return hi;
  return Math.max(lo, Math.min(hi, n));
}

// ---------------------------------------------------------------------------
// Deep clone, used by duplicate
// ---------------------------------------------------------------------------

/**
 * Deep-clones a subtree with fresh ids. Returns the new nodes (in insert order)
 * and the old→new id map, which agents need to address the copies.
 */
export function cloneSubtree(
  doc: CanvasDocument,
  rootId: NodeId,
): { nodes: CanvasNode[]; idMap: Record<NodeId, NodeId> } {
  const idMap: Record<NodeId, NodeId> = {};
  const all = [rootId, ...descendants(doc, rootId)];
  for (const id of all) idMap[id] = newId();

  const nodes = all.map((id) => {
    const src = doc.nodes[id]!;
    return {
      ...src,
      id: idMap[id]!,
      parent: src.parent && idMap[src.parent] ? idMap[src.parent]! : null,
      children: src.children.map((c) => idMap[c]!),
      styles: { ...src.styles },
      attrs: { ...src.attrs },
      variants: src.variants.map((v) => ({ selector: v.selector, styles: { ...v.styles } })),
    } as CanvasNode;
  });

  return { nodes, idMap };
}

export function batchId(): string { return newId('b'); }
