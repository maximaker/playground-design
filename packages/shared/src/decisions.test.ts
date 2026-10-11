import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyDocument, makeComment } from './index.ts';
import { applyOp } from './ops.ts';
import { decisionsOf, decisionsMarkdown, describeDecision, resolveWithOutcomeOps, addDecisionOps } from './decisions.ts';
import { stripLocalState } from './bundle.ts';

function withThread() {
  const doc = createEmptyDocument('Decide');
  const page = doc.pages[0]!;
  const comment = makeComment({ pageId: page.id, nodeId: page.artboards[0], text: 'Lime or navy CTA?', author: 'Ana' } as never);
  applyOp(doc, { t: 'comment', action: 'add', comment });
  return { doc, comment: doc.comments![0]! };
}

test('resolving with an outcome logs a decision linked to the thread and layer', () => {
  const { doc, comment } = withThread();
  for (const op of resolveWithOutcomeOps(doc, comment, 'Keep the lime CTA', 'Max')) applyOp(doc, op);
  assert.equal(doc.comments![0]!.resolved, true);
  const [d] = decisionsOf(doc);
  assert.equal(d!.text, 'Keep the lime CTA');
  const info = describeDecision(doc, d!);
  assert.equal(info.by, 'Max');
  assert.deepEqual(info.thread, { id: comment.id, text: 'Lime or navy CTA?', author: 'Ana' });
  assert.equal(info.node!.id, comment.nodeId);
  assert.match(decisionsMarkdown(doc), /Keep the lime CTA _\(Max\)_/);
});

test('re-resolving replaces the outcome; no outcome logs nothing; undo removes the entry', () => {
  const { doc, comment } = withThread();
  for (const op of resolveWithOutcomeOps(doc, comment, '', 'Max')) applyOp(doc, op);
  assert.equal(decisionsOf(doc).length, 0);
  for (const op of resolveWithOutcomeOps(doc, comment, 'Navy', 'Max')) applyOp(doc, op);
  for (const op of resolveWithOutcomeOps(doc, comment, 'Lime after all', 'Max')) applyOp(doc, op);
  assert.deepEqual(decisionsOf(doc).map((d) => d.text), ['Lime after all']);
  const [op] = addDecisionOps({ text: 'Ship Friday', by: 'Client' });
  const inverse = applyOp(doc, op!);
  assert.equal(decisionsOf(doc).length, 2);
  applyOp(doc, inverse);
  assert.equal(decisionsOf(doc).length, 1);
});

test('the document bundle carries the decisions log', () => {
  const { doc, comment } = withThread();
  for (const op of resolveWithOutcomeOps(doc, comment, 'Keep lime', 'Max')) applyOp(doc, op);
  assert.equal(stripLocalState(doc).decisions!.length, 1);
});
