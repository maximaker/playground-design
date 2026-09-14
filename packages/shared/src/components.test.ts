import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createEmptyDocument, makeNode, resolvedProps, variantMatrix,
  type CanvasDocument, type CanvasNode,
} from './model.ts';
import { applyOp } from './ops.ts';
import {
  expandNode, expandInstance, detachedNodes, instancesOf, collectSlots, parseInstanceKey, findVariant,
} from './components.ts';
import { emitHtml } from './html.ts';
import { emitJsx } from './jsx.ts';

/** A button component: a frame with a text child, plus an optional slot. */
function seedComponent(withSlot = false) {
  const doc = createEmptyDocument('Components');
  const artboard = doc.pages[0]!.artboards[0]!;

  const label = makeNode({ type: 'text', tag: 'span', name: 'Label', text: 'Click me', styles: { color: '#fff' } });
  const slot = withSlot
    ? makeNode({ type: 'frame', name: 'Slot', attrs: { 'data-slot': 'default' }, styles: { display: 'contents' } })
    : null;
  const root = makeNode({
    type: 'frame', tag: 'button', name: 'Button',
    styles: { display: 'flex', padding: '12px 20px', 'background-color': '#3b82f6' },
  });
  root.children = slot ? [label.id, slot.id] : [label.id];
  label.parent = root.id;
  if (slot) slot.parent = root.id;

  for (const n of [root, label, ...(slot ? [slot] : [])]) doc.nodes[n.id] = n;

  const componentId = 'cmp_button';
  applyOp(doc, {
    t: 'component', action: 'add',
    component: { id: componentId, name: 'Button', root: root.id },
  });

  return { doc, artboard, componentId, root, label, slot };
}

function instantiate(doc: CanvasDocument, componentId: string, parent: string): CanvasNode {
  const instance = makeNode({ type: 'instance', name: 'Button', componentRef: componentId });
  applyOp(doc, { t: 'insert', nodes: [instance], parent, index: 0 });
  return doc.nodes[instance.id]!;
}

test('an instance expands to the definition tree', () => {
  const { doc, artboard, componentId, label } = seedComponent();
  const instance = instantiate(doc, componentId, artboard);

  const expanded = expandInstance(doc, instance)!;
  assert.equal(expanded.node.tag, 'button');
  assert.equal(expanded.children.length, 1);
  assert.equal(expanded.children[0]!.node.text, 'Click me');
  assert.equal(expanded.children[0]!.defId, label.id);
});

test('overrides apply to the expansion without touching the definition', () => {
  const { doc, artboard, componentId, label } = seedComponent();
  const a = instantiate(doc, componentId, artboard);
  const b = instantiate(doc, componentId, artboard);

  applyOp(doc, {
    t: 'override',
    updates: [{ id: a.id, defId: label.id, override: { text: 'Buy now', styles: { color: '#000' } } }],
  });

  const expandedA = expandInstance(doc, doc.nodes[a.id]!)!;
  const expandedB = expandInstance(doc, doc.nodes[b.id]!)!;

  assert.equal(expandedA.children[0]!.node.text, 'Buy now');
  assert.equal(expandedA.children[0]!.node.styles.color, '#000');
  assert.equal(expandedB.children[0]!.node.text, 'Click me', 'the other instance is unaffected');
  assert.equal(doc.nodes[label.id]!.text, 'Click me', 'the definition is unchanged');
});

test('override op merges rather than replacing, and inverts cleanly', () => {
  const { doc, artboard, componentId, label } = seedComponent();
  const instance = instantiate(doc, componentId, artboard);

  applyOp(doc, { t: 'override', updates: [{ id: instance.id, defId: label.id, override: { text: 'One' } }] });
  const inverse = applyOp(doc, {
    t: 'override',
    updates: [{ id: instance.id, defId: label.id, override: { styles: { 'font-size': '20px' } } }],
  });

  const after = doc.nodes[instance.id]!.overrides![label.id]!;
  assert.equal(after.text, 'One', 'setting a style must not drop the text override');
  assert.equal(after.styles!['font-size'], '20px');

  applyOp(doc, inverse);
  const restored = doc.nodes[instance.id]!.overrides![label.id]!;
  assert.equal(restored.text, 'One');
  assert.equal(restored.styles?.['font-size'], undefined);
});

