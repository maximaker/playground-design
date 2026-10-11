import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyDocument } from './model.ts';
import { applyOp, makeSection } from './ops.ts';
import { basicInfo } from './summary.ts';
import { describeVersion, findVersionTarget, versionOps } from './versions.ts';

function twoPages() {
  const doc = createEmptyDocument('V');
  applyOp(doc, { t: 'page', action: 'add', page: { id: 'p2', name: 'V2', artboards: [] } });
  return doc;
}

test('marks a page current and another superseded, linking the replacement automatically', () => {
  const doc = twoPages();
  const v1 = doc.pages[0]!.id;
  for (const op of versionOps(doc, findVersionTarget(doc, 'p2')!, { state: 'current' })) applyOp(doc, op);
  for (const op of versionOps(doc, findVersionTarget(doc, v1)!, { state: 'superseded', reason: 'Client chose V2' })) applyOp(doc, op);
  assert.equal(doc.pages[1]!.version!.state, 'current');
  assert.deepEqual({ ...doc.pages[0]!.version, at: undefined }, { state: 'superseded', reason: 'Client chose V2', replacedBy: 'p2', at: undefined });
  const info = basicInfo(doc);
  assert.equal(info.pages[0]!.version!.replacedBy!.title, 'V2');
  assert.equal(info.pages[0]!.name, 'Page 1', 'the page is not renamed');
});

test('a version change undoes, and clearing removes it', () => {
  const doc = twoPages();
  const [op] = versionOps(doc, findVersionTarget(doc, 'p2')!, { state: 'current' });
  const inverse = applyOp(doc, op!);
  assert.equal(doc.pages[1]!.version!.state, 'current');
  applyOp(doc, inverse);
  assert.equal(doc.pages[1]!.version ?? null, null);
});

test('sections carry versions too, and replacedBy is validated', () => {
  const doc = createEmptyDocument('S');
  const page = doc.pages[0]!;
  page.sections = [makeSection({ id: 's1', title: 'Checkout v1' }), makeSection({ id: 's2', title: 'Checkout v2', order: 1 })];
  for (const op of versionOps(doc, findVersionTarget(doc, 's1')!, { state: 'superseded', replacedBy: 's2' })) applyOp(doc, op);
  assert.equal(describeVersion(doc, page.sections[0]!.version)!.replacedBy!.title, 'Checkout v2');
  assert.throws(() => versionOps(doc, findVersionTarget(doc, 's1')!, { state: 'superseded', replacedBy: 'nope' }), /no page or section/);
  assert.throws(() => versionOps(doc, findVersionTarget(doc, 's1')!, { state: 'superseded', replacedBy: 's1' }), /itself/);
});
