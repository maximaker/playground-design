import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyDocument, commentsOf, makeComment } from './model.ts';
import { applyOp, touchedNodes } from './ops.ts';

function docWithComment() {
  const doc = createEmptyDocument('Test');
  const pageId = doc.pages[0]!.id;
  const comment = makeComment({ id: 'cm1', pageId, x: 40, y: 60, author: 'Max', text: 'Too big' });
  applyOp(doc, { t: 'comment', action: 'add', comment });
  return { doc, pageId };
}

test('adding a comment is reversible', () => {
  const { doc } = docWithComment();
  assert.equal(commentsOf(doc).length, 1);
  const inverse = applyOp(doc, { t: 'comment', action: 'remove', comment: { id: 'cm1' } });
  assert.equal(commentsOf(doc).length, 0);
  applyOp(doc, inverse);
  assert.equal(commentsOf(doc)[0]!.text, 'Too big', 'undoing a delete restores the whole thread');
});

test('a reply appends rather than replacing the list', () => {
  const { doc } = docWithComment();
  applyOp(doc, {
    t: 'comment', action: 'reply', comment: { id: 'cm1' },
    reply: { id: 'r1', author: 'Sam', text: 'Agreed', kind: 'human', createdAt: 1 },
  });
  const inverse = applyOp(doc, {
    t: 'comment', action: 'reply', comment: { id: 'cm1' },
    reply: { id: 'r2', author: 'Agent', text: 'Fixed', kind: 'agent', createdAt: 2 },
  });
  assert.deepEqual(commentsOf(doc)[0]!.replies.map((r) => r.id), ['r1', 'r2']);

  // Undoing the second reply must not take the first with it — which is what a
  // whole-array update would do when two people reply at once.
  applyOp(doc, inverse);
  assert.deepEqual(commentsOf(doc)[0]!.replies.map((r) => r.id), ['r1']);
});

test('resolving is an update, and reverses', () => {
  const { doc } = docWithComment();
  const inverse = applyOp(doc, { t: 'comment', action: 'update', comment: { id: 'cm1', resolved: true } });
  assert.equal(commentsOf(doc)[0]!.resolved, true);
  applyOp(doc, inverse);
  assert.equal(commentsOf(doc)[0]!.resolved, false);
});

test('an update leaves the fields it does not mention alone', () => {
  const { doc } = docWithComment();
  applyOp(doc, { t: 'comment', action: 'update', comment: { id: 'cm1', x: 200 } });
  const c = commentsOf(doc)[0]!;
  assert.equal(c.x, 200);
  assert.equal(c.text, 'Too big');
  assert.equal(c.author, 'Max');
});

test('comments are filtered by page', () => {
  const { doc, pageId } = docWithComment();
  applyOp(doc, {
    t: 'comment', action: 'add',
    comment: makeComment({ id: 'cm2', pageId: 'other', text: 'elsewhere' }),
  });
  assert.equal(commentsOf(doc, pageId).length, 1);
  assert.equal(commentsOf(doc, 'other').length, 1);
  assert.equal(commentsOf(doc).length, 2);
});

test('a comment touches no node', () => {
  // Comments change nothing about how anything renders, so they must not
  // invalidate node versions or force an artboard to re-measure.
  const touched = touchedNodes({
    t: 'comment', action: 'add', comment: makeComment({ id: 'x', pageId: 'p' }),
  });
  assert.equal(touched.nodes.length, 0);
  assert.equal(touched.structure.length, 0);
  assert.equal(touched.global, false);
});

test('adding the same comment twice is refused', () => {
  const { doc, pageId } = docWithComment();
  assert.throws(() => applyOp(doc, {
    t: 'comment', action: 'add', comment: makeComment({ id: 'cm1', pageId }),
  }), /already exists/);
});
