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
