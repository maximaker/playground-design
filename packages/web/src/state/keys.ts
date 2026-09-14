/**
 * Selection keys.
 *
 * Most of the editor addresses nodes by id. Inside a component instance that is
 * not enough: the same definition node appears in every instance, so a key
 * there is `instanceId::defId`. This module is the single place that knows how
 * to turn a key back into "what does writing to this actually change".
 */

import {
  type CanvasDocument, type CanvasNode, type InstanceOverride, type NodeId, type Op, type StyleMap,
  expandInstance, parseInstanceKey,
} from '@playground/shared';

export interface ResolvedKey {
  /** The node an edit should be written to. */
  targetId: NodeId;
  /** Set when the key points inside a component instance. */
  defId: NodeId | null;
  /** The node as rendered, with overrides applied. */
  node: CanvasNode | null;
  /** The underlying definition node, when inside an instance. */
  definition: CanvasNode | null;
}

export function resolveKey(doc: CanvasDocument | null, key: string): ResolvedKey | null {
  if (!doc) return null;

  const parsed = parseInstanceKey(key);
  if (!parsed) {
    const node = doc.nodes[key];
    return node ? { targetId: key, defId: null, node, definition: null } : null;
  }

  const instance = doc.nodes[parsed.instanceId];
  if (!instance) return null;

  // The instance root's key is `instanceId::rootDefId`; edits there belong to
  // the instance node itself, which is what sits in the tree.
  const expanded = expandInstance(doc, instance);
  const found = expanded ? findByKey(expanded, key) : null;

  return {
    targetId: parsed.instanceId,
    defId: parsed.defId,
    node: found,
    definition: doc.nodes[parsed.defId] ?? null,
  };
}

function findByKey(
  expanded: { key: string; node: CanvasNode; children: { key: string; node: CanvasNode; children: unknown[] }[] },
  key: string,
): CanvasNode | null {
  if (expanded.key === key) return expanded.node;
  for (const child of expanded.children) {
    const hit = findByKey(child as never, key);
    if (hit) return hit;
  }
  return null;
}

export function isInsideInstance(key: string): boolean {
  return parseInstanceKey(key) !== null;
}

/** The node that actually lives in the document tree for a key. */
export function treeNodeId(key: string): NodeId {
  return parseInstanceKey(key)?.instanceId ?? key;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export function styleOps(
  doc: CanvasDocument | null,
  keys: string[],
  styles: StyleMap,
  selector?: string,
  /** When set, edits to nodes inside this component's definition become variant overrides. */
  editingVariant?: { componentId: string; match: Record<string, string> } | null,
): Op[] {
  if (!doc) return [];

  if (editingVariant) {
    const def = doc.components?.[editingVariant.componentId];
    const inDefinition = def
      ? keys.filter((k) => isUnder(doc, treeNodeId(k), def.root))
      : [];
    if (inDefinition.length) {
      const rest = keys.filter((k) => !inDefinition.includes(k));
      return [
        {
          t: 'variant',
          componentId: editingVariant.componentId,
          match: editingVariant.match,
          overrides: Object.fromEntries(inDefinition.map((k) => [treeNodeId(k), { styles }])),
        },
        ...styleOps(doc, rest, styles, selector),
      ];
    }
  }

  const plain: { id: NodeId; styles: StyleMap; selector?: string }[] = [];
  const overrides: { id: NodeId; defId: NodeId; override: InstanceOverride }[] = [];

  for (const key of keys) {
    const resolved = resolveKey(doc, key);
    if (!resolved) continue;

    if (resolved.defId === null) {
      plain.push({ id: resolved.targetId, styles, selector });
      continue;
    }
    // Variants inside an instance would need per-instance stylesheets; until
    // that exists, a state or breakpoint edit belongs on the definition.
    if (selector) {
      plain.push({ id: resolved.defId, styles, selector });
      continue;
    }
    overrides.push({ id: resolved.targetId, defId: resolved.defId, override: { styles } });
  }

  const ops: Op[] = [];
  if (plain.length) ops.push({ t: 'styles', updates: plain });
  if (overrides.length) ops.push({ t: 'override', updates: overrides });
  return ops;
}

/** True when `id` is `ancestor` or sits beneath it. */
function isUnder(doc: CanvasDocument, id: NodeId, ancestor: NodeId): boolean {
  let cur: NodeId | null = id;
  while (cur) {
    if (cur === ancestor) return true;
    cur = doc.nodes[cur]?.parent ?? null;
  }
  return false;
}

export function textOps(
  doc: CanvasDocument | null,
  key: string,
  text: string,
  editingVariant?: { componentId: string; match: Record<string, string> } | null,
): Op[] {
  if (doc && editingVariant) {
    const def = doc.components?.[editingVariant.componentId];
    if (def && isUnder(doc, treeNodeId(key), def.root)) {
      return [{
        t: 'variant',
        componentId: editingVariant.componentId,
        match: editingVariant.match,
        overrides: { [treeNodeId(key)]: { text } },
      }];
    }
  }
  const resolved = resolveKey(doc, key);
  if (!resolved) return [];
  return resolved.defId === null
    ? [{ t: 'text', updates: [{ id: resolved.targetId, text }] }]
    : [{ t: 'override', updates: [{ id: resolved.targetId, defId: resolved.defId, override: { text } }] }];
}

export function attrOps(doc: CanvasDocument | null, key: string, attrs: Record<string, string>): Op[] {
  const resolved = resolveKey(doc, key);
  if (!resolved) return [];
  return resolved.defId === null
    ? [{ t: 'attrs', updates: [{ id: resolved.targetId, attrs }] }]
    : [{ t: 'override', updates: [{ id: resolved.targetId, defId: resolved.defId, override: { attrs } }] }];
}

/** Clears every override a key has, returning it to the definition's values. */
export function resetOverrideOps(doc: CanvasDocument | null, keys: string[]): Op[] {
  if (!doc) return [];
  const updates = keys
    .map((key) => resolveKey(doc, key))
    .filter((r): r is ResolvedKey & { defId: NodeId } => !!r && r.defId !== null)
    .map((r) => ({ id: r.targetId, defId: r.defId, override: null, mode: 'set' as const }));
  return updates.length ? [{ t: 'override', updates }] : [];
}
