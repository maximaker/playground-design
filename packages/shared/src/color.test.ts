import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseColor, contrastRatio, requiredContrast, flatten } from './color.ts';

test('parses hex in every length', () => {
  assert.deepEqual(parseColor('#fff'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseColor('#000000'), { r: 0, g: 0, b: 0, a: 1 });
  assert.equal(parseColor('#ff000080')!.a, 128 / 255);
});

test('parses rgb, rgba and modern slash syntax', () => {
  assert.deepEqual(parseColor('rgb(255, 0, 0)'), { r: 255, g: 0, b: 0, a: 1 });
  assert.equal(parseColor('rgba(0, 0, 0, 0.5)')!.a, 0.5);
  assert.equal(parseColor('rgb(0 0 0 / 50%)')!.a, 0.5);
});

test('parses hsl', () => {
  const red = parseColor('hsl(0, 100%, 50%)')!;
  assert.equal(Math.round(red.r), 255);
  assert.equal(Math.round(red.g), 0);
});

test('resolves token references through the resolver', () => {
  const resolve = (name: string) => (name === '--color-brand' ? '#3b82f6' : undefined);
  assert.deepEqual(parseColor('var(--color-brand)', resolve), { r: 59, g: 130, b: 246, a: 1 });
  // Unknown token is unknown, not black — guessing would produce false failures.
  assert.equal(parseColor('var(--nope)', resolve), null);
  assert.deepEqual(parseColor('var(--nope, #ffffff)', resolve), { r: 255, g: 255, b: 255, a: 1 });
});

test('returns null for values that are not colours', () => {
  for (const v of ['', 'none', 'inherit', 'currentColor', 'url(a.png)', 'linear-gradient(red, blue)']) {
    assert.equal(parseColor(v), null, v);
  }
});

test('contrast matches the WCAG reference values', () => {
  const white = parseColor('#ffffff')!;
  const black = parseColor('#000000')!;
  assert.equal(Math.round(contrastRatio(black, white) * 100) / 100, 21);
  assert.equal(contrastRatio(white, white), 1);
  // #767676 on white is the canonical 4.5:1 boundary.
  assert.ok(Math.abs(contrastRatio(parseColor('#767676')!, white) - 4.54) < 0.05);
});

test('translucent foregrounds are composited before measuring', () => {
  const white = parseColor('#ffffff')!;
  const half = parseColor('rgba(0,0,0,0.5)')!;
  const solid = contrastRatio(parseColor('#000000')!, white);
  const faded = contrastRatio(half, white);
  assert.ok(faded < solid, 'a 50% black reads lighter than solid black');
  assert.deepEqual(flatten(half, white), { r: 127.5, g: 127.5, b: 127.5, a: 1 });
});

test('large text has a lower requirement', () => {
  assert.equal(requiredContrast(16, 400), 4.5);
  assert.equal(requiredContrast(24, 400), 3);
  assert.equal(requiredContrast(19, 700), 3, 'bold 18.66px counts as large');
  assert.equal(requiredContrast(19, 400), 4.5);
});
