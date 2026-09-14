import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyDocument, makeNode, descendants, artboardOf, isAncestorOf, contestedProperties } from './model.ts';
import { applyOp, cloneSubtree } from './ops.ts';
import { parseHtml, emitHtml, emitStandalone } from './html.ts';
import { emitJsx, cssToTailwind } from './jsx.ts';
import { parseDeclarations, parseStylesheet } from './css.ts';
import { treeSummary, basicInfo } from './summary.ts';

function seed() {
  const doc = createEmptyDocument('Test');
  const artboard = doc.pages[0]!.artboards[0]!;
  return { doc, artboard };
}

test('insert then remove round-trips', () => {
  const { doc, artboard } = seed();
  const frame = makeNode({ type: 'frame', name: 'Card' });
  const inverse = applyOp(doc, { t: 'insert', nodes: [frame], parent: artboard, index: 0 });
  assert.equal(doc.nodes[artboard]!.children.length, 1);
  assert.equal(doc.nodes[frame.id]!.parent, artboard);

  const redo = applyOp(doc, inverse);
  assert.equal(doc.nodes[frame.id], undefined);
  assert.equal(doc.nodes[artboard]!.children.length, 0);

  applyOp(doc, redo);
  assert.ok(doc.nodes[frame.id]);
  assert.equal(doc.nodes[artboard]!.children[0], frame.id);
});

test('remove captures and restores an entire subtree', () => {
  const { doc, artboard } = seed();
  const parent = makeNode({ type: 'frame', name: 'Parent' });
  const child = makeNode({ type: 'text', name: 'Child', text: 'hi', parent: parent.id });
  parent.children = [child.id];
  applyOp(doc, { t: 'insert', nodes: [parent, child], parent: artboard, index: 0 });
  assert.equal(descendants(doc, artboard).length, 2);

  const inverse = applyOp(doc, { t: 'remove', ids: [parent.id] });
  assert.equal(descendants(doc, artboard).length, 0);

  applyOp(doc, inverse);
  assert.equal(descendants(doc, artboard).length, 2);
  assert.equal(doc.nodes[child.id]!.text, 'hi');
});

test('styles op inverse restores previous values and removals', () => {
  const { doc, artboard } = seed();
  const inverse = applyOp(doc, {
    t: 'styles',
    updates: [{ id: artboard, styles: { 'background-color': '#000', gap: '' } }],
  });
  assert.equal(doc.nodes[artboard]!.styles['background-color'], '#000');
  assert.equal(doc.nodes[artboard]!.styles.gap, undefined);

  applyOp(doc, inverse);
  assert.equal(doc.nodes[artboard]!.styles['background-color'], '#ffffff');
  assert.equal(doc.nodes[artboard]!.styles.gap, '0px');
});

test('move preserves ids and rejects moving a node into its own subtree', () => {
  const { doc, artboard } = seed();
  const a = makeNode({ type: 'frame', name: 'A' });
  const b = makeNode({ type: 'frame', name: 'B' });
  applyOp(doc, { t: 'insert', nodes: [a], parent: artboard, index: 0 });
  applyOp(doc, { t: 'insert', nodes: [b], parent: a.id, index: 0 });

  assert.throws(() => applyOp(doc, { t: 'move', moves: [{ id: a.id, parent: b.id, index: 0 }] }));

  const inverse = applyOp(doc, { t: 'move', moves: [{ id: b.id, parent: artboard, index: 0 }] });
  assert.equal(doc.nodes[b.id]!.parent, artboard);
  assert.equal(doc.nodes[artboard]!.children[0], b.id);

  applyOp(doc, inverse);
  assert.equal(doc.nodes[b.id]!.parent, a.id);
});

test('cloneSubtree gives fresh ids and a complete id map', () => {
  const { doc, artboard } = seed();
  const parent = makeNode({ type: 'frame', name: 'P' });
  const child = makeNode({ type: 'text', text: 'x', parent: parent.id });
  parent.children = [child.id];
  applyOp(doc, { t: 'insert', nodes: [parent, child], parent: artboard, index: 0 });

  const { nodes, idMap } = cloneSubtree(doc, parent.id);
  assert.equal(nodes.length, 2);
  assert.notEqual(idMap[parent.id], parent.id);
  assert.equal(nodes[0]!.children[0], idMap[child.id]);
  assert.equal(nodes[1]!.parent, idMap[parent.id]);
});

