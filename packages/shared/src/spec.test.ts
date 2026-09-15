import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyDocument, makeComment, makeNode } from './model.ts';
import { applyOp } from './ops.ts';
import { describeSelector, notesFor, resolveValue, specFor } from './spec.ts';

function docWithCard() {
  const doc = createEmptyDocument('Spec');
  doc.tokens = [
    { name: 'color.brand', group: 'color', values: { default: '#4F46E5', dark: '#818CF8' } },
    { name: 'space.6', group: 'space', values: { default: '32px' } },
  ];
  const artboard = doc.pages[0]!.artboards[0]!;
  const card = makeNode({
    type: 'frame', name: 'Card', tag: 'div',
    styles: {
      display: 'flex', 'flex-direction': 'column', gap: 'var(--space-6)',
      padding: '32px', background: '#4F46E5', color: 'var(--color-brand)',
      'border-radius': '20px', 'mix-blend-mode': 'multiply',
    },
    variants: [{ selector: ':hover', styles: { background: 'var(--color-brand)' } }],
  });
  const label = makeNode({ type: 'text', name: 'Label', tag: 'span', text: 'Hello' });
  applyOp(doc, { t: 'insert', nodes: [card, label], parent: artboard, index: 0 });
  applyOp(doc, { t: 'move', moves: [{ id: label.id, parent: card.id, index: 0 }] });
  return { doc, cardId: card.id, labelId: label.id };
}

test('a value that references a token reports the token and what it resolves to', () => {
  const { doc } = docWithCard();
  const v = resolveValue('var(--color-brand)', doc.tokens);
  assert.equal(v.token, 'color.brand');
  assert.equal(v.resolved, '#4F46E5');
});

test('a theme is honoured when resolving', () => {
  const { doc } = docWithCard();
  assert.equal(resolveValue('var(--color-brand)', doc.tokens, 'dark').resolved, '#818CF8');
});

test('a raw value equal to a token is reported as that token', () => {
  // The interesting case: a hex someone pasted instead of using the variable.
  // Saying which token it matches is the whole point.
  const { doc } = docWithCard();
  const v = resolveValue('#4f46e5', doc.tokens);
  assert.equal(v.token, 'color.brand');
});

test('an unknown var is left alone rather than guessed at', () => {
  const { doc } = docWithCard();
  const v = resolveValue('var(--not-a-token)', doc.tokens);
  assert.equal(v.token, undefined);
  assert.equal(v.value, 'var(--not-a-token)');
});

test('styles are grouped the way a developer reads them', () => {
  const { doc, cardId } = docWithCard();
  const spec = specFor(doc, cardId);
  const labels = spec.groups.map((g) => g.label);
  assert.ok(labels.includes('Layout'));
  assert.ok(labels.includes('Spacing'));
  assert.ok(labels.includes('Colour'));
});

test('nothing is dropped: an unclassified property lands in Other', () => {
  const { doc, cardId } = docWithCard();
  const spec = specFor(doc, cardId);
  const other = spec.groups.find((g) => g.label === 'Other');
  assert.ok(other?.entries.some((e) => e.label === 'mix-blend-mode'));
});

test('variants are described in words as well as selectors', () => {
  const { doc, cardId } = docWithCard();
  const spec = specFor(doc, cardId);
  assert.equal(spec.variants[0]?.when, 'on hover');
  assert.equal(spec.variants[0]?.changes[0]?.value.token, 'color.brand');
});

test('breakpoints read as widths', () => {
  assert.equal(describeSelector('@media (max-width: 700px)'), 'up to 700px wide');
  assert.equal(describeSelector('@media (min-width: 64rem)'), 'from 64rem wide');
  assert.equal(describeSelector(':focus-visible'), 'when focused by keyboard');
});

test('notes on a child belong to the parent spec, and say where they are', () => {
  const { doc, cardId, labelId } = docWithCard();
  doc.comments = [
    makeComment({ pageId: doc.pages[0]!.id, nodeId: cardId, kind: 'constraint', text: 'Stays above the fold' }),
    makeComment({ pageId: doc.pages[0]!.id, nodeId: labelId, kind: 'data', text: 'Comes from user.name' }),
  ];
  const notes = notesFor(doc, cardId);
  assert.equal(notes.length, 2);
  const onChild = notes.find((n) => n.kind === 'data');
  assert.equal(onChild?.on?.name, 'Label');
  assert.equal(notes.find((n) => n.kind === 'constraint')?.on, undefined);
});

test('a note somewhere else in the document is not in this spec', () => {
  const { doc, cardId, labelId } = docWithCard();
  const artboard = doc.pages[0]!.artboards[0]!;
  doc.comments = [makeComment({ pageId: doc.pages[0]!.id, nodeId: artboard, text: 'About the screen' })];
  assert.equal(notesFor(doc, cardId).length, 0);
  assert.equal(notesFor(doc, labelId).length, 0);
});

test('unresolved notes come first', () => {
  const { doc, cardId } = docWithCard();
  doc.comments = [
    makeComment({ pageId: doc.pages[0]!.id, nodeId: cardId, text: 'Settled', resolved: true }),
    makeComment({ pageId: doc.pages[0]!.id, nodeId: cardId, text: 'Open' }),
  ];
  assert.equal(notesFor(doc, cardId)[0]?.text, 'Open');
});

test('an instance says which component it came from', () => {
  const { doc, cardId } = docWithCard();
  doc.components = { cmp_1: { id: 'cmp_1', name: 'Card', root: 'n_def', createdAt: Date.now() } };
  doc.nodes[cardId]!.componentRef = 'cmp_1';
  assert.deepEqual(specFor(doc, cardId).component, { id: 'cmp_1', name: 'Card', role: 'instance' });
});
