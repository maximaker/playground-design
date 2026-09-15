import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyDocument, makeNode } from './model.ts';
import { applyOp } from './ops.ts';
import { changesWithin, diffDocuments } from './diff.ts';

function seed() {
  const doc = createEmptyDocument('Diff');
  const artboard = doc.pages[0]!.artboards[0]!;
  const card = makeNode({ type: 'frame', name: 'Card', tag: 'div', styles: { padding: '32px', gap: '12px' } });
  const label = makeNode({ type: 'text', name: 'Label', tag: 'span', text: 'Before' });
  applyOp(doc, { t: 'insert', nodes: [card], parent: artboard, index: 0 });
  applyOp(doc, { t: 'insert', nodes: [label], parent: card.id, index: 0 });
  return { doc, artboard, cardId: card.id, labelId: label.id };
}

const clone = (d: unknown) => structuredClone(d) as ReturnType<typeof createEmptyDocument>;

test('an untouched document reports no changes', () => {
  const { doc } = seed();
  const diff = diffDocuments(clone(doc), doc);
  assert.equal(diff.same, true);
  assert.equal(diff.nodes.length, 0);
});

test('a changed style is reported with both values', () => {
  const { doc, cardId } = seed();
  const before = clone(doc);
  applyOp(doc, { t: 'styles', updates: [{ id: cardId, styles: { padding: '40px' } }] });
  const diff = diffDocuments(before, doc);
  const change = diff.nodes.find((n) => n.id === cardId);
  assert.equal(change?.kind, 'changed');
  assert.deepEqual(change?.fields.find((f) => f.field === 'styles.padding'),
    { field: 'styles.padding', before: '32px', after: '40px' });
});

test('and says which artboard it is on', () => {
  const { doc, cardId, artboard } = seed();
  const before = clone(doc);
  applyOp(doc, { t: 'styles', updates: [{ id: cardId, styles: { padding: '40px' } }] });
  const diff = diffDocuments(before, doc);
  assert.equal(diff.nodes[0]?.artboard?.id, artboard);
  assert.equal(diff.byArtboard[0]?.changes, 1);
});

test('text changes are reported', () => {
  const { doc, labelId } = seed();
  const before = clone(doc);
  applyOp(doc, { t: 'text', updates: [{ id: labelId, text: 'After' }] });
  const diff = diffDocuments(before, doc);
  assert.deepEqual(diff.nodes[0]?.fields[0], { field: 'text', before: 'Before', after: 'After' });
});

test('an added subtree is reported once, by its root', () => {
  const { doc, artboard } = seed();
  const before = clone(doc);
  const wrapper = makeNode({ type: 'frame', name: 'New section', tag: 'section' });
  const inner = makeNode({ type: 'text', name: 'Inner', tag: 'p', text: 'Hello' });
  applyOp(doc, { t: 'insert', nodes: [wrapper], parent: artboard, index: 1 });
  applyOp(doc, { t: 'insert', nodes: [inner], parent: wrapper.id, index: 0 });
  const diff = diffDocuments(before, doc);
  const added = diff.nodes.filter((n) => n.kind === 'added');
  assert.equal(added.length, 1);
  assert.equal(added[0]?.name, 'New section');
});

test('a removed subtree is reported once too', () => {
  const { doc, cardId } = seed();
  const before = clone(doc);
  applyOp(doc, { t: 'remove', ids: [cardId] });
  const diff = diffDocuments(before, doc);
  assert.equal(diff.counts.removed, 1);
  assert.equal(diff.nodes[0]?.name, 'Card');
});

test('dragging an artboard around the canvas is not a change', () => {
  // Canvas position lives in attributes, and moving a frame on the canvas says
  // nothing about what anyone has to build.
  const { doc, artboard } = seed();
  const before = clone(doc);
  applyOp(doc, { t: 'attrs', updates: [{ id: artboard, attrs: { 'data-x': '900', 'data-y': '120' } }] });
  assert.equal(diffDocuments(before, doc).same, true);
});

test('a token value moving is reported on its own', () => {
  const { doc } = seed();
  doc.tokens = [{ name: 'color.brand', group: 'color', values: { default: '#111' } }];
  const before = clone(doc);
  doc.tokens = [{ name: 'color.brand', group: 'color', values: { default: '#222' } }];
  const diff = diffDocuments(before, doc);
  assert.equal(diff.same, false);
  assert.equal(diff.tokens[0]?.field, 'color.brand');
  assert.ok(diff.tokens[0]?.after?.includes('#222'));
});

test('changed comes before added, which comes before removed', () => {
  const { doc, cardId, artboard } = seed();
  const before = clone(doc);
  applyOp(doc, { t: 'styles', updates: [{ id: cardId, styles: { gap: '20px' } }] });
  const added = makeNode({ type: 'frame', name: 'Added', tag: 'div' });
  applyOp(doc, { t: 'insert', nodes: [added], parent: artboard, index: 1 });
  const diff = diffDocuments(before, doc);
  assert.deepEqual(diff.nodes.map((n) => n.kind).slice(0, 2), ['changed', 'added']);
});

test('changesWithin narrows to one subtree', () => {
  const { doc, cardId, labelId, artboard } = seed();
  const before = clone(doc);
  applyOp(doc, { t: 'text', updates: [{ id: labelId, text: 'After' }] });
  const other = makeNode({ type: 'frame', name: 'Other', tag: 'div' });
  applyOp(doc, { t: 'insert', nodes: [other], parent: artboard, index: 1 });
  const diff = diffDocuments(before, doc);
  const within = changesWithin(diff, doc, cardId);
  assert.equal(within.length, 1);
  assert.equal(within[0]?.id, labelId);
});

test('reordering children is reported as such', () => {
  const { doc, cardId } = seed();
  const second = makeNode({ type: 'text', name: 'Second', tag: 'span', text: 'Two' });
  applyOp(doc, { t: 'insert', nodes: [second], parent: cardId, index: 1 });
  const before = clone(doc);
  const card = doc.nodes[cardId]!;
  card.children = [...card.children].reverse();
  const diff = diffDocuments(before, doc);
  assert.ok(diff.nodes[0]?.fields.some((f) => f.field === 'children' && f.after?.includes('reordered')));
});
