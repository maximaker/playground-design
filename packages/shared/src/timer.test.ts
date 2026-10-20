import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IDLE, formatClock, isUrgent, makeTimerNode, pauseTimer, readTimer, remainingMs, resetTimer, startTimer,
  tickTimer, timerAttrs, timerSpecFromTag, timerSvg, toggleTimer, durationFrom,
  revealStage, bigTimerTransform, TIMER_REVEAL_ATTR,
} from './timer.ts';
import { emitHtml, parseHtml } from './html.ts';
import { createEmptyDocument } from './model.ts';

test('formatClock rounds up and pads', () => {
  assert.equal(formatClock(180_000), '3:00');
  assert.equal(formatClock(179_001), '3:00');
  assert.equal(formatClock(179_000), '2:59');
  assert.equal(formatClock(5_000), '0:05');
  assert.equal(formatClock(0), '0:00');
  assert.equal(formatClock(-10), '0:00');
  assert.equal(formatClock(600_000), '10:00');
});

test('start, pause, resume and finish keep the right remaining time', () => {
  const d = 60_000;
  let s = startTimer(IDLE, 1000);
  assert.equal(remainingMs(s, d, 11_000), 50_000);
  s = pauseTimer(s, 11_000);
  assert.equal(s.status, 'paused');
  // Time passing while paused does not count.
  assert.equal(remainingMs(s, d, 999_999), 50_000);
  s = startTimer(s, 20_000);
  assert.equal(remainingMs(s, d, 30_000), 40_000);
  assert.equal(tickTimer(s, d, 69_999).status, 'running');
  const done = tickTimer(s, d, 70_000);
  assert.equal(done.status, 'done');
  assert.equal(remainingMs(done, d, 80_000), 0);
});

test('toggle: start, pause, resume; on done it starts over; reset is idle', () => {
  let s = toggleTimer(IDLE, 0);
  assert.equal(s.status, 'running');
  s = toggleTimer(s, 5000);
  assert.equal(s.status, 'paused');
  s = toggleTimer(s, 9000);
  assert.equal(s.status, 'running');
  assert.equal(remainingMs(s, 10_000, 9000), 5000);
  const done = tickTimer(s, 10_000, 20_000);
  const again = toggleTimer(done, 30_000);
  assert.equal(again.status, 'running');
  assert.equal(remainingMs(again, 10_000, 30_000), 10_000);
  assert.deepEqual(resetTimer(), IDLE);
});

test('urgent in the last 30 seconds, only once started', () => {
  const d = 120_000;
  assert.equal(isUrgent(IDLE, d, 0), false);
  const s = startTimer(IDLE, 0);
  assert.equal(isUrgent(s, d, 89_000), false);
  assert.equal(isUrgent(s, d, 90_000), true);
  // A 20 s timer is urgent as soon as it runs, but not before.
  assert.equal(isUrgent(IDLE, 20_000, 0), false);
  assert.equal(isUrgent(startTimer(IDLE, 0), 20_000, 0), true);
});

test('attributes round-trip and clamp', () => {
  const spec = readTimer(timerAttrs({ seconds: 95, start: 'click', variant: 'bar', end: 'pulse', chime: true, label: 'Break' }));
  assert.deepEqual(spec, { seconds: 95, start: 'click', variant: 'bar', end: 'pulse', chime: true, label: 'Break', reveal: 'none' });
  assert.equal(readTimer({ 'data-timer': '999999' }).seconds, 5999);
  assert.equal(readTimer({ 'data-timer': 'x' }).seconds, 1);
  assert.equal(readTimer({ 'data-timer': '60', 'data-timer-style': 'nope' }).variant, 'ring');
  assert.equal(durationFrom(3, 30), 210);
});

test('<timer> tag attributes, with warnings for bad values', () => {
  const { spec, warnings } = timerSpecFromTag({ minutes: '3', seconds: '0', autostart: 'slide', label: 'Discuss' });
  assert.equal(spec.seconds, 180);
  assert.equal(spec.start, 'slide');
  assert.equal(spec.label, 'Discuss');
  assert.equal(warnings.length, 0);
  const bad = timerSpecFromTag({ variant: 'donut' });
  assert.equal(bad.spec.variant, 'ring');
  assert.ok(bad.warnings.length >= 2);
  assert.equal(timerSpecFromTag({ minutes: '1', autostart: 'click', chime: '' }).spec.chime, true);
});

