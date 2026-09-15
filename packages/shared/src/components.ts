/**
 * Component expansion.
 *
 * An instance is a single node in the document; what it *renders* is the
 * definition's subtree with the instance's overrides applied, and with the
 * instance's own children placed into the definition's slots. Everything that
 * draws or emits a document — the canvas, HTML export, JSX export — goes
 * through `expandInstance`, so there is exactly one definition of what an
 * instance means.
 */

import {
  type CanvasDocument, type CanvasNode, type ComponentDef, type ComponentVariant,
  type InstanceOverride, type NodeId,
  componentOfInstance, resolvedProps, slotNameOf, variantKey,
} from './model.ts';

export interface ExpandedNode {
  /** The node to render, with overrides already applied. */
  node: CanvasNode;
  /**
   * Editor-facing id. Nodes coming from a definition get `instanceId::defId`,
   * so selecting one addresses the override rather than the shared definition.
   */
  key: string;
  /** The definition node this came from, if any. */
  defId: NodeId | null;
  children: ExpandedNode[];
}

export const INSTANCE_KEY_SEPARATOR = '::';

export function makeInstanceKey(instanceId: NodeId, defId: NodeId): string {
  return `${instanceId}${INSTANCE_KEY_SEPARATOR}${defId}`;
}

export function parseInstanceKey(key: string): { instanceId: NodeId; defId: NodeId } | null {
  const i = key.indexOf(INSTANCE_KEY_SEPARATOR);
  if (i < 0) return null;
  return { instanceId: key.slice(0, i), defId: key.slice(i + INSTANCE_KEY_SEPARATOR.length) };
}

export class ComponentError extends Error {}

/**
 * Expands an instance into a render tree.
 *
 * `seen` guards against a component that contains itself, directly or through
 * another component — which is easy to create by accident and would otherwise
 * recurse until the stack runs out.
 */
export function expandInstance(
  doc: CanvasDocument,
  instance: CanvasNode,
  seen: ReadonlySet<string> = new Set(),
): ExpandedNode | null {
  const def = componentOfInstance(doc, instance);
  if (!def) return null;
  if (seen.has(def.id)) {
    throw new ComponentError(`Component "${def.name}" contains itself; that instance was not rendered.`);
  }

  const root = doc.nodes[def.root];
  if (!root) return null;

  const nextSeen = new Set(seen).add(def.id);
  const overrides = effectiveOverrides(def, instance);
  // The instance's own children fill the definition's slots.
  const slotted = instance.children.map((id) => doc.nodes[id]).filter((n): n is CanvasNode => !!n);

  const build = (defNode: CanvasNode): ExpandedNode | null => {
    const override = overrides[defNode.id];
    if (override?.hidden) return null;

    // A definition may contain instances of other components; those have to be
    // expanded too, carrying the cycle guard so a component that (indirectly)
    // contains itself is dropped rather than recursing forever.
    if (defNode.type === 'instance') {
      try {
        const nested = expandInstance(doc, defNode, nextSeen);
        if (!nested) return null;
        return { ...nested, key: makeInstanceKey(instance.id, defNode.id), defId: defNode.id };
      } catch (err) {
        if (err instanceof ComponentError) return null;
        throw err;
      }
    }

    const merged: CanvasNode = {
      ...defNode,
      styles: override?.styles ? { ...defNode.styles, ...override.styles } : defNode.styles,
      attrs: override?.attrs ? { ...defNode.attrs, ...override.attrs } : defNode.attrs,
      text: override?.text ?? defNode.text,
    };

    const slot = slotNameOf(defNode);
    if (slot !== null) {
      // A slot renders the instance's children in place of the definition's.
      const fill = slot === 'default'
        ? slotted.filter((c) => !c.attrs[SLOT_SOURCE_ATTR] || c.attrs[SLOT_SOURCE_ATTR] === 'default')
        : slotted.filter((c) => c.attrs[SLOT_SOURCE_ATTR] === slot);

      return {
        node: merged,
        key: makeInstanceKey(instance.id, defNode.id),
        defId: defNode.id,
        children: fill.length
          ? fill.map((child) => expandNode(doc, child, nextSeen)).filter((x): x is ExpandedNode => !!x)
          // An empty slot falls back to the definition's contents, so a new
          // instance looks like the component rather than an empty box.
          : defNode.children
              .map((id) => doc.nodes[id])
              .filter((n): n is CanvasNode => !!n)
              .map(build)
              .filter((x): x is ExpandedNode => !!x),
      };
    }

    return {
      node: merged,
      key: makeInstanceKey(instance.id, defNode.id),
      defId: defNode.id,
      children: defNode.children
        .map((id) => doc.nodes[id])
        .filter((n): n is CanvasNode => !!n)
        .map(build)
        .filter((x): x is ExpandedNode => !!x),
    };
  };

  return build(root);
}

/** Marks which slot an instance child belongs to. */
export const SLOT_SOURCE_ATTR = 'data-slot-target';

/**
 * The override cascade for an instance.
 *
 * Base definition, then every variant the instance matches — least specific
 * first, so `{tone: danger}` is refined rather than replaced by
 * `{size: lg, tone: danger}` — then the instance's own overrides, which always
 * win because they are the most local statement of intent.
 */