test('parseDeclarations handles nested parens and quotes', () => {
  const s = parseDeclarations(
    `background: linear-gradient(90deg, rgba(0,0,0,.5), #fff); font-family: "Helvetica Neue", sans-serif`,
  );
  assert.equal(s.background, 'linear-gradient(90deg, rgba(0,0,0,.5), #fff)');
  assert.equal(s['font-family'], '"Helvetica Neue", sans-serif');
});

test('parseStylesheet extracts rules and media queries', () => {
  const rules = parseStylesheet(`
    /* comment */
    .card { color: red; padding: 8px }
    .card:hover { color: blue }
    @media (max-width: 768px) { .card { padding: 4px } }
  `);
  assert.equal(rules.length, 3);
  assert.equal(rules[0]!.styles.color, 'red');
  assert.equal(rules[2]!.atRule, '@media (max-width: 768px)');
});

test('parseHtml builds a tree with resolved styles and variants', () => {
  const res = parseHtml(`
    <style>
      .card { display: flex; gap: 12px; background: #fff }
      .card:hover { background: #eee }
      @media (max-width: 768px) { .card { gap: 4px } }
    </style>
    <div class="card" style="padding: 16px">
      <h1>Hello</h1>
      <img src="a.png" alt="Logo" />
    </div>
  `);
  assert.equal(res.roots.length, 1);
  const root = res.nodes.find((n) => n.id === res.roots[0])!;
  assert.equal(root.type, 'frame');
  assert.equal(root.styles.display, 'flex');
  assert.equal(root.styles.gap, '12px');
  assert.equal(root.styles.padding, '16px', 'style attribute wins over stylesheet');
  assert.equal(root.children.length, 2);
  assert.ok(root.variants.find((v) => v.selector === ':hover'));
  assert.ok(root.variants.find((v) => v.selector.startsWith('@media')));

  const heading = res.nodes.find((n) => n.tag === 'h1')!;
  assert.equal(heading.type, 'text');
  assert.equal(heading.text, 'Hello');

  const img = res.nodes.find((n) => n.tag === 'img')!;
  assert.equal(img.type, 'image');
  assert.equal(img.attrs.src, 'a.png');
  assert.equal(img.name, 'Logo');
});

test('parseHtml strips scripts and reports it', () => {
  const res = parseHtml(`<div><script>alert(1)</script><p>ok</p></div>`);
  assert.ok(res.warnings.some((w) => w.includes('script')));
  assert.ok(!res.nodes.some((n) => n.tag === 'script'));
});

test('parseHtml wraps bare text runs in text nodes', () => {
  const res = parseHtml(`<div>loose text<span>inner</span></div>`);
  const texts = res.nodes.filter((n) => n.type === 'text');
  assert.equal(texts.length, 2);
  assert.ok(texts.some((t) => t.text === 'loose text'));
});

test('emitHtml round-trips a parsed tree', () => {
  const { doc, artboard } = seed();
  const res = parseHtml(`<div style="display:flex;gap:8px"><p style="color:red">Hi</p></div>`);
  applyOp(doc, { t: 'insert', nodes: res.nodes, parent: artboard, index: 0 });

  const { html } = emitHtml(doc, res.roots[0]!, { mode: 'inline' });
  assert.match(html, /display:flex/);
  assert.match(html, /<p[^>]*>Hi<\/p>/);

  const reparsed = parseHtml(html);
  const root = reparsed.nodes.find((n) => n.id === reparsed.roots[0])!;
  assert.equal(root.styles.gap, '8px');
});

