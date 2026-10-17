import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHtml, emitStandalone } from './html.ts';
import { createEmptyDocument, makeNode } from './model.ts';
import { applyOp } from './ops.ts';

test('a div inside a p is reported, because the parser moves it out', () => {
  const result = parseHtml('<p style="display:flex">Name<div>avatar</div></p>');
  const byId = Object.fromEntries(result.nodes.map((n) => [n.id, n]));
  const div = result.nodes.find((n) => n.tag === 'div');

  // The parser has already relocated it: this is what the warning is about.
  assert.ok(div);
  assert.notEqual(byId[div.parent ?? '']?.tag, 'p');
  assert.match(result.warnings.join(' '), /<div> inside a <p>/);
});

test('ordinary paragraphs are not reported', () => {
  const result = parseHtml('<div><p>One</p><p>Two <strong>bold</strong></p></div>');
  assert.deepEqual(result.warnings, []);
});

test('a standalone export asks for the fonts the design uses', () => {
  const doc = createEmptyDocument('Fonts');
  const artboard = doc.pages[0]!.artboards[0]!;
  const heading = makeNode({
    type: 'text', name: 'Heading', tag: 'h1', text: 'Set in Fraunces',
    styles: { 'font-family': "'Fraunces', Georgia, serif" },
  });
  applyOp(doc, { t: 'insert', nodes: [heading], parent: artboard, index: 0 });

  const html = emitStandalone(doc, artboard);
  assert.match(html, /fonts\.googleapis\.com[^"]*Fraunces/);
  // Georgia is on the machine already; asking for it would be a wasted request.
  assert.doesNotMatch(html, /family=Georgia/);
});

test('a family held in a token is still a family', () => {
  const doc = createEmptyDocument('Tokens');
  doc.tokens.push({ name: 'font.display', group: 'font', values: { default: "'Fraunces', serif" } });
  const artboard = doc.pages[0]!.artboards[0]!;
  const heading = makeNode({
    type: 'text', name: 'Heading', tag: 'h1', text: 'Tokenised',
    styles: { 'font-family': 'var(--font-display)' },
  });
  applyOp(doc, { t: 'insert', nodes: [heading], parent: artboard, index: 0 });

  const html = emitStandalone(doc, artboard);
  // The bug this covers: `var(--font-display)` went into the URL verbatim,
  // which invalidated the request for every font in it. The declaration itself
  // should of course still reference the token — it is the URL that must not.
  const href = /href="(https:\/\/fonts\.googleapis[^"]*)"/.exec(html)?.[1] ?? '';
  assert.match(href, /Fraunces/);
  assert.doesNotMatch(href, /var\(/);
  assert.match(html, /font-family: var\(--font-display\)/);
});

test('parsed elements keep their authored class list as data-class', () => {
  const result = parseHtml('<style>.btn{padding:8px}</style><button class="btn  primary">Save</button>');
  const button = result.nodes.find((n) => n.tag === 'button')!;
  assert.equal(button.attrs['data-class'], 'btn primary');
  assert.equal(button.styles.padding, '8px');
});

test('parseHtml keeps the space between an inline element and the text after it', () => {
  const { nodes } = parseHtml('<span><strong>Ana</strong> Popescu</span>');
  const texts = nodes.filter((n) => n.type === 'text').map((n) => n.text);
  assert.deepEqual(texts, ['Ana', ' Popescu']);
  // In a flex container CSS drops edge spaces anyway, so nothing extra is kept.
  const flex = parseHtml('<div style="display:flex"><b>A</b> <b>B</b></div>');
  assert.equal(flex.nodes.filter((n) => n.type === 'text' && !n.text?.trim()).length, 0);
});

test('export keeps running text together: no space before a styled full stop', () => {
  const doc = createEmptyDocument('Run');
  const artboard = doc.pages[0]!.artboards[0]!;
  const parsed = parseHtml('<div><p>Build smarter<span style="color:orange">.</span> Then <b>ship</b>, fast.</p><p>Two</p></div>');
  applyOp(doc, { t: 'insert', nodes: parsed.nodes, parent: artboard, index: 0 });
  const html = emitStandalone(doc, artboard);
  // A newline between "smarter" and the span rendered as "smarter ." before.
  assert.match(html, />Build smarter<\/span><span[^>]*>\.<\/span><span[^>]*> Then <\/span><b[^>]*>ship<\/b><span[^>]*>, fast\.<\/span><\/p>/);
  // Block children stay pretty-printed.
  assert.match(html, /<\/p>\n\s+<p/);
});

test('style rules respect descendant, child and sibling combinators', () => {
  const html = `<style>
    .nav span { color: red; }
    .card > b { color: blue; }
    .a + .b { color: green; }
    span.hot { font-weight: 700; }
  </style>
  <div><span class="t">time</span><div class="nav"><span>tab</span></div>
  <div class="card"><b>direct</b><i><b>nested</b></i></div>
  <p class="a">a</p><p class="b">b</p><p class="b">c</p><span class="hot">h</span></div>`;
  const { nodes } = parseHtml(html);
  const by = (text: string) => nodes.find((n) => n.text === text)!;
  assert.equal(by('time').styles.color, undefined, 'span outside .nav untouched');
  assert.equal(by('tab').styles.color, 'red');
  assert.equal(by('direct').styles.color, 'blue');
  assert.equal(by('nested').styles.color, undefined, 'child combinator is not descendant');
  assert.equal(by('b').styles.color, 'green');
  assert.equal(by('c').styles.color, undefined, '+ is the immediate sibling only');
  assert.equal(by('h').styles['font-weight'], '700');
});
