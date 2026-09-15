import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyDocument, makeNode } from './model.ts';
import { applyOp } from './ops.ts';
import { BUNDLE_FORMAT, referencedAssets, remapAssets, stripLocalState, validateBundle } from './bundle.ts';

function docWithAssets() {
  const doc = createEmptyDocument('Bundle');
  const artboard = doc.nodes[doc.pages[0]!.artboards[0]!]!;
  const img = makeNode({
    type: 'image', tag: 'img', parent: artboard.id,
    attrs: { src: 'http://example.com/assets/a_one', alt: '' },
    styles: { 'background-image': 'url(/assets/a_two)' },
  });
  applyOp(doc, { t: 'insert', nodes: [img], parent: artboard.id, index: 0 });
  applyOp(doc, {
    t: 'code-component', action: 'add',
    component: { id: 'cc1', name: 'Button', importPath: '@/b', bundle: 'a_three' },
  });
  return { doc, img };
}

test('finds every asset reference, wherever it hides', () => {
  const { doc } = docWithAssets();
  assert.deepEqual([...referencedAssets(doc)].sort(), ['a_one', 'a_three', 'a_two']);
});

test('finds references inside variant styles too', () => {
  const { doc, img } = docWithAssets();
  doc.nodes[img.id]!.variants.push({ selector: ':hover', styles: { 'background-image': 'url(/assets/a_four)' } });
  assert.ok(referencedAssets(doc).has('a_four'), 'a variant can carry an image the base does not');
});

test('remapping rewrites every reference and leaves unknown ones alone', () => {
  const { doc, img } = docWithAssets();
  remapAssets(doc, new Map([['a_one', 'b_1'], ['a_two', 'b_2'], ['a_three', 'b_3']]));
  assert.equal(doc.nodes[img.id]!.attrs.src, 'http://example.com/assets/b_1');
  assert.equal(doc.nodes[img.id]!.styles['background-image'], 'url(/assets/b_2)');
  assert.equal(doc.codeComponents!.cc1!.bundle, 'b_3');
});

test('an id with no mapping is left as it was', () => {
  const { doc, img } = docWithAssets();
  remapAssets(doc, new Map());
  assert.equal(doc.nodes[img.id]!.attrs.src, 'http://example.com/assets/a_one');
});

test('a well-formed bundle validates', () => {
  const { doc } = docWithAssets();
  const result = validateBundle({
    format: BUNDLE_FORMAT, exportedAt: new Date().toISOString(), document: doc,
    assets: [...referencedAssets(doc)].map((id) => ({ id, mime: 'image/png', name: null, data: '' })),
  });
  assert.equal(result.ok, true);
});

test('a dangling child reference is refused, not imported', () => {
  // A document whose tree does not close renders as a blank canvas with no
  // explanation, which is worse than being told the file is broken.
  const { doc } = docWithAssets();
  const artboard = doc.pages[0]!.artboards[0]!;
  doc.nodes[artboard]!.children.push('n_does_not_exist');
  const result = validateBundle({ format: BUNDLE_FORMAT, exportedAt: '', document: doc, assets: [] });
  assert.equal(result.ok, false);
  assert.match(result.problems.join(' '), /dangling.*n_does_not_exist/);
});

test('a page pointing at a missing artboard is refused', () => {
  const { doc } = docWithAssets();
  doc.pages[0]!.artboards.push('n_missing');
  const result = validateBundle({ format: BUNDLE_FORMAT, exportedAt: '', document: doc, assets: [] });
  assert.equal(result.ok, false);
});

test('the wrong format is refused', () => {
  const { doc } = docWithAssets();
  const result = validateBundle({ format: 'something/else', document: doc, assets: [] });
  assert.equal(result.ok, false);
  assert.match(result.problems.join(' '), /format/);
});

test('missing assets are a note, not a refusal', () => {
  // A bundle exported without its assets is still worth importing; the images
  // simply will not resolve, and saying so beats a silent blank.
  const { doc } = docWithAssets();
  const result = validateBundle({ format: BUNDLE_FORMAT, exportedAt: '', document: doc, assets: [] });
  assert.equal(result.ok, true);
  // But it is reported, so the importer can say which images will be blank
  // rather than leaving someone to discover it.
  assert.match(result.problems.join(' '), /NOTE 3 asset\(s\) referenced but not included/);
});

test('project membership does not travel', () => {
  const { doc } = docWithAssets();
  doc.projectId = 'proj_local';
  assert.equal(stripLocalState(doc).projectId, undefined);
  assert.equal(doc.projectId, 'proj_local', 'the original is not mutated');
});
