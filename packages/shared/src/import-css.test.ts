/**
 * How a site's stylesheet reaches the document: what is resolved onto nodes,
 * what is kept as real CSS, and what is reported as dropped.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyDocument, makeNode, type CanvasNode } from './model.ts';
import { applyOp } from './ops.ts';
import { PRESERVED_CSS_ATTR, classifySelector, emitHtml, parseHtml, rewriteClassSelectors, nthMatches } from './html.ts';
import { expandNode } from './components.ts';
import { parseStylesheet } from './css.ts';

const byClass = (nodes: CanvasNode[], cls: string) => nodes.filter((n) => n.attrs['data-class'] === cls);

test('pseudo-elements and states are never folded into the element', () => {
  const r = parseHtml('<style>.slab{padding:4px}.slab::after{position:absolute;inset:0}.slab:before{content:"x";top:-220px}'
    + '.slab:hover{color:red}.slab:hover .t{color:blue}.slab:focus-within{outline:1px solid}</style>'
    + '<div class="slab"><span class="t">a</span></div>');
  const slab = byClass(r.nodes, 'slab')[0]!;
  assert.deepEqual(slab.styles, { padding: '4px', display: 'block' });
  assert.deepEqual(slab.variants, [{ selector: ':hover', styles: { color: 'red' } }]);
  assert.equal(byClass(r.nodes, 't')[0]!.styles.color, undefined);
  const css = slab.attrs[PRESERVED_CSS_ATTR]!;
  assert.match(css, /\[data-class~="slab"\]::after \{\n {2}position: absolute;\n {2}inset: 0;/);
  assert.match(css, /\[data-class~="slab"\]:before/);
  assert.match(css, /\[data-class~="slab"\]:hover \[data-class~="t"\] \{\n {2}color: blue !important;/);
  assert.match(css, /:focus-within \{\n {2}outline: 1px solid !important;/);
  assert.equal(r.css, css);
});

test('selector classification', () => {
  assert.deepEqual(classifySelector('.a'), { kind: 'resolve' });
  assert.deepEqual(classifySelector('.a:first-child'), { kind: 'resolve' });
  assert.deepEqual(classifySelector('.a:hover'), { kind: 'variant', key: ':hover' });
  assert.deepEqual(classifySelector('.a:hover .b'), { kind: 'preserve', state: true });
  assert.deepEqual(classifySelector('.a::after'), { kind: 'preserve', state: false });
  assert.deepEqual(classifySelector('.a:hover::after'), { kind: 'preserve', state: false });
  assert.deepEqual(classifySelector(':root'), { kind: 'preserve', state: false });
  assert.deepEqual(classifySelector('.a:has(img)'), { kind: 'preserve', state: false });
  assert.equal(rewriteClassSelectors('.a > .md\\:flex[href$=".pdf"]'), '[data-class~="a"] > [data-class~="md:flex"][href$=".pdf"]');
  assert.ok(nthMatches('2n+1', 3) && !nthMatches('2n+1', 2) && nthMatches('even', 4) && nthMatches('3', 3) && nthMatches('-n+2', 1) && !nthMatches('-n+2', 3));
});

test('structural pseudo-classes and attribute selectors resolve per element', () => {
  const r = parseHtml('<style>li{color:black}li:first-child{color:red}li:nth-child(2n){color:blue}li:not(:first-child){margin:1px}'
    + 'input[type="checkbox"]{width:12px}</style><ul><li>a</li><li>b</li><li>c</li></ul><input type="text"><input type="checkbox">');
  const lis = r.nodes.filter((n) => n.tag === 'li');
  assert.deepEqual(lis.map((n) => n.styles.color), ['red', 'blue', 'black']);
  assert.deepEqual(lis.map((n) => n.styles.margin), [undefined, '1px', '1px']);
  const inputs = r.nodes.filter((n) => n.tag === 'input');
  assert.deepEqual(inputs.map((n) => n.styles.width), [undefined, '12px']);
});

test('declarations land in cascade order, so a later shorthand is emitted after earlier longhands', () => {
  const r = parseHtml('<style>.x{background:#111}.x{background-image:radial-gradient(circle,#EE6A1E 0,#EE6A1E 1.5px,transparent 2px);background-size:36px 32px}.x.y{background:#222}</style><div class="x y">a</div>');
  const x = byClass(r.nodes, 'x y')[0]!;
  assert.deepEqual(Object.keys(x.styles), ['background-image', 'background-size', 'background', 'display']);
  const r2 = parseHtml('<style>.d{background:#111;background-image:radial-gradient(circle,#EE6A1E 0,#EE6A1E 1.5px,transparent 2px),linear-gradient(red,blue);background-size:36px 32px,100% 100%;background-repeat:repeat,no-repeat}</style><div class="d">a</div>');
  const d = byClass(r2.nodes, 'd')[0]!;
  assert.equal(d.styles['background-image'], 'radial-gradient(circle,#EE6A1E 0,#EE6A1E 1.5px,transparent 2px),linear-gradient(red,blue)');
  assert.equal(d.styles['background-size'], '36px 32px,100% 100%');
  assert.equal(d.styles['background-repeat'], 'repeat,no-repeat');
});

test('grid placement survives: span, grid-row, grid-area, place-items, repeat()', () => {
  const r = parseHtml('<style>.g{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));grid-template-areas:"a b";place-items:center}'
    + '.c{grid-column:span 6;grid-row:1 / span 2;grid-area:a;place-self:end}</style><div class="g"><div class="c">x</div></div>');
  assert.equal(byClass(r.nodes, 'g')[0]!.styles['grid-template-columns'], 'repeat(12,minmax(0,1fr))');
  assert.equal(byClass(r.nodes, 'g')[0]!.styles['place-items'], 'center');
  const c = byClass(r.nodes, 'c')[0]!.styles;
  assert.deepEqual([c['grid-column'], c['grid-row'], c['grid-area'], c['place-self']], ['span 6', '1 / span 2', 'a', 'end']);
});

test('<pre> children are HTML and whitespace is kept', () => {
  const r = parseHtml('<pre>\n<b>role:</b> critic\n  indented &lt;tag&gt;</pre>');
  const pre = r.nodes.find((n) => n.tag === 'pre')!;
  const kids = pre.children.map((id) => r.nodes.find((n) => n.id === id)!);
  assert.equal(kids[0]!.tag, 'b');
  assert.equal(kids[0]!.text, 'role:');
  assert.equal(kids[1]!.text, ' critic\n  indented <tag>');

  const doc = createEmptyDocument('pre');
  const ab = doc.pages[0]!.artboards[0]!;
  applyOp(doc, { t: 'insert', nodes: r.nodes, parent: ab, index: 0 });
  const { html } = emitHtml(doc, pre.id, { mode: 'stylesheet' });
  assert.match(html, /<pre[^>]*><b[^>]*>role:<\/b><span[^>]*> critic\n {2}indented &lt;tag&gt;<\/span><\/pre>/);
});

test('<use href="#id"> is resolved against <symbol>s in the same fragment', () => {
  const r = parseHtml('<svg style="display:none"><symbol id="star" viewBox="0 0 10 10"><path d="M0 0h10v10z"/></symbol></svg>'
    + '<svg width="20" height="20"><use href="#star" fill="red"/></svg>');
  const icon = r.nodes.filter((n) => n.type === 'vector')[1]!;
  assert.match(icon.text!, /<svg viewBox="0 0 10 10" fill="red" width="100%" height="100%"><path d="M0 0h10v10z"/);
  assert.doesNotMatch(icon.text!, /<use/);
});

test('verbatim at-rules are kept, @import does not swallow the next rule, deep nesting is reported', () => {
  const extras = { raw: [] as string[], dropped: [] as string[] };
  const rules = parseStylesheet('@import url(https://fonts.example/x.css);.a{color:red}@keyframes spin{from{opacity:0}to{opacity:1}}'
    + '@media (min-width:1px){@supports (display:grid){.b{color:blue}}}@font-face{font-family:X;src:url(x.woff2)}', extras);
  assert.deepEqual(rules.map((r) => r.selector), ['.a']);
  assert.equal(extras.raw.length, 3);
  assert.match(extras.raw[0]!, /^@import url/);
  assert.match(extras.raw[1]!, /^@keyframes spin \{from\{opacity:0\}to\{opacity:1\}\}$/);
  assert.deepEqual(extras.dropped, ['@supports (display:grid) inside @media (min-width:1px)']);

  const r = parseHtml('<style>@media (min-width:1px){@supports (display:grid){.b{color:blue}}}@keyframes spin{to{opacity:1}}</style><div class="b">x</div>');
  assert.ok(r.warnings.some((w) => w.includes('@supports (display:grid) inside @media')), r.warnings.join('\n'));
  assert.match(r.css!, /@keyframes spin/);
});

test(':root custom properties are kept as variables, never copied onto every element', () => {
  const r = parseHtml('<style>:root{--ink:#111;color-scheme:light}.a{color:var(--ink, #000)}</style><div class="a"><p>x</p></div>');
  for (const n of r.nodes) assert.equal(n.styles['--ink'], undefined);
  assert.equal(byClass(r.nodes, 'a')[0]!.styles.color, 'var(--ink, #000)');
  assert.match(r.css!, /:root \{\n {2}--ink: #111;\n {2}color-scheme: light;\n\}/);
  const extracted = parseHtml('<style>:root{--ink:#111;color-scheme:light}</style><div>x</div>', { extractRootVars: true });
  assert.deepEqual(extracted.rootVars, { '--ink': '#111' });
  assert.match(extracted.css!, /:root \{\n {2}color-scheme: light;\n\}/);
});

test('@media rules stay media variants; a state inside one is kept as CSS', () => {
  const r = parseHtml('<style>.card{width:300px}@media (max-width:600px){.card{width:100%}.card:hover{color:red}}</style><div class="card">x</div>');
  const card = byClass(r.nodes, 'card')[0]!;
  assert.equal(card.styles.width, '300px');
  assert.deepEqual(card.variants, [{ selector: '@media (max-width:600px)', styles: { width: '100%' } }]);
  assert.match(r.css!, /@media \(max-width:600px\) \{\n\[data-class~="card"\]:hover \{\n {2}color: red !important;/);
});

/** A component whose root carries a class and holds a default slot. */
function seedStack() {
  const doc = createEmptyDocument('Nested');
  const artboard = doc.pages[0]!.artboards[0]!;
  const label = makeNode({ type: 'text', tag: 'span', name: 'Label', text: 'Stack', attrs: { 'data-class': 'label' } });
  const slot = makeNode({ type: 'frame', name: 'Slot', attrs: { 'data-slot': 'default' }, styles: { display: 'contents' } });
  const root = makeNode({ type: 'frame', name: 'Stack', attrs: { 'data-class': 'stack' }, styles: { display: 'flex' } });
  root.children = [label.id, slot.id];
  label.parent = root.id;
  slot.parent = root.id;
  for (const n of [root, label, slot]) doc.nodes[n.id] = n;
  applyOp(doc, { t: 'component', action: 'add', component: { id: 'cmp_stack', name: 'Stack', root: root.id } });
  return { doc, artboard };
}