test('the face is an SVG in currentColor; urgent and done use the now accent', () => {
  const spec = readTimer(timerAttrs({ seconds: 180, label: '<b>' }));
  const still = timerSvg(spec);
  assert.match(still, /^<svg/);
  assert.match(still, /3:00/);
  assert.match(still, /currentColor/);
  assert.doesNotMatch(still, /<b>/);
  assert.doesNotMatch(still, /e2531e/);
  assert.match(timerSvg(spec, { remainingMs: 10_000, fraction: 0.05, done: false, urgent: true }), /e2531e/);
  assert.match(timerSvg(spec, { remainingMs: 0, fraction: 0, done: true, urgent: true }), /Time’s up/);
  const pulse = readTimer(timerAttrs({ seconds: 5, end: 'pulse' }));
  assert.match(timerSvg(pulse, { remainingMs: 0, fraction: 0, done: true, urgent: true }), /pg-timer-pulse/);
  assert.doesNotMatch(timerSvg(pulse, { remainingMs: 0, fraction: 0, done: true, urgent: true, reducedMotion: true }), /pg-timer-pulse/);
  for (const variant of ['pill', 'bar'] as const) assert.match(timerSvg(readTimer(timerAttrs({ variant }))), /3:00/);
});

test('export emits the static face; parsing <timer> and the export both make a timer node', () => {
  const doc = createEmptyDocument('t');
  const parsed = parseHtml('<timer minutes="2" seconds="30" autostart="click" variant="pill" label="Go"></timer>');
  assert.equal(parsed.nodes.length, 1);
  const node = parsed.nodes[0]!;
  assert.equal(node.attrs['data-timer'], '150');
  assert.equal(node.attrs['data-timer-start'], 'click');
  assert.equal(node.attrs['data-timer-style'], 'pill');
  assert.ok(node.styles.width && node.styles.height);
  doc.nodes[node.id] = node;
  const { html } = emitHtml(doc, node.id);
  assert.match(html, /data-timer="150"/);
  assert.match(html, /<svg[^>]*role="timer"/);
  assert.match(html, /2:30/);
  // Re-importing the export gives one timer node, not the SVG's parts.
  const back = parseHtml(html);
  assert.equal(back.nodes.length, 1);
  assert.equal(back.nodes[0]!.attrs['data-timer'], '150');

  const placed = makeTimerNode({ seconds: 60 }, { artboard: { ...node, styles: { width: '1000px', height: '500px' } } });
  assert.equal(placed.styles.left, `${Math.round((1000 - 225) / 2)}px`);
});

test('reveal defaults to live for slide-start timers and is settable', () => {
  assert.equal(readTimer({ 'data-timer': '60' }).reveal, 'live');
  assert.equal(readTimer({ 'data-timer': '60', 'data-timer-start': 'click' }).reveal, 'none');
  assert.equal(readTimer({ 'data-timer': '60', [TIMER_REVEAL_ATTR]: 'none' }).reveal, 'none');
  assert.equal(readTimer({ 'data-timer': '60', 'data-timer-start': 'click', [TIMER_REVEAL_ATTR]: 'live' }).reveal, 'live');
  assert.equal(timerAttrs({ seconds: 60 })[TIMER_REVEAL_ATTR], 'live');
  assert.equal(timerAttrs({ seconds: 60, start: 'click' })[TIMER_REVEAL_ATTR], 'none');
  assert.equal(timerSpecFromTag({ minutes: '1', reveal: 'none' }).spec.reveal, 'none');
  assert.equal(timerSpecFromTag({ minutes: '1', reveal: 'maybe' }).warnings.length, 1);
});

test('revealStage: big for 90%, small after, results only at the end or on reveal', () => {
  const d = 100_000;
  const run = startTimer(IDLE, 0);
  assert.deepEqual(revealStage(IDLE, d, 0), { big: true, results: false });
  assert.deepEqual(revealStage(run, d, 0), { big: true, results: false });
  assert.deepEqual(revealStage(run, d, 89_999), { big: true, results: false });
  assert.deepEqual(revealStage(run, d, 90_000), { big: false, results: false });
  assert.deepEqual(revealStage(run, d, 99_000), { big: false, results: false });
  const done = tickTimer(run, d, 100_000);
  assert.deepEqual(revealStage(done, d, 100_000), { big: false, results: true });
  assert.deepEqual(revealStage(run, d, 10, true), { big: false, results: true });
  const paused = pauseTimer(run, 95_000);
  assert.deepEqual(revealStage(paused, d, 200_000), { big: false, results: false });
  // R: reset hides results again.
  assert.deepEqual(revealStage(resetTimer(), d, 0), { big: true, results: false });
});

test('bigTimerTransform centres and enlarges, never shrinks', () => {
  const t = bigTimerTransform({ x: 1080, y: 20, width: 150, height: 60 }, { width: 1280, height: 720 });
  assert.equal(t.dx, 640 - 1155);
  assert.equal(t.dy, 360 - 50);
  assert.ok(Math.abs(t.scale - Math.min(1024 / 150, 360 / 60)) < 1e-9);
  assert.equal(bigTimerTransform({ x: 0, y: 0, width: 1280, height: 720 }, { width: 1280, height: 720 }).scale, 1);
});