test('removing an override restores the definition value', () => {
  const { doc, artboard, componentId, label } = seedComponent();
  const instance = instantiate(doc, componentId, artboard);
  applyOp(doc, { t: 'override', updates: [{ id: instance.id, defId: label.id, override: { text: 'Changed' } }] });
  applyOp(doc, { t: 'override', updates: [{ id: instance.id, defId: label.id, override: null }] });

  const expanded = expandInstance(doc, doc.nodes[instance.id]!)!;
  assert.equal(expanded.children[0]!.node.text, 'Click me');
});

test('a hidden override removes the node from the expansion', () => {
  const { doc, artboard, componentId, label } = seedComponent();
  const instance = instantiate(doc, componentId, artboard);
  applyOp(doc, { t: 'override', updates: [{ id: instance.id, defId: label.id, override: { hidden: true } }] });

  const expanded = expandInstance(doc, doc.nodes[instance.id]!)!;
  assert.equal(expanded.children.length, 0);
});

test('slots render the instance’s children', () => {
  const { doc, artboard, componentId, slot } = seedComponent(true);
  const instance = instantiate(doc, componentId, artboard);

  const child = makeNode({ type: 'text', tag: 'span', text: 'Custom content' });
  applyOp(doc, { t: 'insert', nodes: [child], parent: instance.id, index: 0 });

  const expanded = expandInstance(doc, doc.nodes[instance.id]!)!;
  const slotNode = expanded.children.find((c) => c.defId === slot!.id)!;
  assert.equal(slotNode.children.length, 1);
  assert.equal(slotNode.children[0]!.node.text, 'Custom content');
});

test('an empty slot falls back to the definition’s contents', () => {
  const { doc, artboard, componentId, slot } = seedComponent(true);
  const placeholder = makeNode({ type: 'text', tag: 'span', text: 'Slot placeholder', parent: slot!.id });
  doc.nodes[placeholder.id] = placeholder;
  doc.nodes[slot!.id]!.children = [placeholder.id];

  const instance = instantiate(doc, componentId, artboard);
  const expanded = expandInstance(doc, doc.nodes[instance.id]!)!;
  const slotNode = expanded.children.find((c) => c.defId === slot!.id)!;
  assert.equal(slotNode.children[0]!.node.text, 'Slot placeholder');
});

test('a self-containing component does not recurse forever', () => {
  const { doc, artboard, componentId, root } = seedComponent();
  // Put an instance of the component inside its own definition.
  const inner = makeNode({ type: 'instance', name: 'Button', componentRef: componentId });
  applyOp(doc, { t: 'insert', nodes: [inner], parent: root.id, index: 0 });

  const instance = instantiate(doc, componentId, artboard);
  // expandNode swallows the cycle and drops the offending node.
  const expanded = expandNode(doc, doc.nodes[instance.id]!);
  assert.ok(expanded, 'the outer instance still renders');
  assert.ok(!JSON.stringify(expanded).includes('"instance"'), 'the recursive instance is not expanded');
});

test('expansion keys address the instance, not the shared definition', () => {
  const { doc, artboard, componentId, label } = seedComponent();
  const a = instantiate(doc, componentId, artboard);
  const b = instantiate(doc, componentId, artboard);

  const keyA = expandInstance(doc, doc.nodes[a.id]!)!.children[0]!.key;
  const keyB = expandInstance(doc, doc.nodes[b.id]!)!.children[0]!.key;
  assert.notEqual(keyA, keyB, 'the same definition node in two instances gets distinct keys');

  const parsed = parseInstanceKey(keyA)!;
  assert.equal(parsed.instanceId, a.id);
  assert.equal(parsed.defId, label.id);
});

test('detaching produces independent nodes with fresh ids', () => {
  const { doc, artboard, componentId, label } = seedComponent();
  const instance = instantiate(doc, componentId, artboard);
  applyOp(doc, { t: 'override', updates: [{ id: instance.id, defId: label.id, override: { text: 'Detached' } }] });

  let counter = 0;
  const nodes = detachedNodes(doc, doc.nodes[instance.id]!, () => `d_${counter++}`);
  assert.equal(nodes.length, 2);

  const detachedRoot = nodes.find((n) => n.tag === 'button')!;
  const detachedLabel = nodes.find((n) => n.type === 'text')!;
  assert.equal(detachedLabel.text, 'Detached', 'the override is baked in');
  assert.equal(detachedRoot.componentRef, undefined);
  assert.notEqual(detachedLabel.id, label.id);
  assert.equal(detachedLabel.parent, detachedRoot.id);
});

