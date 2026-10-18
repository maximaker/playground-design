import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIVE_ATTR, cleanFormFields, cleanFormValues, cleanLiveText, formSummary, cleanPollOptions, pollCounts, pollPercentages, liveBoardFit, liveBoardUrl, liveLookFrom, makeLiveQuestionNode, visibleAnswers,
} from './live.ts';
import { makeNode } from './model.ts';
import type { LiveSubmission } from './live.ts';

test('cleanLiveText strips tags, collapses whitespace and caps the length', () => {
  assert.equal(cleanLiveText('  <b>Hello</b>\n\n<script>x()</script>world  ', 280), 'Hello x()world');
  assert.equal(cleanLiveText('a < b > c', 280), 'a b c');
  assert.equal(cleanLiveText('x'.repeat(400), 280).length, 280);
  assert.equal(cleanLiveText(42, 280), '');
  assert.equal(cleanLiveText('zero​width', 280), 'zerowidth');
});

test('visibleAnswers drops hidden ones and puts the newest first', () => {
  const answers = [
    { id: 'a', name: '', text: 'first', createdAt: 1, hidden: false },
    { id: 'b', name: '', text: 'hidden', createdAt: 2, hidden: true },
    { id: 'c', name: 'Team 3', text: 'third', createdAt: 3, hidden: false },
  ];
  assert.deepEqual(visibleAnswers({ answers }).map((a) => a.id), ['c', 'a']);
});

test('liveBoardFit gives few answers big type and caps many at what fits', () => {
  const few = liveBoardFit(3, 1700, 640);
  assert.equal(few.shown, 3);
  const many = liveBoardFit(60, 1700, 640);
  assert.ok(many.fontPx < few.fontPx, 'more answers, smaller type');
  assert.ok(many.shown < 60 && many.shown >= 12, `shows a readable subset, got ${many.shown}`);
  assert.ok(many.fontPx >= 16, 'never unreadably small');
  assert.equal(liveBoardFit(0, 1700, 640).shown, 0);
});

test('a live question node is an embed of the board, styled from the slide', () => {
  const heading = makeNode({ type: 'text', styles: { 'font-family': '"Space Grotesk", sans-serif', color: '#f5f5f5' } });
  const artboard = makeNode({ type: 'artboard', styles: { width: '1920px', height: '1080px' }, children: [heading.id] });
  heading.parent = artboard.id;
  const doc = { nodes: { [artboard.id]: artboard, [heading.id]: heading } } as never;

  assert.deepEqual(liveLookFrom(doc, artboard, { accent: '#ff5a1f' }), { font: 'Space Grotesk', ink: '#f5f5f5', accent: '#ff5a1f' });

  const node = makeLiveQuestionNode({ baseUrl: 'https://pg.example', code: 'abcd2345', question: 'Vitamin or painkiller?', artboard, doc });
  assert.equal(node.type, 'embed');
  assert.equal(node.attrs[LIVE_ATTR], 'abcd2345');
  assert.match(node.attrs.src!, /^https:\/\/pg\.example\/q\/abcd2345\/board\?font=Space\+Grotesk&ink=%23f5f5f5$/);
  assert.equal(node.styles.position, 'absolute');
  // Inset by the same margin on every side.
  assert.equal(parseFloat(node.styles.left!) * 2 + parseFloat(node.styles.width!), 1920);
  assert.equal(node.styles['pointer-events'], 'none');
  assert.equal(liveBoardUrl('https://pg.example', 'abcd2345'), 'https://pg.example/q/abcd2345/board');
});

test('poll options are cleaned and checked', () => {
  assert.deepEqual(cleanPollOptions([' Vitamin ', '<b>Painkiller</b>', '']), ['Vitamin', 'Painkiller']);
  assert.match(cleanPollOptions(['one']) as string, /2 to 6/);
  assert.match(cleanPollOptions(['a', 'b', 'c', 'd', 'e', 'f', 'g']) as string, /2 to 6/);
  assert.match(cleanPollOptions(['Yes', 'yes']) as string, /same/);
  assert.equal(typeof cleanPollOptions('a,b'), 'string');
});

test('poll percentages are whole and add up to 100', () => {
  const counts = pollCounts({ options: ['a', 'b', 'c'], votes: [0, 1, 2].map((option) => ({ device: 'd', option, at: 0 })) });
  assert.deepEqual(counts, [1, 1, 1]);
  assert.equal(pollPercentages(counts).reduce((a, b) => a + b, 0), 100);
  assert.deepEqual(pollPercentages([2, 0, 1]), [67, 0, 33]);
  assert.deepEqual(pollPercentages([0, 0]), [0, 0]);
});

