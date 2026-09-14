import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxOf, computeSnap, snapResize } from './snap.ts';

test('snaps to a left edge and reports a guide', () => {
  const moving = boxOf('a', 103, 50, 100, 100);
  const other = boxOf('b', 100, 300, 100, 100);
  const res = computeSnap(moving, [other], 8);
  assert.equal(res.dx, -3);
  assert.equal(res.dy, 0);
  assert.ok(res.guides.some((g) => g.axis === 'x' && g.position === 100 && g.kind === 'edge'));
});

test('snaps centers and marks them as center guides', () => {
  const moving = boxOf('a', 148, 400, 100, 100);   // centerX 198
  const other = boxOf('b', 150, 0, 100, 100);      // centerX 200
  const res = computeSnap(moving, [other], 8);
  assert.equal(res.dx, 2);
  assert.ok(res.guides.some((g) => g.kind === 'center'));
});

test('does not match an edge against a center', () => {
  // moving.left = 200 sits exactly on other's centerX, which is not alignment.
  const moving = boxOf('a', 200, 400, 100, 100);
  const other = boxOf('b', 150, 0, 100, 100);      // centerX 200, edges 150/250
  const res = computeSnap(moving, [other], 4);
  assert.equal(res.dx, 0, 'an edge landing on a center must not snap');
});

test('ignores candidates outside the threshold', () => {
  const res = computeSnap(boxOf('a', 500, 500, 100, 100), [boxOf('b', 0, 0, 100, 100)], 8);
  assert.deepEqual(res, { dx: 0, dy: 0, guides: [] });
});

test('never snaps a box to itself', () => {
  const moving = boxOf('a', 100, 100, 50, 50);
  const res = computeSnap(moving, [moving], 8);
  assert.equal(res.dx, 0);
  assert.equal(res.dy, 0);
});

test('prefers the nearest of several competing snaps', () => {
  const moving = boxOf('a', 104, 0, 100, 100);
  const near = boxOf('b', 102, 200, 100, 100);
  const far = boxOf('c', 98, 400, 100, 100);
  const res = computeSnap(moving, [near, far], 10);
  assert.equal(res.dx, -2, 'should take the 2px snap, not the 6px one');
});

test('keeps every guide that agrees with the chosen offset', () => {
  const moving = boxOf('a', 103, 0, 100, 100);
  const one = boxOf('b', 100, 200, 100, 100);
  const two = boxOf('c', 100, 400, 100, 100);
  const res = computeSnap(moving, [one, two], 8);
  assert.equal(res.dx, -3);
  const positions = new Set(res.guides.filter((g) => g.axis === 'x' && g.kind === 'edge').map((g) => g.position));
  // The boxes are the same width, so this offset aligns both left edges (100)
  // and right edges (200) — both lines should be drawn.
  assert.deepEqual([...positions].sort((a, b) => a - b), [100, 200]);
});

test('snaps to equal spacing in an existing run', () => {
  // Three boxes at x=0, 120, 240 -> a run with a common gap of 20.
  const a = boxOf('a', 0, 0, 100, 100);
  const b = boxOf('b', 120, 0, 100, 100);
  const c = boxOf('c', 240, 0, 100, 100);
  const moving = boxOf('m', 357, 0, 100, 100); // wants to land at 360
  const res = computeSnap(moving, [a, b, c], 8);
  assert.equal(res.dx, 3);
  const spacing = res.guides.find((g) => g.kind === 'spacing');
  assert.ok(spacing, 'should report a spacing guide');
  assert.equal(spacing!.label, '20');
});

test('equal spacing needs a run, not a single neighbour', () => {
  const a = boxOf('a', 0, 0, 100, 100);
  const moving = boxOf('m', 157, 0, 100, 100);
  const res = computeSnap(moving, [a], 8);
  assert.ok(!res.guides.some((g) => g.kind === 'spacing'));
});

test('spacing only considers boxes overlapping on the cross axis', () => {
  // Same x positions, but far away vertically: not the same row.
  const a = boxOf('a', 0, 900, 100, 100);
  const b = boxOf('b', 120, 900, 100, 100);
  const c = boxOf('c', 240, 900, 100, 100);
  const moving = boxOf('m', 357, 0, 100, 100);
  const res = computeSnap(moving, [a, b, c], 8);
  assert.ok(!res.guides.some((g) => g.kind === 'spacing'));
});

test('a container box participates in snapping', () => {
  const container = boxOf('parent', 0, 0, 1000, 800);
  const moving = boxOf('a', 4, 300, 100, 100);
  const res = computeSnap(moving, [], 8, { container });
  assert.equal(res.dx, -4, 'should snap to the container edge');
});

test('resize snapping only moves the dragged edges', () => {
  const moving = boxOf('a', 0, 0, 197, 100);
  const other = boxOf('b', 200, 300, 100, 100);
  const res = snapResize(moving, [other], 'e', 8);
  assert.equal(res.dx, 3, 'the east edge snaps to the neighbour’s left edge');
  assert.equal(res.dy, 0, 'no vertical handle was dragged, so no vertical snap');
});

test('resize snapping handles the west and north handles', () => {
  const moving = boxOf('a', 103, 204, 100, 100);
  const other = boxOf('b', 100, 200, 500, 500);
  const west = snapResize(moving, [other], 'nw', 8);
  assert.equal(west.dx, -3);
  assert.equal(west.dy, -4);
});
