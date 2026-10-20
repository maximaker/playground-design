import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOp, createEmptyDocument, makeNode, DEFAULT_ARTBOARD_STYLES, marqueePick, artboardsToMove, edgeSpeed, type CanvasDocument } from './index.ts';

function deck(): CanvasDocument {
  const doc = createEmptyDocument();
  const page = doc.pages[0]!;
  for (const i of [1, 2, 3]) {
    const n = makeNode({ id: `a${i}`, type: 'artboard', name: `S${i}`, styles: { ...DEFAULT_ARTBOARD_STYLES }, attrs: { 'data-x': String(i * 500), 'data-y': '0' } });
    applyOp(doc, { t: 'insert', nodes: [n], parent: null, index: page.artboards.length, page: page.id });
    const child = makeNode({ id: `t${i}`, type: 'text', name: 'Title' });
    applyOp(doc, { t: 'insert', nodes: [child], parent: `a${i}`, index: 0 });
  }
  return doc;
}

test('marquee: enclosed artboards win over partly caught layers and board items', () => {
  const doc = deck();
  assert.deepEqual(marqueePick(doc, ['a1', 'a2', 't3'], ['sec1']), { nodes: ['a1', 'a2'], board: [] });
});

test('marquee: layers without artboards still beat the board', () => {
  const doc = deck();
  assert.deepEqual(marqueePick(doc, ['t1'], ['sec1']), { nodes: ['t1'], board: [] });
});

test('marquee: board items only when no layer was caught', () => {
  const doc = deck();
  assert.deepEqual(marqueePick(doc, [], ['r1', 'sec1']), { nodes: [], board: ['r1', 'sec1'] });
  assert.deepEqual(marqueePick(doc, [], []), { nodes: [], board: [] });
});

test('group move: pressing a selected artboard moves every selected artboard', () => {
  const doc = deck();
  assert.deepEqual(artboardsToMove(doc, ['a1', 'a2', 'a3'], 'a2'), ['a1', 'a2', 'a3']);
});

test('group move: pressing an unselected artboard moves only it', () => {
  const doc = deck();
  assert.deepEqual(artboardsToMove(doc, ['a1', 'a2'], 'a3'), ['a3']);
});

test('group move: nested layers in the selection are ignored', () => {
  const doc = deck();
  assert.deepEqual(artboardsToMove(doc, ['a1', 't2', 'a2'], 'a1'), ['a1', 'a2']);
});

test('auto-pan: still in the middle, faster nearer the edge, capped past it', () => {
  assert.equal(edgeSpeed(500, 0, 1000), 0);
  assert.ok(edgeSpeed(40, 0, 1000) > 0);
  assert.ok(edgeSpeed(5, 0, 1000) > edgeSpeed(40, 0, 1000));
  assert.equal(edgeSpeed(-200, 0, 1000), 18);
  assert.ok(edgeSpeed(990, 0, 1000) < 0);
  assert.equal(edgeSpeed(1200, 0, 1000), -18);
});
