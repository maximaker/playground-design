/**
 * What changed between two versions of a document.
 *
 * The part of handover that actually wastes people's time is not the padding —
 * it is finding out that the padding moved after you built it. A design tool
 * that stores pictures can only answer this with a screenshot comparison, which
 * tells you *that* something moved and not what. This document is a tree of
 * nodes with an op log behind it, so the question has an exact answer.
 *
 * Deliberately a document-to-document comparison rather than a replay of the
 * ops. Ops say what happened, which is a different question: a value nudged
 * four times and put back produces four entries in the log and no change worth
 * anyone's attention. What a developer needs is the difference between what
 * they built against and what is there now.
 */

import type { CanvasDocument, CanvasNode, NodeId, StyleMap } from './model.ts';

export type ChangeKind = 'added' | 'removed' | 'changed';

export interface FieldChange {
  /** `styles.padding`, `text`, `attrs.href`, `name`, `parent`. */
  field: string;
  before?: string;
  after?: string;
}

export interface NodeChange {
  id: NodeId;
  kind: ChangeKind;
  name: string;
  type: string;
  /** The artboard it lives on now, or lived on before it was removed. */
  artboard?: { id: NodeId; name: string };
  fields: FieldChange[];
}

export interface DocumentDiff {
  /** True when nothing a reader would see is different. */
  same: boolean;
  counts: { added: number; removed: number; changed: number };
  nodes: NodeChange[];
  /** Grouped for reading: "Landing — 1440: 6 changes". */
  byArtboard: { id: NodeId | null; name: string; changes: number }[];
  tokens: FieldChange[];
  components: FieldChange[];
  pages: FieldChange[];
}

function artboardOfIn(doc: CanvasDocument, id: NodeId): NodeId | null {
  let current: CanvasNode | undefined = doc.nodes[id];
  while (current) {
    if (current.type === 'artboard') return current.id;
    current = current.parent ? doc.nodes[current.parent] : undefined;
  }
  return null;
}

function styleChanges(before: StyleMap, after: StyleMap): FieldChange[] {
  const out: FieldChange[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[key] === after[key]) continue;
    out.push({ field: `styles.${key}`, before: before[key], after: after[key] });
  }
  return out.sort((a, b) => a.field.localeCompare(b.field));
}

function attrChanges(before: Record<string, string>, after: Record<string, string>): FieldChange[] {
  const out: FieldChange[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    // Canvas position lives in attributes and moves whenever an artboard is
    // dragged, which is not a change anyone is handing over.
    if (key.startsWith('data-x') || key.startsWith('data-y')) continue;
    if (before[key] === after[key]) continue;
    out.push({ field: `attrs.${key}`, before: before[key], after: after[key] });
  }
  return out.sort((a, b) => a.field.localeCompare(b.field));
}

function variantSummary(node: CanvasNode): string {
  return (node.variants ?? [])
    .map((v) => `${v.selector}{${Object.entries(v.styles).sort(([a], [b]) => a.localeCompare(b))
      .map(([k, x]) => `${k}:${x}`).join(';')}}`)
    .sort()
    .join(' ');
}

function nodeChanges(
  before: CanvasNode, after: CanvasNode,
  /** Ids reported as added or removed in their own right. */
  accountedFor: Set<NodeId>,
): FieldChange[] {
  const fields: FieldChange[] = [];
  if (before.name !== after.name) fields.push({ field: 'name', before: before.name, after: after.name });
  if (before.tag !== after.tag) fields.push({ field: 'tag', before: before.tag, after: after.tag });
  if (before.text !== after.text) fields.push({ field: 'text', before: before.text, after: after.text });
  if (before.parent !== after.parent) {
    fields.push({ field: 'parent', before: before.parent ?? undefined, after: after.parent ?? undefined });
  }
  if (before.visible !== after.visible) {
    fields.push({ field: 'visible', before: String(before.visible), after: String(after.visible) });
  }
  if (before.componentRef !== after.componentRef) {
    fields.push({ field: 'component', before: before.componentRef, after: after.componentRef });
  }
  fields.push(...styleChanges(before.styles, after.styles));
  fields.push(...attrChanges(before.attrs ?? {}, after.attrs ?? {}));

  const bv = variantSummary(before);
  const av = variantSummary(after);
  if (bv !== av) fields.push({ field: 'variants', before: bv || '(none)', after: av || '(none)' });

  // Reordering children is a real change to what a page looks like, but listing
  // every id is noise; the count and the fact of it are what read.
  //
  // Children that are themselves reported as added or removed are left out of
  // the comparison: deleting a card would otherwise be two entries — the card,
  // and its parent's child count — and the second one tells nobody anything.
  const kept = (ids: readonly NodeId[]) => ids.filter((id) => !accountedFor.has(id));
  const b = kept(before.children);
  const a = kept(after.children);
  if (b.join(',') !== a.join(',')) {
    fields.push({
      field: 'children',
      before: `${b.length}`,
      after: `${a.length}${b.length === a.length ? ' (reordered)' : ''}`,
    });
  }
  return fields;
}

function tokenChanges(before: CanvasDocument, after: CanvasDocument): FieldChange[] {
  const out: FieldChange[] = [];
  const b = new Map((before.tokens ?? []).map((t) => [t.name, t]));
  const a = new Map((after.tokens ?? []).map((t) => [t.name, t]));
  for (const name of new Set([...b.keys(), ...a.keys()])) {
    const bs = b.get(name) ? JSON.stringify(b.get(name)!.values) : undefined;
    const as = a.get(name) ? JSON.stringify(a.get(name)!.values) : undefined;
    if (bs !== as) out.push({ field: name, before: bs, after: as });
  }
  return out.sort((x, y) => x.field.localeCompare(y.field));
}

