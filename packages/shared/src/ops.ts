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
  type Token, type Note, type ComponentDef, type ComponentVariant, type InstanceOverride,
  type Breakpoint, breakpointsOf,
  descendants, isAncestorOf, makeNote, newId, variantKey,
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
  | { t: 'page'; action: 'add' | 'remove' | 'rename'; page: Page }
  | { t: 'note'; action: 'add' | 'update' | 'remove'; pageId: string; note: Partial<Note> & { id: string } }
  | { t: 'component'; action: 'add' | 'update' | 'remove'; component: Partial<ComponentDef> & { id: string } }
  | {
      t: 'variant';
      componentId: string;
      /** Property combination this applies to. */
      match: Record<string, string>;
      /** Per-definition-node changes; null clears the whole variant. */
      overrides: Record<NodeId, InstanceOverride | null> | null;
    }
  | { t: 'props'; updates: { id: NodeId; props: Record<string, string | null> }[] }
  | { t: 'breakpoints'; breakpoints: Breakpoint[] }
  | {
      t: 'override';
      updates: {
        id: NodeId;
        defId: NodeId;
        override: InstanceOverride | null;
        /**
         * `merge` (the default) layers onto the existing override, which is what
         * editing one property should do. `set` replaces it outright — used by
         * inverses, which must restore an exact prior state rather than merging
         * back over the change they are undoing.
         */
        mode?: 'merge' | 'set';
      }[];
    };

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

/** Pseudo-page id marking nodes that belong to a component definition. */
export const DEFINITIONS_PAGE = '__definitions__';

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
    case 'note': return applyNote(doc, op);
    case 'component': return applyComponent(doc, op);
    case 'override': return applyOverride(doc, op);
    case 'variant': return applyVariant(doc, op);
    case 'props': return applyProps(doc, op);
    case 'breakpoints': return applyBreakpoints(doc, op);
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
    // Component definitions are parented to nothing and belong to no page, so
    // they never render on the canvas or export on their own.
    if (op.page === DEFINITIONS_PAGE) {
      for (const id of roots) doc.nodes[id]!.parent = null;
      return { t: 'remove', ids: roots };
    }
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
  // A root with no page is a component definition; it has no sibling list.
  const siblings = parentId === null ? page?.artboards ?? [] : doc.nodes[parentId]!.children;
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

  return {
    t: 'insert', nodes: captured, parent: parentId, index,
    page: parentId === null ? page?.id ?? DEFINITIONS_PAGE : undefined,
  };
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

function applyNote(doc: CanvasDocument, op: Extract<Op, { t: 'note' }>): Op {
  const page = doc.pages.find((p) => p.id === op.pageId);
  if (!page) throw new OpError(`page ${op.pageId} not found`);
  if (!page.notes) page.notes = [];

  const index = page.notes.findIndex((n) => n.id === op.note.id);

  if (op.action === 'add') {
    if (index >= 0) throw new OpError(`note ${op.note.id} already exists`);
    page.notes.push(makeNote(op.note));
    return { t: 'note', action: 'remove', pageId: op.pageId, note: { id: op.note.id } };
  }

  if (op.action === 'remove') {
    if (index < 0) throw new OpError(`note ${op.note.id} not found`);
    const [removed] = page.notes.splice(index, 1);
    return { t: 'note', action: 'add', pageId: op.pageId, note: removed! };
  }

  if (index < 0) throw new OpError(`note ${op.note.id} not found`);
  const current = page.notes[index]!;
  // The inverse restores exactly the fields this update touched, so undoing a
  // text edit does not also revert a position set by someone else.
  const before: Partial<Note> & { id: string } = { id: current.id };
  for (const key of Object.keys(op.note) as (keyof Note)[]) {
    if (key === 'id') continue;
    (before as Record<string, unknown>)[key] = current[key];
  }
  page.notes[index] = { ...current, ...op.note, updatedAt: Date.now() };
  return { t: 'note', action: 'update', pageId: op.pageId, note: before };
}

function applyComponent(doc: CanvasDocument, op: Extract<Op, { t: 'component' }>): Op {
  if (!doc.components) doc.components = {};
  const current = doc.components[op.component.id];

  if (op.action === 'add') {
    if (current) throw new OpError(`component ${op.component.id} already exists`);
    if (!op.component.root || !op.component.name) throw new OpError('a component needs a name and a root node');
    doc.components[op.component.id] = {
      id: op.component.id,
      name: op.component.name,
      description: op.component.description,
      root: op.component.root,
      createdAt: op.component.createdAt ?? Date.now(),
    };
    return { t: 'component', action: 'remove', component: { id: op.component.id } };
  }

  if (op.action === 'remove') {
    if (!current) throw new OpError(`component ${op.component.id} not found`);
    delete doc.components[op.component.id];
    // The definition's nodes stay in the document; removing the component
    // without them would orphan any instance mid-render. Callers that want the
    // nodes gone issue a `remove` op for the root as well.
    return { t: 'component', action: 'add', component: current };
  }

  if (!current) throw new OpError(`component ${op.component.id} not found`);
  const before: Partial<ComponentDef> & { id: string } = { id: current.id };
  for (const key of Object.keys(op.component) as (keyof ComponentDef)[]) {
    if (key === 'id') continue;
    (before as Record<string, unknown>)[key] = current[key];
  }
  doc.components[op.component.id] = { ...current, ...op.component };
  return { t: 'component', action: 'update', component: before };
}