test('instancesOf finds every instance', () => {
  const { doc, artboard, componentId } = seedComponent();
  instantiate(doc, componentId, artboard);
  instantiate(doc, componentId, artboard);
  assert.equal(instancesOf(doc, componentId).length, 2);
});

test('collectSlots reports the definition’s slots', () => {
  const { doc, root } = seedComponent(true);
  assert.deepEqual(collectSlots(doc, doc.nodes[root.id]!), ['default']);
});

test('HTML export expands instances', () => {
  const { doc, artboard, componentId, label } = seedComponent();
  const instance = instantiate(doc, componentId, artboard);
  applyOp(doc, { t: 'override', updates: [{ id: instance.id, defId: label.id, override: { text: 'Exported' } }] });

  const { html } = emitHtml(doc, artboard, { mode: 'inline' });
  assert.match(html, /<button/);
  assert.match(html, /Exported/);
  assert.doesNotMatch(html, /data-slot/, 'slot markers are authoring metadata, not output');
});

test('JSX export expands instances and keeps per-instance overrides', () => {
  const { doc, artboard, componentId, label } = seedComponent();
  const a = instantiate(doc, componentId, artboard);
  const b = instantiate(doc, componentId, artboard);
  applyOp(doc, { t: 'override', updates: [{ id: a.id, defId: label.id, override: { text: 'First' } }] });
  applyOp(doc, { t: 'override', updates: [{ id: b.id, defId: label.id, override: { text: 'Second' } }] });

  const jsx = emitJsx(doc, artboard, { format: 'tailwind' });
  assert.match(jsx, /First/);
  assert.match(jsx, /Second/);
});

test('component ops invert', () => {
  const { doc, componentId } = seedComponent();
  const inverse = applyOp(doc, { t: 'component', action: 'remove', component: { id: componentId } });
  assert.equal(doc.components![componentId], undefined);
  applyOp(doc, inverse);
  assert.equal(doc.components![componentId]!.name, 'Button');
});

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

function seedVariants() {
  const { doc, artboard, componentId, root, label } = seedComponent();
  applyOp(doc, {
    t: 'component', action: 'update',
    component: {
      id: componentId,
      props: [
        { name: 'size', values: ['sm', 'md', 'lg'], default: 'md' },
        { name: 'tone', values: ['default', 'danger'], default: 'default' },
      ],
    },
  });
  // A size variant, a tone variant, and a more specific combination.
  applyOp(doc, { t: 'variant', componentId, match: { size: 'lg' }, overrides: { [root.id]: { styles: { padding: '20px 32px' } } } });
  applyOp(doc, { t: 'variant', componentId, match: { tone: 'danger' }, overrides: { [root.id]: { styles: { 'background-color': '#dc2626' } } } });
  applyOp(doc, {
    t: 'variant', componentId, match: { size: 'lg', tone: 'danger' },
    overrides: { [label.id]: { text: 'Delete everything' } },
  });
  return { doc, artboard, componentId, root, label };
}

test('an instance uses the declared defaults', () => {
  const { doc, artboard, componentId, root } = seedVariants();
  const instance = instantiate(doc, componentId, artboard);
  const expanded = expandInstance(doc, doc.nodes[instance.id]!)!;
  assert.equal(expanded.node.styles.padding, '12px 20px', 'default size applies no variant');
  void root;
});

test('setting a prop applies that variant', () => {
  const { doc, artboard, componentId } = seedVariants();
  const instance = instantiate(doc, componentId, artboard);
  applyOp(doc, { t: 'props', updates: [{ id: instance.id, props: { size: 'lg' } }] });

  const expanded = expandInstance(doc, doc.nodes[instance.id]!)!;
  assert.equal(expanded.node.styles.padding, '20px 32px');
});

test('variants compose, with the more specific one refining the less specific', () => {
  const { doc, artboard, componentId } = seedVariants();
  const instance = instantiate(doc, componentId, artboard);
  applyOp(doc, { t: 'props', updates: [{ id: instance.id, props: { size: 'lg', tone: 'danger' } }] });

  const expanded = expandInstance(doc, doc.nodes[instance.id]!)!;
  assert.equal(expanded.node.styles.padding, '20px 32px', 'size variant still applies');
  assert.equal(expanded.node.styles['background-color'], '#dc2626', 'tone variant still applies');
  assert.equal(expanded.children[0]!.node.text, 'Delete everything', 'the combination refines both');
});