/**
 * The difference between two documents, as a developer would want it read.
 *
 * `before` is what they built against — a snapshot — and `after` is the
 * document now.
 */
export function diffDocuments(before: CanvasDocument, after: CanvasDocument): DocumentDiff {
  const nodes: NodeChange[] = [];
  const ids = new Set([...Object.keys(before.nodes), ...Object.keys(after.nodes)]);

  // A component definition's nodes are not on any artboard; changes to them are
  // reported against the component instead, where they mean something.
  const definitionRoots = new Set([
    ...Object.values(before.components ?? {}).map((c) => c.root),
    ...Object.values(after.components ?? {}).map((c) => c.root),
  ]);
  const inDefinition = (doc: CanvasDocument, id: NodeId): boolean => {
    let current: CanvasNode | undefined = doc.nodes[id];
    while (current) {
      if (definitionRoots.has(current.id)) return true;
      current = current.parent ? doc.nodes[current.parent] : undefined;
    }
    return false;
  };

  // Worked out first, because whether a parent's child list "changed" depends
  // on which of its children are reported separately.
  const accountedFor = new Set<NodeId>();
  for (const id of ids) {
    const b = before.nodes[id];
    const a = after.nodes[id];
    if (!b && a && (!a.parent || before.nodes[a.parent]) && !inDefinition(after, id)) accountedFor.add(id);
    if (b && !a && (!b.parent || after.nodes[b.parent]) && !inDefinition(before, id)) accountedFor.add(id);
  }

  for (const id of ids) {
    const b = before.nodes[id];
    const a = after.nodes[id];
    if (b && a) {
      const fields = nodeChanges(b, a, accountedFor);
      if (!fields.length) continue;
      const artboard = artboardOfIn(after, id);
      nodes.push({
        id, kind: 'changed', name: a.name, type: a.type,
        artboard: artboard ? { id: artboard, name: after.nodes[artboard]?.name ?? artboard } : undefined,
        fields,
      });
    } else if (a && !b) {
      // An added subtree reports its root, not every descendant: "added a card"
      // is the change; its twelve children are what a card is.
      if (a.parent && !before.nodes[a.parent]) continue;
      if (inDefinition(after, id)) continue;
      const artboard = artboardOfIn(after, id);
      nodes.push({
        id, kind: 'added', name: a.name, type: a.type,
        artboard: artboard ? { id: artboard, name: after.nodes[artboard]?.name ?? artboard } : undefined,
        fields: [],
      });
    } else if (b && !a) {
      if (b.parent && !after.nodes[b.parent]) continue;
      if (inDefinition(before, id)) continue;
      const artboard = artboardOfIn(before, id);
      nodes.push({
        id, kind: 'removed', name: b.name, type: b.type,
        artboard: artboard ? { id: artboard, name: before.nodes[artboard]?.name ?? artboard } : undefined,
        fields: [],
      });
    }
  }

  const counts = {
    added: nodes.filter((n) => n.kind === 'added').length,
    removed: nodes.filter((n) => n.kind === 'removed').length,
    changed: nodes.filter((n) => n.kind === 'changed').length,
  };

  const grouped = new Map<string, { id: NodeId | null; name: string; changes: number }>();
  for (const change of nodes) {
    const key = change.artboard?.id ?? '—';
    const entry = grouped.get(key)
      ?? { id: change.artboard?.id ?? null, name: change.artboard?.name ?? 'Elsewhere', changes: 0 };
    entry.changes++;
    grouped.set(key, entry);
  }

  const components: FieldChange[] = [];
  const bc = before.components ?? {};
  const ac = after.components ?? {};
  for (const id of new Set([...Object.keys(bc), ...Object.keys(ac)])) {
    if (!bc[id]) components.push({ field: ac[id]!.name, after: 'added' });
    else if (!ac[id]) components.push({ field: bc[id]!.name, before: 'removed' });
    else if (bc[id]!.name !== ac[id]!.name) {
      components.push({ field: ac[id]!.name, before: bc[id]!.name, after: ac[id]!.name });
    }
  }

  const pages: FieldChange[] = [];
  const bp = new Map(before.pages.map((p) => [p.id, p]));
  const ap = new Map(after.pages.map((p) => [p.id, p]));
  for (const id of new Set([...bp.keys(), ...ap.keys()])) {
    if (!bp.has(id)) pages.push({ field: ap.get(id)!.name, after: 'added' });
    else if (!ap.has(id)) pages.push({ field: bp.get(id)!.name, before: 'removed' });
    else if (bp.get(id)!.name !== ap.get(id)!.name) {
      pages.push({ field: ap.get(id)!.name, before: bp.get(id)!.name, after: ap.get(id)!.name });
    }
  }

  const tokens = tokenChanges(before, after);
  return {
    same: nodes.length === 0 && tokens.length === 0 && components.length === 0 && pages.length === 0,
    counts,
    // Changed before added before removed: a developer is looking for what
    // moved under them, not for what is new.
    nodes: nodes.sort((a, b) =>
      rank(a.kind) - rank(b.kind) || (b.fields.length - a.fields.length)),
    byArtboard: [...grouped.values()].sort((a, b) => b.changes - a.changes),
    tokens,
    components,
    pages,
  };
}

function rank(kind: ChangeKind): number {
  return kind === 'changed' ? 0 : kind === 'added' ? 1 : 2;
}

/** The changes touching one node or anything inside it. */
export function changesWithin(diff: DocumentDiff, doc: CanvasDocument, rootId: NodeId): NodeChange[] {
  const inside = new Set<NodeId>();
  const walk = (id: NodeId) => {
    inside.add(id);
    for (const child of doc.nodes[id]?.children ?? []) walk(child);
  };
  walk(rootId);
  return diff.nodes.filter((n) => inside.has(n.id));
}
