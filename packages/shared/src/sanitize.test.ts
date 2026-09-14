import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeMarkup } from './sanitize.ts';

test('strips script elements, including unclosed ones', () => {
  assert.equal(sanitizeMarkup('<g></g><script>alert(1)</script>'), '<g></g>');
  assert.equal(sanitizeMarkup('<circle/><script src="x.js">'), '<circle/>');
});

test('strips inline event handlers however they are quoted', () => {
  assert.equal(sanitizeMarkup('<svg onload="x()"><a onClick=y>'), '<svg><a>');
});

test('neutralises javascript: urls, including whitespace obfuscation', () => {
  assert.match(sanitizeMarkup('<a href="javascript:alert(1)">'), /#blocked:/);
  assert.match(sanitizeMarkup('<a xlink:href="java	script:alert(1)">'), /#blocked:/);
});

test('leaves ordinary vector markup untouched', () => {
  const svg = '<path d="M0 0h10v10H0z" fill="#fff"/><a href="https://example.com">x</a>';
  assert.equal(sanitizeMarkup(svg), svg);
});