test('emitStandalone includes token custom properties', () => {
  const { doc, artboard } = seed();
  const out = emitStandalone(doc, artboard);
  assert.match(out, /--color-brand: #3b82f6/);
  assert.match(out, /<!doctype html>/);
});

test('cssToTailwind maps exact utilities and falls back to arbitrary values', () => {
  const { classes, leftover } = cssToTailwind({
    display: 'flex',
    'flex-direction': 'column',
    'align-items': 'center',
    gap: '16px',
    width: '100%',
    'background-color': '#3b82f6',
    'backdrop-filter': 'blur(4px)',
  });
  assert.ok(classes.includes('flex'));
  assert.ok(classes.includes('flex-col'));
  assert.ok(classes.includes('items-center'));
  assert.ok(classes.includes('gap-[16px]'));
  assert.ok(classes.includes('w-full'));
  assert.ok(classes.includes('bg-[#3b82f6]'));
  assert.equal(leftover['backdrop-filter'], 'blur(4px)', 'unmapped properties survive in style');
});

test('emitJsx produces both formats', () => {
  const { doc, artboard } = seed();
  const text = makeNode({ type: 'text', tag: 'h1', text: 'Title', styles: { color: '#111', 'font-size': '32px' } });
  applyOp(doc, { t: 'insert', nodes: [text], parent: artboard, index: 0 });

  const tw = emitJsx(doc, artboard, { format: 'tailwind' });
  assert.match(tw, /className="/);
  assert.match(tw, /<h1[^>]*>Title<\/h1>/);

  const inline = emitJsx(doc, artboard, { format: 'inline', componentName: 'Screen' });
  assert.match(inline, /export function Screen\(\)/);
  assert.match(inline, /"fontSize": "32px"/);
});

test('treeSummary truncates and reports depth overflow', () => {
  const { doc, artboard } = seed();
  let parent = artboard;
  for (let i = 0; i < 10; i++) {
    const n = makeNode({ type: 'frame', name: `L${i}` });
    applyOp(doc, { t: 'insert', nodes: [n], parent, index: 0 });
    parent = n.id;
  }
  const s = treeSummary(doc, artboard, { depth: 3 });
  assert.match(s, /use get_children/);
  assert.ok(s.split('\n').length < 8);
});

test('basicInfo reports artboards with geometry', () => {
  const { doc, artboard } = seed();
  const info = basicInfo(doc);
  assert.equal(info.nodeCount, 1);
  assert.equal(info.artboards[0]!.width, 1440);
  assert.equal(info.artboards[0]!.id, artboard);
});

test('artboardOf and isAncestorOf walk the tree correctly', () => {
  const { doc, artboard } = seed();
  const a = makeNode({ type: 'frame' });
  const b = makeNode({ type: 'text', text: 'x' });
  applyOp(doc, { t: 'insert', nodes: [a], parent: artboard, index: 0 });
  applyOp(doc, { t: 'insert', nodes: [b], parent: a.id, index: 0 });
  assert.equal(artboardOf(doc, b.id), artboard);
  assert.ok(isAncestorOf(doc, a.id, b.id));
  assert.ok(!isAncestorOf(doc, b.id, a.id));
});

test('a variant can override a property the base also sets', () => {
  // Inline styles beat every stylesheet rule, so any property a variant
  // overrides has to leave the style attribute or the variant is dead.
  const { doc, artboard } = seed();
  const parsed = parseHtml(`
    <style>
      .box { display: flex; flex-direction: row; padding: 40px }
      @media (max-width: 768px) { .box { flex-direction: column; padding: 16px } }
      .box:hover { flex-direction: column }
    </style>
    <div class="box"><span>a</span></div>`);
  applyOp(doc, { t: 'insert', nodes: parsed.nodes, parent: artboard, index: 0 });

  const box = parsed.nodes.find((n) => n.styles.display === 'flex')!;
  const contested = contestedProperties(box);
  assert.ok(contested.has('flex-direction'), 'flex-direction is contested');
  assert.ok(contested.has('padding'));
  assert.ok(!contested.has('display'), 'display is only set on the base');

  const { html, css } = emitHtml(doc, artboard, { mode: 'inline' });
  // The box, not the artboard: only nodes with variants get a class.
  const boxTag = new RegExp(`<div[^>]*class="c-${box.id}"[^>]*>`).exec(html)?.[0] ?? '';
  const style = /style="([^"]*)"/.exec(boxTag)?.[1] ?? '';
  assert.ok(boxTag, 'the box should be emitted with a class');
  assert.match(style, /display:flex/, 'uncontested properties stay inline');
  assert.doesNotMatch(style, /flex-direction/, 'contested properties must not be inline');
  assert.doesNotMatch(style, /padding/);

  // Both the base and the override are in the stylesheet, base first.
  assert.match(css, /flex-direction: row/);
  assert.match(css, /@media \(max-width: 768px\)/);
  assert.ok(
    css.indexOf('flex-direction: row') < css.indexOf('flex-direction: column'),
    'the base rule must come before the override',
  );
});