export function effectiveOverrides(
  def: ComponentDef,
  instance: CanvasNode,
): Record<NodeId, InstanceOverride> {
  const props = resolvedProps(def, instance);
  const matching = (def.variants ?? [])
    .filter((v) => matchesProps(v, props))
    .sort((a, b) => Object.keys(a.match).length - Object.keys(b.match).length);

  const out: Record<NodeId, InstanceOverride> = {};
  for (const source of [...matching.map((v) => v.overrides), instance.overrides ?? {}]) {
    for (const [defId, override] of Object.entries(source)) {
      out[defId] = mergeOverride(out[defId], override);
    }
  }
  return out;
}

export function matchesProps(variant: ComponentVariant, props: Record<string, string>): boolean {
  return Object.entries(variant.match).every(([key, value]) => props[key] === value);
}

function mergeOverride(base: InstanceOverride | undefined, next: InstanceOverride): InstanceOverride {
  return {
    ...base,
    ...next,
    styles: next.styles ? { ...base?.styles, ...next.styles } : base?.styles,
    attrs: next.attrs ? { ...base?.attrs, ...next.attrs } : base?.attrs,
  };
}

/** The variant a given property combination resolves to, if one is defined. */
export function findVariant(def: ComponentDef, match: Record<string, string>): ComponentVariant | undefined {
  const key = variantKey(match);
  return (def.variants ?? []).find((v) => variantKey(v.match) === key);
}

/** Expands any node, following instances. The entry point for renderers. */
export function expandNode(
  doc: CanvasDocument,
  node: CanvasNode,
  seen: ReadonlySet<string> = new Set(),
): ExpandedNode | null {
  if (!node.visible) return null;

  if (node.type === 'instance') {
    try {
      return expandInstance(doc, node, seen);
    } catch (err) {
      if (err instanceof ComponentError) return null;
      throw err;
    }
  }

  return {
    node,
    key: node.id,
    defId: null,
    children: node.children
      .map((id) => doc.nodes[id])
      .filter((n): n is CanvasNode => !!n)
      .map((child) => expandNode(doc, child, seen))
      .filter((x): x is ExpandedNode => !!x),
  };
}

// ---------------------------------------------------------------------------
// Authoring
// ---------------------------------------------------------------------------

/** Every instance of a component, anywhere in the document. */
export function instancesOf(doc: CanvasDocument, componentId: string): NodeId[] {
  return Object.values(doc.nodes)
    .filter((n) => n.type === 'instance' && n.componentRef === componentId)
    .map((n) => n.id);
}

/**
 * Where a component is used: on the pages, and inside other components.
 *
 * A component definition can hold an instance of another one — a card with a
 * tag in it — and the renderer expands those, with a cycle guard. Nothing said
 * so: the count beside a component only knew about instances on a page, so a
 * tag used in three cards and nowhere else read as "0 instances" and looked
 * like dead weight.
 */
export function usageOf(
  doc: CanvasDocument, componentId: string,
): { onPages: NodeId[]; inComponents: { id: string; name: string; count: number }[] } {
  const inDefinition = new Map<string, { id: string; name: string; count: number }>();
  const onPages: NodeId[] = [];

  const owners = Object.values(doc.components ?? {});
  const ownerOf = (id: NodeId): { id: string; name: string } | null => {
    let node: CanvasNode | undefined = doc.nodes[id];
    while (node) {
      const owner = owners.find((c) => c.root === node!.id);
      if (owner) return { id: owner.id, name: owner.name };
      node = node.parent ? doc.nodes[node.parent] : undefined;
    }
    return null;
  };

  for (const id of instancesOf(doc, componentId)) {
    const owner = ownerOf(id);
    if (!owner) { onPages.push(id); continue; }
    const entry = inDefinition.get(owner.id) ?? { ...owner, count: 0 };
    entry.count++;
    inDefinition.set(owner.id, entry);
  }
  return { onPages, inComponents: [...inDefinition.values()] };
}

/**
 * Turns an expanded instance back into ordinary nodes.
 *
 * Detaching is the escape hatch that keeps components from being a trap: if a
 * single instance needs to diverge past what overrides can express, it can stop
 * being an instance without losing what it rendered.
 */
export function detachedNodes(
  doc: CanvasDocument,
  instance: CanvasNode,
  newId: () => NodeId,
): CanvasNode[] {
  const expanded = expandInstance(doc, instance);
  if (!expanded) return [];

  const out: CanvasNode[] = [];
  const walk = (exp: ExpandedNode, parent: NodeId | null): NodeId => {
    const id = newId();
    const children = exp.children.map((child) => walk(child, id));
    out.push({
      ...exp.node,
      id,
      parent,
      children,
      // A detached copy owns its styles outright.
      styles: { ...exp.node.styles },
      attrs: { ...exp.node.attrs },
      variants: exp.node.variants.map((v) => ({ selector: v.selector, styles: { ...v.styles } })),
      componentRef: undefined,
      overrides: undefined,
    });
    return id;
  };

  walk(expanded, instance.parent);
  return out;
}

export function describeComponent(doc: CanvasDocument, def: ComponentDef): string {
  const root = doc.nodes[def.root];
  const slots = root ? collectSlots(doc, root) : [];
  const count = instancesOf(doc, def.id).length;
  return [
    `${def.name} (${def.id})`,
    `${count} instance${count === 1 ? '' : 's'}`,
    slots.length ? `slots: ${slots.join(', ')}` : 'no slots',
  ].join(' · ');
}

export function collectSlots(doc: CanvasDocument, node: CanvasNode): string[] {
  const slot = slotNameOf(node);
  const here = slot !== null ? [slot] : [];
  return [
    ...here,
    ...node.children.flatMap((id) => {
      const child = doc.nodes[id];
      return child ? collectSlots(doc, child) : [];
    }),
  ];
}
