import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyDocument, makeNode } from './model.ts';
import { cloneSubtree } from './ops.ts';

test('cloneSubtree does not share instance overrides with the original', () => {
  const doc = createEmptyDocument();
  const node = { ...makeNode({ type: 'instance', name: 'I', componentRef: 'c' }), overrides: { d: { text: 'a' } } };
  doc.nodes[node.id] = node as never;
  const { nodes } = cloneSubtree(doc, node.id);
  (nodes[0] as typeof node).overrides.d.text = 'b';
  assert.equal(node.overrides.d.text, 'a');
});