test('a votable question ranks answers by likes, then newest', () => {
  const answers = [
    { id: 'a', name: '', text: '', createdAt: 1, hidden: false, likes: ['x', 'y'] },
    { id: 'b', name: '', text: '', createdAt: 2, hidden: false, likes: [] },
    { id: 'c', name: '', text: '', createdAt: 3, hidden: false },
  ];
  assert.deepEqual(visibleAnswers({ answers, votable: true }).map((a) => a.id), ['a', 'c', 'b']);
  assert.deepEqual(visibleAnswers({ answers }).map((a) => a.id), ['c', 'b', 'a']);
});

const FEEDBACK = [
  { id: 'useful', type: 'rating', label: 'How useful was it?', lowLabel: 'Not useful', highLabel: 'Very useful', required: true },
  { id: 'recommend', type: 'choice', label: 'Recommend it?', options: ['Yes', 'Maybe', 'No'] },
  { id: 'change', type: 'text', label: 'One thing to change?', onBoard: true },
];

test('form fields are validated: count, ids, labels, options, scale', () => {
  const fields = cleanFormFields(FEEDBACK);
  assert.ok(Array.isArray(fields));
  assert.equal(fields[0]!.max, 5);
  assert.equal(fields[0]!.required, true);
  assert.equal(fields[1]!.required, false);
  assert.deepEqual((cleanFormFields([{ type: 'text', label: 'a' }, { type: 'text', label: 'b' }]) as { id: string }[]).map((f) => f.id), ['f1', 'f2']);
  assert.match(cleanFormFields([]) as string, /1 to 8 fields/);
  assert.match(cleanFormFields(Array.from({ length: 9 }, () => ({ type: 'text', label: 'x' }))) as string, /1 to 8/);
  assert.match(cleanFormFields([{ id: 'a', type: 'text', label: 'x' }, { id: 'a', type: 'text', label: 'y' }]) as string, /Two fields/);
  assert.match(cleanFormFields([{ type: 'text', label: '  <b></b> ' }]) as string, /needs a label/);
  assert.match(cleanFormFields([{ type: 'choice', label: 'x', options: ['one'] }]) as string, /2 to 6/);
  assert.match(cleanFormFields([{ type: 'choice', label: 'x', options: ['1', '2', '3', '4', '5', '6', '7'] }]) as string, /2 to 6/);
  assert.match(cleanFormFields([{ type: 'rating', label: 'x', max: 11 }]) as string, /max/);
  assert.match(cleanFormFields([{ type: 'slider', label: 'x' }]) as string, /type/);
  assert.match(cleanFormFields([{ id: 'a b', type: 'text', label: 'x' }]) as string, /id/);
  assert.equal((cleanFormFields([{ type: 'text', label: 'x', onBoard: false }]) as { onBoard?: boolean }[])[0]!.onBoard, false);
});

test('form values: required, ranges, choice by index or label, cleaned text', () => {
  const fields = cleanFormFields(FEEDBACK) as Exclude<ReturnType<typeof cleanFormFields>, string>;
  assert.deepEqual(cleanFormValues(fields, { useful: 4, recommend: 'maybe', change: ' <i>More</i>  breaks ' }), { useful: 4, recommend: 1, change: 'More breaks' });
  assert.match(cleanFormValues(fields, { recommend: 0 }) as string, /needs an answer/);
  assert.match(cleanFormValues(fields, { useful: 6 }) as string, /pick 1 to 5/);
  assert.match(cleanFormValues(fields, { useful: 3, recommend: 7 }) as string, /options/);
  assert.deepEqual(cleanFormValues(fields, { useful: '2', change: '   ', extra: 'x' }), { useful: 2 });
});

test('formSummary: averages, distributions, choice counts, text newest first with hidden marked', () => {
  const fields = cleanFormFields(FEEDBACK) as Exclude<ReturnType<typeof cleanFormFields>, string>;
  const submissions: LiveSubmission[] = [
    { id: 's1', device: 'a', createdAt: 1, values: { useful: 5, recommend: 0, change: 'old' } },
    { id: 's2', device: 'b', createdAt: 2, values: { useful: 4, recommend: 0 } },
    { id: 's3', device: 'c', createdAt: 3, values: { useful: 4, recommend: 2, change: 'new' }, hidden: ['change'] },
  ];
  const [rating, choice, text] = formSummary({ fields, submissions });
  assert.equal(rating!.average, 4.3);
  assert.deepEqual(rating!.distribution, [0, 0, 0, 2, 1]);
  assert.equal(rating!.responses, 3);
  assert.deepEqual(choice!.options!.map((o) => [o.label, o.count, o.percent]), [['Yes', 2, 67], ['Maybe', 0, 0], ['No', 1, 33]]);
  assert.deepEqual(text!.answers!.map((a) => [a.id, a.text, a.hidden]), [['s3:change', 'new', true], ['s1:change', 'old', false]]);
  assert.equal(formSummary({ fields, submissions: [] })[0]!.average, null);
});