test('an instance in another instance\'s slot renders, even of the same component', () => {
  const { doc, artboard } = seedStack();
  const r = parseHtml('<Stack><Stack><b>deep</b></Stack></Stack>', { components: doc.components, defNodes: doc.nodes });
  applyOp(doc, { t: 'insert', nodes: r.nodes, parent: artboard, index: 0 });
  const outer = doc.nodes[r.roots[0]!]!;
  const expanded = expandNode(doc, outer)!;
  const texts: string[] = [];
  const walk = (e: typeof expanded) => { if (e.node.text) texts.push(e.node.text); e.children.forEach(walk); };
  walk(expanded);
  assert.deepEqual(texts, ['Stack', 'Stack', 'deep']);
  assert.equal((emitHtml(doc, artboard).html.match(/data-class="stack"/g) ?? []).length, 2);
});

test('rules with no match in the written markup are kept, and reach inside component instances', () => {
  const { doc, artboard } = seedStack();
  const r = parseHtml('<style>.label{color:red}</style><Stack></Stack>', { components: doc.components, defNodes: doc.nodes });
  assert.equal(r.styleRules.find((s) => s.selector === '.label')?.matched, 0);
  applyOp(doc, { t: 'insert', nodes: r.nodes, parent: artboard, index: 0 });
  const { html, css } = emitHtml(doc, artboard, { mode: 'stylesheet' });
  assert.match(css, /\[data-class~="label"\] \{\n {2}color: red;\n\}/);
  assert.match(html, /<span data-class="label"/);
  assert.doesNotMatch(html, /data-pg-css/);
});