function applyOverride(doc: CanvasDocument, op: Extract<Op, { t: 'override' }>): Op {
  const inverse: Extract<Op, { t: 'override' }>['updates'] = [];

  for (const u of op.updates) {
    const node = doc.nodes[u.id];
    if (!node) continue;
    if (!node.overrides) node.overrides = {};

    const previous = node.overrides[u.defId] ?? null;
    // Inverses always replace, so undo restores exactly what was there.
    inverse.push({
      id: u.id, defId: u.defId, mode: 'set',
      override: previous ? structuredClone(previous) : null,
    });

    if (u.override === null) {
      delete node.overrides[u.defId];
      continue;
    }

    if (u.mode === 'set') {
      node.overrides[u.defId] = structuredClone(u.override);
      continue;
    }

    // Merge by default: setting a style should not drop a text override the
    // user set a moment earlier on the same node.
    node.overrides[u.defId] = {
      ...previous,
      ...u.override,
      styles: u.override.styles ? { ...previous?.styles, ...u.override.styles } : previous?.styles,
      attrs: u.override.attrs ? { ...previous?.attrs, ...u.override.attrs } : previous?.attrs,
    };
  }

  return { t: 'override', updates: inverse };
}

function applyVariant(doc: CanvasDocument, op: Extract<Op, { t: 'variant' }>): Op {
  const def = doc.components?.[op.componentId];
  if (!def) throw new OpError(`component ${op.componentId} not found`);
  if (!def.variants) def.variants = [];

  const key = variantKey(op.match);
  const index = def.variants.findIndex((v) => variantKey(v.match) === key);
  const existing = index >= 0 ? def.variants[index]! : null;

  // Clearing the variant entirely.
  if (op.overrides === null) {
    if (!existing) return { t: 'variant', componentId: op.componentId, match: op.match, overrides: null };
    def.variants.splice(index, 1);
    return {
      t: 'variant', componentId: op.componentId, match: op.match,
      overrides: existing.overrides as Record<NodeId, InstanceOverride | null>,
    };
  }

  const variant: ComponentVariant = existing
    ? { ...existing, overrides: { ...existing.overrides } }
    : { id: newId('var'), match: { ...op.match }, overrides: {} };

  const inverse: Record<NodeId, InstanceOverride | null> = {};
  for (const [defId, override] of Object.entries(op.overrides)) {
    inverse[defId] = variant.overrides[defId] ? structuredClone(variant.overrides[defId]!) : null;
    if (override === null) delete variant.overrides[defId];
    else {
      variant.overrides[defId] = {
        ...variant.overrides[defId],
        ...override,
        styles: override.styles ? { ...variant.overrides[defId]?.styles, ...override.styles } : variant.overrides[defId]?.styles,
        attrs: override.attrs ? { ...variant.overrides[defId]?.attrs, ...override.attrs } : variant.overrides[defId]?.attrs,
      };
    }
  }

  if (index >= 0) def.variants[index] = variant;
  else def.variants.push(variant);

  // A variant with nothing left in it is noise in the matrix.
  if (!Object.keys(variant.overrides).length) {
    def.variants = def.variants.filter((v) => variantKey(v.match) !== key);
  }

  return { t: 'variant', componentId: op.componentId, match: op.match, overrides: inverse };
}

function applyProps(doc: CanvasDocument, op: Extract<Op, { t: 'props' }>): Op {
  const inverse: { id: NodeId; props: Record<string, string | null> }[] = [];
  for (const u of op.updates) {
    const node = doc.nodes[u.id];
    if (!node) continue;
    if (!node.props) node.props = {};

    const before: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(u.props)) {
      before[key] = node.props[key] ?? null;
      if (value === null) delete node.props[key];
      else node.props[key] = value;
    }
    inverse.push({ id: u.id, props: before });
  }
  return { t: 'props', updates: inverse };
}

function applyBreakpoints(doc: CanvasDocument, op: Extract<Op, { t: 'breakpoints' }>): Op {
  const before = breakpointsOf(doc);
  doc.breakpoints = [...op.breakpoints].sort((a, b) => a.maxWidth - b.maxWidth);
  return { t: 'breakpoints', breakpoints: before };
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

// ---------------------------------------------------------------------------
// Change tracking
// ---------------------------------------------------------------------------

export interface TouchedNodes {
  /** Nodes whose own content changed. */
  nodes: NodeId[];
  /** Nodes whose child list changed, so they must re-render their children. */
  structure: NodeId[];
  /** True when something document-wide changed: tokens, pages, components. */
  global: boolean;
}

/**
 * Which nodes an op affects.
 *
 * This is what lets the canvas re-render only what changed. Ops are already
 * id-addressed, so deriving this is cheap — and without it every keystroke
 * re-renders every node in the document, which on a large page means a drag
 * runs at single-digit frames per second.
 */
export function touchedNodes(op: Op): TouchedNodes {
  const empty = { nodes: [] as NodeId[], structure: [] as NodeId[], global: false };
  switch (op.t) {
    case 'insert':
      return {
        nodes: op.nodes.map((n) => n.id),
        structure: op.parent ? [op.parent] : [],
        global: op.parent === null,
      };
    case 'remove':
      // The parent is unknown here without the document, so treat removals as
      // structural everywhere; they are rare compared with styling.
      return { nodes: op.ids, structure: [], global: true };
    case 'styles':
    case 'text':
    case 'rename':
    case 'attrs':
    case 'meta':
    case 'tag':
      return { ...empty, nodes: op.updates.map((u) => u.id) };
    case 'props':
      return { ...empty, nodes: op.updates.map((u) => u.id) };
    case 'override':
      return { ...empty, nodes: op.updates.map((u) => u.id) };
    case 'move':
      return {
        nodes: op.moves.map((m) => m.id),
        structure: op.moves.flatMap((m) => (m.parent ? [m.parent] : [])),
        global: op.moves.some((m) => m.parent === null),
      };
    case 'doc':
    case 'tokens':
    case 'page':
    case 'note':
    case 'component':
    case 'variant':
    case 'breakpoints':
      return { ...empty, global: true };
  }
}