test('instance overrides beat variants', () => {
  const { doc, artboard, componentId, root } = seedVariants();
  const instance = instantiate(doc, componentId, artboard);
  applyOp(doc, { t: 'props', updates: [{ id: instance.id, props: { tone: 'danger' } }] });
  applyOp(doc, { t: 'override', updates: [{ id: instance.id, defId: root.id, override: { styles: { 'background-color': '#16a34a' } } }] });

  const expanded = expandInstance(doc, doc.nodes[instance.id]!)!;
  assert.equal(expanded.node.styles['background-color'], '#16a34a');
});

test('two instances with different props render differently', () => {
  const { doc, artboard, componentId } = seedVariants();
  const a = instantiate(doc, componentId, artboard);
  const b = instantiate(doc, componentId, artboard);
  applyOp(doc, { t: 'props', updates: [{ id: a.id, props: { size: 'lg' } }] });

  assert.equal(expandInstance(doc, doc.nodes[a.id]!)!.node.styles.padding, '20px 32px');
  assert.equal(expandInstance(doc, doc.nodes[b.id]!)!.node.styles.padding, '12px 20px');
});

test('an undeclared prop value is ignored rather than breaking the instance', () => {
  const { doc, artboard, componentId } = seedVariants();
  const instance = instantiate(doc, componentId, artboard);
  applyOp(doc, { t: 'props', updates: [{ id: instance.id, props: { size: 'enormous', colour: 'teal' } }] });

  const props = resolvedProps(doc.components![componentId]!, doc.nodes[instance.id]!);
  assert.equal(props.size, 'md', 'an unknown value falls back to the default');
  assert.equal(props.colour, undefined, 'an undeclared property is dropped');
});

test('variant ops invert', () => {
  const { doc, componentId, root } = seedVariants();
  const before = structuredClone(doc.components![componentId]!.variants);

  const inverse = applyOp(doc, {
    t: 'variant', componentId, match: { size: 'lg' },
    overrides: { [root.id]: { styles: { padding: '99px' } } },
  });
  assert.equal(findVariant(doc.components![componentId]!, { size: 'lg' })!.overrides[root.id]!.styles!.padding, '99px');

  applyOp(doc, inverse);
  assert.deepEqual(doc.components![componentId]!.variants, before);
});

test('clearing a variant removes it from the matrix', () => {
  const { doc, componentId } = seedVariants();
  const count = doc.components![componentId]!.variants!.length;
  applyOp(doc, { t: 'variant', componentId, match: { size: 'lg' }, overrides: null });
  assert.equal(doc.components![componentId]!.variants!.length, count - 1);
});

test('variantMatrix enumerates every combination', () => {
  const { doc, componentId } = seedVariants();
  const matrix = variantMatrix(doc.components![componentId]!);
  assert.equal(matrix.length, 6, '3 sizes × 2 tones');
  assert.ok(matrix.some((m) => m.size === 'lg' && m.tone === 'danger'));
});

test('props op inverts', () => {
  const { doc, artboard, componentId } = seedVariants();
  const instance = instantiate(doc, componentId, artboard);
  applyOp(doc, { t: 'props', updates: [{ id: instance.id, props: { size: 'lg' } }] });
  const inverse = applyOp(doc, { t: 'props', updates: [{ id: instance.id, props: { size: 'sm' } }] });
  assert.equal(doc.nodes[instance.id]!.props!.size, 'sm');
  applyOp(doc, inverse);
  assert.equal(doc.nodes[instance.id]!.props!.size, 'lg');
});

test('detaching bakes in the variant, not just instance overrides', () => {
  const { doc, artboard, componentId } = seedVariants();
  const instance = instantiate(doc, componentId, artboard);
  applyOp(doc, { t: 'props', updates: [{ id: instance.id, props: { size: 'lg', tone: 'danger' } }] });

  let n = 0;
  const nodes = detachedNodes(doc, doc.nodes[instance.id]!, () => `x_${n++}`);
  const root = nodes.find((x) => x.tag === 'button')!;
  assert.equal(root.styles.padding, '20px 32px');
  assert.equal(root.styles['background-color'], '#dc2626');
});
