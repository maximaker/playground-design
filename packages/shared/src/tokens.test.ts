import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyDocument } from './model.ts';
import {
  cssVarName, diffTokens, groupFor, mergeTokens, parseTokensFromCss,
  parseTokensFromTailwind, serializeTokens, tokenNameFromVar,
} from './tokens.ts';

test('reads custom properties from :root', () => {
  const { tokens, warnings } = parseTokensFromCss(`
    :root { --color-brand: #4f46e5; --space-md: 16px; --radius-sm: 6px }
  `);
  assert.equal(tokens.length, 3);
  assert.deepEqual(tokens.find((t) => t.name === 'color.brand')!.values, { default: '#4f46e5' });
  assert.equal(tokens.find((t) => t.name === 'space.md')!.group, 'space');
  assert.deepEqual(warnings, []);
});

test('reads themes from the selectors projects actually use', () => {
  const { tokens, themes } = parseTokensFromCss(`
    :root { --color-bg: #fff }
    :root[data-theme="dark"] { --color-bg: #000 }
    .midnight { --color-bg: #111 }
  `);
  assert.deepEqual(themes.sort(), ['dark', 'default', 'midnight']);
  assert.deepEqual(tokens[0]!.values, { default: '#fff', dark: '#000', midnight: '#111' });
});

test('a token defined only inside a theme still gets a default', () => {
  const { tokens, warnings } = parseTokensFromCss(`:root[data-theme="dark"] { --color-x: #000 }`);
  assert.equal(tokens[0]!.values.default, '#000');
  assert.match(warnings[0]!, /only defined for a theme/);
});

test('ignores rules that are not custom properties', () => {
  const { tokens, warnings } = parseTokensFromCss(`.card { color: red } :root { padding: 0 }`);
  assert.equal(tokens.length, 0);
  assert.match(warnings[0]!, /No custom properties/);
});

test('round-trips names that contain hyphens', () => {
  assert.equal(cssVarName('color.on-brand'), '--color-on-brand');
  // Without the declared list the split is ambiguous; with it, exact.
  assert.equal(tokenNameFromVar('--color-on-brand', ['color.on-brand']), 'color.on-brand');
  assert.equal(tokenNameFromVar('--color-brand-500', ['color.brand.500']), 'color.brand.500');
});

test('infers a group from the name, then from the value', () => {
  assert.equal(groupFor('color.brand', '#fff'), 'color');
  assert.equal(groupFor('space.md', '16px'), 'space');
  assert.equal(groupFor('brand.primary', '#4f46e5'), 'color', 'falls back to the value shape');
  assert.equal(groupFor('quick', '150ms'), 'duration');
});

test('reads a Tailwind theme object, including nested scales', () => {
  const { tokens } = parseTokensFromTailwind({
    colors: { brand: { 500: '#4f46e5', 600: '#4338ca' }, ink: '#111' },
    spacing: { md: '16px' },
    borderRadius: { DEFAULT: '6px', lg: '12px' },
    fontFamily: { sans: ['Inter', 'system-ui'] },
  });
  const names = tokens.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'color.brand.500', 'color.brand.600', 'color.ink',
    'font.family.sans', 'radius', 'radius.lg', 'space.md',
  ]);
  assert.equal(tokens.find((t) => t.name === 'font.family.sans')!.values.default, 'Inter',
    'an array value takes its first entry');
  assert.equal(tokens.find((t) => t.name === 'radius')!.values.default, '6px', 'DEFAULT has no suffix');
});

test('serializes to CSS with themes, emitting only real overrides', () => {
  const doc = createEmptyDocument('T');
  const css = serializeTokens(doc, 'css');
  assert.match(css, /:root \{/);
  assert.match(css, /--color-brand: #3b82f6;/);
  assert.match(css, /:root\[data-theme="dark"\]/);
  // radius.sm has no dark value, so it must not be repeated in the dark block.
  const dark = css.slice(css.indexOf('data-theme="dark"'));
  assert.doesNotMatch(dark, /--radius-sm/);
});

test('serializes to a Tailwind config that points at the variables', () => {
  const doc = createEmptyDocument('T');
  const config = serializeTokens(doc, 'tailwind');
  assert.match(config, /extend/);
  assert.match(config, /"brand": "var\(--color-brand\)"/);
  assert.match(config, /"colors"/);
  assert.match(config, /"borderRadius"/);
});

test('serializes to design tokens JSON', () => {
  const doc = createEmptyDocument('T');
  const json = JSON.parse(serializeTokens(doc, 'json'));
  assert.equal(json.color.brand.$type, 'color');
  assert.equal(json.color.brand.$value, '#3b82f6');
  assert.equal(json.color.brand.$extensions['playground.themes'].dark, '#60a5fa');
});

test('a CSS round trip preserves values', () => {
  const doc = createEmptyDocument('T');
  const css = serializeTokens(doc, 'css');
  const { tokens } = parseTokensFromCss(css, doc.tokens.map((t) => t.name));
  for (const original of doc.tokens) {
    const back = tokens.find((t) => t.name === original.name);
    assert.ok(back, `${original.name} survived`);
    assert.equal(back!.values.default, original.values.default, original.name);
  }
});

test('diff reports what drifted', () => {
  const current = [
    { name: 'color.brand', group: 'color' as const, values: { default: '#4f46e5' } },
    { name: 'color.gone', group: 'color' as const, values: { default: '#000' } },
    { name: 'space.md', group: 'space' as const, values: { default: '16px' } },
  ];
  const incoming = [
    { name: 'color.brand', group: 'color' as const, values: { default: '#6366f1' } },
    { name: 'space.md', group: 'space' as const, values: { default: '16px' } },
    { name: 'color.new', group: 'color' as const, values: { default: '#fff' } },
  ];
  const diff = diffTokens(current, incoming);
  assert.deepEqual(diff.added.map((t) => t.name), ['color.new']);
  assert.deepEqual(diff.removed.map((t) => t.name), ['color.gone']);
  assert.deepEqual(diff.changed, [{ name: 'color.brand', theme: 'default', from: '#4f46e5', to: '#6366f1' }]);
  assert.equal(diff.unchanged, 1);
});

test('merge keeps tokens the incoming set does not mention', () => {
  const current = [
    { name: 'color.brand', group: 'color' as const, values: { default: '#000', dark: '#fff' } },
    { name: 'color.keep', group: 'color' as const, values: { default: '#abc' } },
  ];
  const merged = mergeTokens(current, [{ name: 'color.brand', group: 'color', values: { default: '#111' } }]);
  assert.equal(merged.length, 2, 'a partial stylesheet must not delete the rest of the system');
  assert.equal(merged.find((t) => t.name === 'color.brand')!.values.default, '#111');
  assert.equal(merged.find((t) => t.name === 'color.brand')!.values.dark, '#fff', 'other themes survive');
});

test('merge can be told to remove what is missing', () => {
  const current = [
    { name: 'a', group: 'color' as const, values: { default: '#000' } },
    { name: 'b', group: 'color' as const, values: { default: '#fff' } },
  ];
  const merged = mergeTokens(current, [{ name: 'a', group: 'color', values: { default: '#111' } }], { removeMissing: true });
  assert.deepEqual(merged.map((t) => t.name), ['a']);
});
