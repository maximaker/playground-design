import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGradient, serializeGradient, isGradient } from './gradient.ts';

test('parses a linear gradient with explicit stops', () => {
  const g = parseGradient('linear-gradient(90deg, #fff 0%, #000 100%)')!;
  assert.equal(g.type, 'linear');
  assert.equal(g.angle, 90);
  assert.deepEqual(g.stops, [{ color: '#fff', position: 0 }, { color: '#000', position: 100 }]);
});

test('distributes stops that declare no position', () => {
  const g = parseGradient('linear-gradient(#a, #b, #c)')!;
  assert.deepEqual(g.stops.map((s) => s.position), [0, 50, 100]);
  assert.equal(g.angle, 180, 'a gradient with no angle defaults to top-to-bottom');
});

test('converts keyword directions to degrees', () => {
  assert.equal(parseGradient('linear-gradient(to right, #a, #b)')!.angle, 90);
  assert.equal(parseGradient('linear-gradient(to top left, #a, #b)')!.angle, 315);
});

test('handles turn, rad and grad units', () => {
  assert.equal(parseGradient('linear-gradient(0.5turn, #a, #b)')!.angle, 180);
  assert.equal(Math.round(parseGradient('linear-gradient(3.14159rad, #a, #b)')!.angle), 180);
});

test('parses colours containing commas and spaces', () => {
  const g = parseGradient('linear-gradient(90deg, rgba(0, 0, 0, 0.5) 0%, hsl(200 50% 50%) 100%)')!;
  assert.equal(g.stops[0]!.color, 'rgba(0, 0, 0, 0.5)');
  assert.equal(g.stops[1]!.color, 'hsl(200 50% 50%)');
});

test('parses token references as stop colours', () => {
  const g = parseGradient('linear-gradient(45deg, var(--color-brand) 0%, var(--color-fg) 100%)')!;
  assert.equal(g.stops[0]!.color, 'var(--color-brand)');
});

test('parses radial and conic gradients', () => {
  const radial = parseGradient('radial-gradient(circle at center, #a 0%, #b 100%)')!;
  assert.equal(radial.type, 'radial');
  assert.equal(radial.shape, 'circle at center');

  const conic = parseGradient('conic-gradient(from 45deg, #a 0%, #b 100%)')!;
  assert.equal(conic.type, 'conic');
  assert.equal(conic.angle, 45);
});

test('recognises repeating gradients', () => {
  const g = parseGradient('repeating-linear-gradient(45deg, #a 0%, #b 10%)')!;
  assert.equal(g.repeating, true);
  assert.match(serializeGradient(g), /^repeating-linear-gradient/);
});

test('rejects things that are not gradients', () => {
  assert.equal(parseGradient('url(a.png)'), null);
  assert.equal(parseGradient('#ff0000'), null);
  assert.equal(parseGradient('linear-gradient(#onlyonestop)'), null, 'a gradient needs at least two stops');
  assert.equal(isGradient('none'), false);
});

test('round-trips through serialize and parse', () => {
  const source = 'linear-gradient(135deg, #6366f1 0%, #ec4899 50%, #f59e0b 100%)';
  const parsed = parseGradient(source)!;
  const out = serializeGradient(parsed);
  assert.equal(out, source);
  assert.deepEqual(parseGradient(out), parsed);
});

test('serialization sorts stops by position', () => {
  const out = serializeGradient({
    type: 'linear', angle: 0,
    stops: [{ color: '#b', position: 100 }, { color: '#a', position: 0 }],
  });
  assert.equal(out, 'linear-gradient(0deg, #a 0%, #b 100%)');
});
