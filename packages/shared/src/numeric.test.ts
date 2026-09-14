import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateInput, formatNumber, parseNumeric, stepMultiplier, stepValue } from './numeric.ts';

test('parses a number and its unit', () => {
  assert.deepEqual(parseNumeric('24px'), { number: 24, unit: 'px' });
  assert.deepEqual(parseNumeric('-1.5rem'), { number: -1.5, unit: 'rem' });
  assert.deepEqual(parseNumeric('50%'), { number: 50, unit: '%' });
  assert.deepEqual(parseNumeric('  12  '), { number: 12, unit: '' });
});

test('refuses values that only look numeric', () => {
  for (const v of ['calc(100% - 20px)', 'var(--gap)', 'auto', '1px solid red', '', '12px 4px']) {
    assert.equal(parseNumeric(v), null, v);
  }
});

test('stepping keeps the unit it found', () => {
  assert.equal(stepValue('2rem', 1), '3rem');
  assert.equal(stepValue('50%', -1), '49%');
  assert.equal(stepValue('24px', 1, { step: 8 }), '32px');
});

test('stepping a bare number adopts the field default unit', () => {
  assert.equal(stepValue('12', 1, { suffix: 'px' }), '13px');
  assert.equal(stepValue('400', 1, { step: 100, suffix: '' }), '500', 'font-weight has no unit');
});

test('stepping respects bounds', () => {
  assert.equal(stepValue('0px', -1, { min: 0 }), '0px');
  assert.equal(stepValue('1', 1, { max: 1, suffix: '' }), '1');
});

test('stepping a non-number reports that it cannot, rather than guessing', () => {
  assert.equal(stepValue('auto', 1), null);
  assert.equal(stepValue('calc(50% + 2px)', 1), null);
});

test('fractional steps do not leak floating-point noise', () => {
  assert.equal(stepValue('0.2px', 1, { step: 0.1 }), '0.3px');
  assert.equal(formatNumber(0.1 + 0.2), '0.3');
});

test('modifiers follow the convention every design tool shares', () => {
  assert.equal(stepMultiplier({}), 1);
  assert.equal(stepMultiplier({ shiftKey: true }), 10);
  assert.equal(stepMultiplier({ altKey: true }), 0.1);
  assert.equal(stepMultiplier({ shiftKey: true, altKey: true }), 10, 'shift wins; the pair is ambiguous');
});

test('relative arithmetic applies to the current value', () => {
  assert.equal(evaluateInput('+8', '24px'), '32px');
  assert.equal(evaluateInput('-4', '24px'), '20px');
  assert.equal(evaluateInput('*2', '24px'), '48px');
  assert.equal(evaluateInput('/2', '24px'), '12px');
  assert.equal(evaluateInput('+1', '2rem'), '3rem');
});

test('a self-contained expression is evaluated', () => {
  assert.equal(evaluateInput('24 + 8', '0px', 'px'), '32px');
  assert.equal(evaluateInput('100%/2', '0px'), '50%');
});

test('relative arithmetic against a non-number is left alone', () => {
  // Treating `auto` as zero would silently turn "+8" into 8px.
  assert.equal(evaluateInput('+8', 'auto'), '+8');
});

test('division by zero is refused rather than written as Infinity', () => {
  assert.equal(evaluateInput('/0', '24px'), '/0');
});

test('anything that is not arithmetic passes straight through', () => {
  for (const v of ['auto', 'calc(100% - 2px)', 'var(--gap)', '24px', 'fit-content']) {
    assert.equal(evaluateInput(v, '0px'), v);
  }
});
