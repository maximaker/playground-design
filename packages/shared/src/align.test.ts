import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  alignmentForSelection, alignmentStyles, contentAlignment, layoutMode,
} from './align.ts';

const row = { display: 'flex' };
const column = { display: 'flex', 'flex-direction': 'column' };
const rowReverse = { display: 'flex', 'flex-direction': 'row-reverse' };

test('identifies how a container lays out', () => {
  assert.equal(layoutMode(row), 'row');
  assert.equal(layoutMode(column), 'column');
  assert.equal(layoutMode({ display: 'inline-flex' }), 'row');
  assert.equal(layoutMode({ display: 'grid' }), 'grid');
  assert.equal(layoutMode({ display: 'block' }), 'none');
});

test('horizontal alignment writes justify-content in a row', () => {
  assert.deepEqual(alignmentStyles(row, { horizontal: 'center' }), {
    'justify-content': 'center', 'align-items': 'stretch',
  });
});

test('the same intent writes align-items in a column', () => {
  // This swap is the flexbox papercut the pad exists to hide.
  assert.deepEqual(alignmentStyles(column, { horizontal: 'center' }), {
    'justify-content': 'flex-start', 'align-items': 'center',
  });
});

test('a reversed row flips visual start and end', () => {
  assert.equal(alignmentStyles(rowReverse, { horizontal: 'start' })['justify-content'], 'flex-end');
  assert.equal(alignmentStyles(rowReverse, { horizontal: 'end' })['justify-content'], 'flex-start');
  assert.equal(alignmentStyles(rowReverse, { horizontal: 'center' })['justify-content'], 'center');
});

test('stretch on the main axis degrades to the near edge', () => {
  // justify-content has no stretch; writing one would be ignored silently.
  assert.equal(alignmentStyles(row, { horizontal: 'stretch' })['justify-content'], 'flex-start');
  assert.equal(alignmentStyles(row, { vertical: 'stretch' })['align-items'], 'stretch');
});

test('grid alignment is axis-absolute', () => {
  assert.deepEqual(alignmentStyles({ display: 'grid' }, { horizontal: 'end', vertical: 'center' }), {
    'justify-items': 'flex-end', 'align-items': 'center',
  });
});

test('a block container has no alignment of its own', () => {
  assert.deepEqual(alignmentStyles({ display: 'block' }, { horizontal: 'center' }), {});
});

test('setting one axis leaves the other where it was', () => {
  const styles = { ...row, 'justify-content': 'center', 'align-items': 'flex-end' };
  assert.deepEqual(alignmentStyles(styles, { vertical: 'start' }), {
    'justify-content': 'center', 'align-items': 'flex-start',
  });
});

test('alignment round-trips through CSS', () => {
  for (const base of [row, column, rowReverse, { display: 'grid' }]) {
    for (const horizontal of ['start', 'center', 'end'] as const) {
      for (const vertical of ['start', 'center', 'end'] as const) {
        const styles = { ...base, ...alignmentStyles(base, { horizontal, vertical }) };
        assert.deepEqual(contentAlignment(styles), { horizontal, vertical },
          `${JSON.stringify(base)} ${horizontal}/${vertical}`);
      }
    }
  }
});

test('a distribution keyword is not read back as a position', () => {
  const styles = { ...row, 'justify-content': 'space-between' };
  assert.equal(contentAlignment(styles).horizontal, 'stretch',
    'lighting up a corner would claim the content sits somewhere it does not');
});

test('aligning a selection becomes a change on their container', () => {
  assert.deepEqual(alignmentForSelection(row, 'left'), { horizontal: 'start' });
  assert.deepEqual(alignmentForSelection(column, 'center-y'), { vertical: 'center' });
  assert.equal(alignmentForSelection({ display: 'block' }, 'left'), null,
    'a block parent cannot align its children, and should say so');
});
