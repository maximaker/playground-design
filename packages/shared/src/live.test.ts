import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIVE_ATTR, cleanLiveText, liveBoardFit, liveBoardUrl, liveLookFrom, makeLiveQuestionNode, visibleAnswers,
} from './live.ts';
import { makeNode } from './model.ts';

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
