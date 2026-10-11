import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOp, createEmptyDocument, makeNode, DEFAULT_ARTBOARD_STYLES, sectionRect, arrangeSectionOps,
  moveSectionOps, sectionAt, specFor, SECTION_LAYOUT, type CanvasDocument, type Op } from './index.ts';

function doc3(): CanvasDocument {
  const doc = createEmptyDocument();
  const page = doc.pages[0]!;
  for (const [i, x] of [[1, 0], [2, 500], [3, 1000]] as const) {
    const n = makeNode({ id: `a${i}`, type: 'artboard', name: `S${i}`, styles: { ...DEFAULT_ARTBOARD_STYLES, width: '390px', height: '844px' }, attrs: { 'data-x': String(x), 'data-y': '0' } });
    applyOp(doc, { t: 'insert', nodes: [n], parent: null, index: page.artboards.length, page: page.id });
  }
  return doc;
}

test('sections: add / update / remove are undoable', () => {
    const doc = doc3();
    const pageId = doc.pages[0]!.id;
    const undoAdd = applyOp(doc, { t: 'section', action: 'add', pageId, section: { id: 's1', title: 'Onboarding', artboards: ['a1', 'a2'] } });
    const s0 = doc.pages[0]!.sections![0]!; assert.deepEqual([s0.title, s0.status, s0.order], ['Onboarding', 'draft', 0]);
    const undoUpd = applyOp(doc, { t: 'section', action: 'update', pageId, section: { id: 's1', status: 'ready' } });
    assert.equal(doc.pages[0]!.sections![0]!.status, 'ready');
    applyOp(doc, undoUpd);
    assert.equal(doc.pages[0]!.sections![0]!.status, 'draft');
    const undoRm = applyOp(doc, { t: 'section', action: 'remove', pageId, section: { id: 's1' } });
    assert.equal(doc.pages[0]!.sections!.length, 0);
    applyOp(doc, undoRm);
    applyOp(doc, undoAdd);
    assert.equal(doc.pages[0]!.sections!.length, 0);
  });

test('sections: an artboard belongs to one section', () => {
    const doc = doc3();
    const pageId = doc.pages[0]!.id;
    applyOp(doc, { t: 'section', action: 'add', pageId, section: { id: 's1', artboards: ['a1'] } });
    assert.throws(() => applyOp(doc, { t: 'section', action: 'add', pageId, section: { id: 's2', artboards: ['a1'] } }));
  });

test('sections: region wraps members and grows with them', () => {
    const doc = doc3();
    const page = doc.pages[0]!;
    applyOp(doc, { t: 'section', action: 'add', pageId: page.id, section: { id: 's1', artboards: ['a1', 'a2'] } });
    const { padding, header } = SECTION_LAYOUT;
    assert.deepEqual(sectionRect(doc, page, page.sections![0]!), { x: -padding, y: -padding - header, width: 890 + 2 * padding, height: 844 + 2 * padding + header });
    assert.equal(sectionAt(doc, page, 100, 100)?.id, 's1');
    assert.equal(sectionAt(doc, page, 1200, 100), undefined);
  });

test('sections: arrange and move produce attr ops', () => {
    const doc = doc3();
    const page = doc.pages[0]!;
    applyOp(doc, { t: 'section', action: 'add', pageId: page.id, section: { id: 's1', artboards: ['a3', 'a1'] } });
    for (const op of arrangeSectionOps(doc, page, page.sections![0]!, { gap: 10 })) applyOp(doc, op as Op);
    assert.equal(doc.nodes.a3!.attrs['data-x'], '0');
    assert.equal(doc.nodes.a1!.attrs['data-x'], '400');
    for (const op of moveSectionOps(doc, page, page.sections![0]!, 5, 7)) applyOp(doc, op);
    assert.equal(doc.nodes.a1!.attrs['data-y'], '7');
  });

test('sections: spec carries section status', () => {
    const doc = doc3();
    applyOp(doc, { t: 'section', action: 'add', pageId: doc.pages[0]!.id, section: { id: 's1', title: 'Pay', status: 'ready', artboards: ['a2'] } });
    assert.deepEqual(specFor(doc, 'a2').section, { id: 's1', title: 'Pay', status: 'ready' });
  });


test('sections: arranging keeps sectionGap clear of other sections', () => {
  const doc = doc3();
  const page = doc.pages[0]!;
  applyOp(doc, { t: 'section', action: 'add', pageId: page.id, section: { id: 's1', artboards: ['a1'] } });
  applyOp(doc, { t: 'section', action: 'add', pageId: page.id, section: { id: 's2', artboards: ['a2', 'a3'] } });
  for (const op of arrangeSectionOps(doc, page, page.sections![1]!)) applyOp(doc, op as Op);
  const r1 = sectionRect(doc, page, page.sections![0]!)!;
  const r2 = sectionRect(doc, page, page.sections![1]!)!;
  assert.ok(r2.y - (r1.y + r1.height) >= SECTION_LAYOUT.sectionGap, 'sections stay apart');
  assert.equal(Number(doc.nodes.a3!.attrs['data-x']) - Number(doc.nodes.a2!.attrs['data-x']), 390 + SECTION_LAYOUT.gap);
});

test('cross-page: screen cards resolve, flows resolve, artboard theme picks token values', async () => {
  const { resolveScreen, screenCardSize, emitBoardSvg, makeBoardShape, findFlow, sectionFlows, artboardTheme, emitHtml } = await import('./index.ts');
  const doc = doc3();
  doc.pages.push({ id: 'flows', name: 'User flows', artboards: [], board: [] });
  const card = makeBoardShape({ kind: 'screen', ref: 'a1', text: 'S1', x: 0, y: 0, ...screenCardSize(doc, 'a1') });
  const group = makeBoardShape({ kind: 'section', text: 'Sign in\nmore', x: -40, y: -80, width: 400, height: 500 });
  doc.pages[1]!.board!.push(group, card);
  assert.deepEqual(resolveScreen(doc, 'a1'), { id: 'a1', name: 'S1', pageId: doc.pages[0]!.id, pageName: doc.pages[0]!.name });
  assert.ok(card.height > card.width, 'a phone screen makes a tall card');
  assert.deepEqual(findFlow(doc, group.id), { id: group.id, title: 'Sign in', pageId: 'flows', pageName: 'User flows', kind: 'section' });
  assert.deepEqual(sectionFlows(doc, { id: 's', title: 's', status: 'draft', artboards: [], order: 0, flows: [group.id, 'gone'] }).map((f) => f.id), [group.id]);

  applyOp(doc, { t: 'remove', ids: ['a1'] });
  assert.equal(resolveScreen(doc, 'a1'), null);
  assert.match(emitBoardSvg(doc, doc.pages[1]!), /Missing screen/);

  doc.tokens.push({ name: 'color.bg', group: 'color', values: { default: '#ffffff', dark: '#000000' } });
  assert.equal(artboardTheme(doc, 'a2'), 'default');
  applyOp(doc, { t: 'attrs', updates: [{ id: 'a2', attrs: { 'data-theme': 'dark' } }] });
  assert.equal(artboardTheme(doc, 'a2'), 'dark');
  assert.match(emitHtml(doc, 'a2').css, /--color-bg: #000000/);
  applyOp(doc, { t: 'attrs', updates: [{ id: 'a3', attrs: { 'data-theme': 'nonsense' } }] });
  assert.equal(artboardTheme(doc, 'a3'), 'default', 'an unknown theme falls back');
});
