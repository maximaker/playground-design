import { test } from 'node:test';
import assert from 'node:assert/strict';
import { svgColors, replaceSvgColor, vectorMarkup } from './svg.ts';

const logo = '<svg width="41" height="16" fill="none"><path d="M0 0h4" fill="#F25A12"/><path d="M1 1" stroke="#363A48" style="fill:#f25a12"/><style>.a{fill:#5B6690}</style><circle fill="url(#g)"/></svg>';

test('lists each painted colour once, skipping none and gradients', () => {
  assert.deepEqual(svgColors(logo), ['#F25A12', '#363A48', '#5B6690']);
});

test('replaces a colour in attributes, inline styles and style blocks', () => {
  const out = replaceSvgColor(logo, '#f25a12', '#000000');
  assert.equal(svgColors(out).filter((c) => c.toLowerCase() === '#f25a12').length, 0);
  assert.match(out, /fill="#000000"/);
  assert.match(out, /style="fill:#000000"/);
});

test('a token moves into the style, since var() is not valid in an attribute', () => {
  const out = replaceSvgColor('<svg><path d="M0" fill="#F25A12"/><rect fill="#F25A12" style="opacity:.5"/></svg>', '#F25A12', 'var(--color-accent)');
  assert.match(out, /<path d="M0" style="fill:var\(--color-accent\)"\/>/);
  assert.match(out, /<rect style="opacity:.5;fill:var\(--color-accent\)"\/?>/);
  assert.deepEqual(svgColors(out), ['var(--color-accent)']);
});

test('vectorMarkup wraps the inner SVG in the layer attributes', () => {
  assert.equal(vectorMarkup({ viewBox: '0 0 10 10', 'aria-label': 'a "b"' }, '<g/>'), '<svg viewBox="0 0 10 10" aria-label="a &quot;b&quot;"><g/></svg>');
});
