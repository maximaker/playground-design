/**
 * Live questions: the server half.
 *
 * Three surfaces, all addressed by the question's code:
 *
 * - `/q/<code>` is the answer page. Public, no account, built for a phone on
 *   venue Wi-Fi: one small HTML page, no bundle, no fonts to fetch.
 * - `/q/<code>/board` is what sits on the slide, inside an ordinary embed. It
 *   draws the question, a QR code and the answers, and keeps them current.
 * - `/api/live/<code>/…` is moderation. It sits behind the API's account gate,
 *   which resolves the code to its document, so hiding an answer needs the
 *   same right as editing the slide. The board shows the controls only when
 *   that API says yes — on a projector the presenter is signed in, on a
 *   published page or in a screenshot nobody is.
 *
 * Updates reach the board by long-polling `/q/<code>/state`. The document
 * websocket would have meant handing an anonymous page a document channel;
 * a held request that answers the moment something changes is as quick and
 * survives proxies that drop upgrades.
 */

import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import {
  type LiveAnswer, type LiveQuestion,
  LIVE_NAME_MAX, LIVE_QUESTION_MAX, LIVE_TEXT_MAX, cleanLiveText, liveBoardFit, visibleAnswers,
} from '@playground/shared';
import { persistence } from './persistence.ts';

// No 0/o, 1/l/i: the code is also typed by hand from a projector.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const CODE_LENGTH = 8;
export const LIVE_CODE = /^[a-z2-9]{8}$/;

/** A question takes this many answers in total, hidden ones included. */
const MAX_ANSWERS = 2000;

export class LiveError extends Error {
  readonly status: 400 | 404 | 409 | 429;
  constructor(message: string, status: 400 | 404 | 409 | 429 = 400) { super(message); this.status = status; }
}

interface Held { q: LiveQuestion; version: number }

const cache = new Map<string, Held>();
const waiters = new Map<string, Set<() => void>>();

function newCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

async function held(code: string): Promise<Held | null> {
  if (!LIVE_CODE.test(code)) return null;
  const hit = cache.get(code);
  if (hit) return hit;
  const q = await (await persistence()).loadLiveQuestion(code);
  if (!q) return null;
  // Another request may have loaded it while this one waited.
  const raced = cache.get(code);
  if (raced) return raced;
  const fresh = { q, version: 1 };
  cache.set(code, fresh);
  return fresh;
}

async function changed(h: Held): Promise<void> {
  h.version++;
  await (await persistence()).saveLiveQuestion(h.q);
  const list = waiters.get(h.q.code);
  if (!list) return;
  waiters.delete(h.q.code);
  for (const wake of list) wake();
}

export async function getLiveQuestion(code: string): Promise<LiveQuestion | null> {
  return (await held(code))?.q ?? null;
}

export async function liveQuestionsFor(docId: string): Promise<LiveQuestion[]> {
  const stored = await (await persistence()).loadLiveQuestions(docId);
  // The cache is the authority for anything it holds: a write may be in flight.
  return stored.map((q) => cache.get(q.code)?.q ?? q);
}

export async function createLiveQuestion(docId: string, question: string): Promise<LiveQuestion> {
  const text = cleanLiveText(question, LIVE_QUESTION_MAX);
  if (!text) throw new LiveError('A live question needs some text.');
  let code = newCode();
  while (await held(code)) code = newCode();
  const q: LiveQuestion = { code, docId, question: text, open: true, createdAt: Date.now(), answers: [] };
  const h = { q, version: 0 };
  cache.set(code, h);
  await changed(h);
  return q;
}

async function mustHold(code: string): Promise<Held> {
  const h = await held(code);
  if (!h) throw new LiveError('No such question.', 404);
  return h;
}

export async function updateLiveQuestion(code: string, patch: { question?: string; open?: boolean }): Promise<LiveQuestion> {
  const h = await mustHold(code);
  if (patch.question !== undefined) {
    const text = cleanLiveText(patch.question, LIVE_QUESTION_MAX);
    if (!text) throw new LiveError('A live question needs some text.');
    h.q.question = text;
  }
  if (patch.open !== undefined) h.q.open = patch.open;
  await changed(h);
  return h.q;
}

export async function hideLiveAnswer(code: string, answerId: string, hidden = true): Promise<LiveAnswer> {
  const h = await mustHold(code);
  const answer = h.q.answers.find((a) => a.id === answerId);
  if (!answer) throw new LiveError('No such answer.', 404);
  answer.hidden = hidden;
  await changed(h);
  return answer;
}

/** Hides every answer. They stay stored: clearing the slide is not deleting what people said. */
export async function clearLiveAnswers(code: string): Promise<number> {
  const h = await mustHold(code);
  let n = 0;
  for (const a of h.q.answers) if (!a.hidden) { a.hidden = true; n++; }
  await changed(h);
  return n;
}

// ---------------------------------------------------------------------------
// Submitting
// ---------------------------------------------------------------------------

/*
 * Two limits, because a room of students is one IP address. Per client — a
 * random id the answer page keeps in localStorage — is the one that bites:
 * a few seconds between answers and a ceiling per ten minutes. Per IP is only
 * a flood guard, set high enough for a whole venue behind one NAT.
 */
const CLIENT_GAP_MS = 3_000;
const CLIENT_WINDOW_MS = 10 * 60_000;
const CLIENT_LIMIT = 12;
const IP_WINDOW_MS = 60_000;
const IP_LIMIT = 240;

const clientHits = new Map<string, number[]>();
const ipHits = new Map<string, number[]>();
let lastSweep = Date.now();

function recent(map: Map<string, number[]>, key: string, windowMs: number, now: number): number[] {
  const list = (map.get(key) ?? []).filter((t) => now - t < windowMs);
  map.set(key, list);
  return list;
}

/** Forgets the limiter's memory. For tests. */
export function resetLiveLimits(): void { clientHits.clear(); ipHits.clear(); }

export async function submitLiveAnswer(
  code: string,
  input: { text?: unknown; name?: unknown; client?: unknown },
  ip: string,
): Promise<LiveAnswer> {
  const h = await mustHold(code);
  if (!h.q.open) throw new LiveError('This question is closed.', 409);
  const text = cleanLiveText(input.text, LIVE_TEXT_MAX);
  if (!text) throw new LiveError('Write an answer first.');
  const name = cleanLiveText(input.name, LIVE_NAME_MAX);
  const client = typeof input.client === 'string' && /^[\w-]{8,64}$/.test(input.client) ? input.client : `ip:${ip}`;

  const now = Date.now();
  if (now - lastSweep > CLIENT_WINDOW_MS) {
    for (const [k, v] of clientHits) if (!v.some((t) => now - t < CLIENT_WINDOW_MS)) clientHits.delete(k);
    for (const [k, v] of ipHits) if (!v.some((t) => now - t < IP_WINDOW_MS)) ipHits.delete(k);
    lastSweep = now;
  }
  const byIp = recent(ipHits, ip, IP_WINDOW_MS, now);
  const byClient = recent(clientHits, `${code}|${client}`, CLIENT_WINDOW_MS, now);
  if (byIp.length >= IP_LIMIT) throw new LiveError('Too many answers from this network. Try again in a minute.', 429);
  if (byClient.length && now - byClient[byClient.length - 1]! < CLIENT_GAP_MS) {
    throw new LiveError('One moment — you just sent one.', 429);
  }
  if (byClient.length >= CLIENT_LIMIT) throw new LiveError('That is a lot of answers. Give someone else a turn.', 429);
  if (h.q.answers.length >= MAX_ANSWERS) throw new LiveError('This question has all the answers it can take.', 409);

  byIp.push(now);
  byClient.push(now);
  const answer: LiveAnswer = { id: randomBytes(6).toString('base64url'), name, text, createdAt: now, hidden: false };
  h.q.answers.push(answer);
  await changed(h);
  return answer;
}

// ---------------------------------------------------------------------------
// Board state
// ---------------------------------------------------------------------------

/** What the board draws. Never carries the document id. */
export interface BoardState {
  v: number;
  question: string;
  open: boolean;
  total: number;
  answers: { id: string; name: string; text: string }[];
}

/** More than this is never shown at once; the board says how many there are. */
const BOARD_MAX = 120;

function boardState(h: Held): BoardState {
  const visible = visibleAnswers(h.q);
  return {
    v: h.version,
    question: h.q.question,
    open: h.q.open,
    total: visible.length,
    answers: visible.slice(0, BOARD_MAX).map(({ id, name, text }) => ({ id, name, text })),
  };
}

/**
 * The board's state, held until it differs from `since` or the wait runs out.
 * The answer arrives the moment something changes rather than on the next tick.
 */
export async function waitForBoardState(code: string, since: number, waitMs: number, signal?: AbortSignal): Promise<BoardState | null> {
  const h = await held(code);
  if (!h) return null;
  if (h.version !== since || waitMs <= 0) return boardState(h);
  await new Promise<void>((resolve) => {
    const done = () => { clearTimeout(timer); waiters.get(code)?.delete(done); resolve(); };
    const timer = setTimeout(done, waitMs);
    signal?.addEventListener('abort', done, { once: true });
    const list = waiters.get(code) ?? new Set();
    list.add(done);
    waiters.set(code, list);
  });
  return boardState(h);
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
/** JSON inside a <script>: `</script>` in an answer must not end it. */
const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028|\u2029/g, '');

/** The QR code as an SVG path: one `M x y h1 v1 h-1 z` per dark module. */
export function qrSvg(text: string, color = '#000', background = '#fff'): string {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const size = qr.modules.size;
  const quiet = 4;
  let d = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (qr.modules.get(x, y)) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
    }
  }
  const box = size + quiet * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${box} ${box}" shape-rendering="crispEdges">`
    + `<rect width="${box}" height="${box}" fill="${esc(background)}"/><path d="${d}" fill="${esc(color)}"/></svg>`;
}

/** Display form of an answer URL: no scheme, so it reads aloud and fits under a QR code. */
export function shortAnswerUrl(publicUrl: string, code: string): string {
  return `${publicUrl.replace(/^https?:\/\//, '')}/q/${code}`;
}

const GENERIC_FONTS = new Set(['serif', 'sans-serif', 'monospace', 'system-ui', 'ui-sans-serif', 'ui-serif', 'cursive', 'inherit']);

export interface BoardLook {
  font?: string;
  ink?: string;
  accent?: string;
  card?: string;
}

/** Look settings arrive in the query string, so each is checked before it reaches CSS. */
function safeLook(look: BoardLook): Required<BoardLook> {
  const color = (v: string | undefined, fallback: string) =>
    v && /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|oklch)\([\d\s.,%/-]+\)|[a-z]{3,20})$/i.test(v.trim()) ? v.trim() : fallback;
  const font = look.font && /^[\w\s\-'",]{1,80}$/.test(look.font) ? look.font.trim() : '';
  return {
    font,
    ink: color(look.ink, '#111114'),
    accent: color(look.accent, '#2f6bff'),
    card: color(look.card, ''),
  };
}

function fontHead(font: string): string {
  const first = font.split(',')[0]!.replace(/['"]/g, '').trim();
  if (!first || GENERIC_FONTS.has(first.toLowerCase())) return '';
  const family = encodeURIComponent(first).replace(/%20/g, '+');
  // A family Google does not have is one failed stylesheet and the fallback stack.
  return `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>`
    + `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${family}:wght@400;500;600;700&display=swap">`;
}

function fontStack(font: string): string {
  return `${font ? `${font}, ` : ''}ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
}

export function boardHtml(q: LiveQuestion, version: number, publicUrl: string, look: BoardLook): string {
  const l = safeLook(look);
  const url = `${publicUrl}/q/${q.code}`;
  const h: Held = { q, version };
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(q.question)}</title>
${fontHead(l.font)}
<style>
  :root { --ink: ${l.ink}; --accent: ${l.accent}; --card: ${l.card || 'color-mix(in srgb, var(--ink) 6%, transparent)'}; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; }
  body { font-family: ${fontStack(l.font)}; color: var(--ink); -webkit-font-smoothing: antialiased; }
  .board { position: absolute; inset: 0; display: flex; flex-direction: column; gap: 3.2vmin; padding: 0; }
  .head { display: flex; gap: 4vmin; align-items: flex-start; justify-content: space-between; }
  .q { margin: 0; font-size: clamp(18px, 5.4vmin, 120px); line-height: 1.12; font-weight: 700; letter-spacing: -0.02em; text-wrap: balance; }
  .meta { margin-top: 1.6vmin; font-size: clamp(11px, 2.1vmin, 40px); opacity: .6; font-weight: 500; }
  .meta b { color: var(--accent); opacity: 1; font-weight: 700; }
  .scan { flex: none; display: flex; flex-direction: column; align-items: center; gap: 1vmin; width: 22vmin; }
  .scan svg { width: 22vmin; height: 22vmin; display: block; border-radius: 1.2vmin; }
  .scan span { font-size: clamp(9px, 1.7vmin, 32px); font-weight: 600; white-space: nowrap; letter-spacing: .01em; }
  .closed .scan svg { opacity: .25; }
  .grid { flex: 1; min-height: 0; display: grid; align-content: start; overflow: hidden; }
  .card { position: relative; background: var(--card); border-radius: .7em; padding: .7em .9em .8em; min-width: 0;
          animation: in .4s cubic-bezier(.2,.8,.2,1); }
  .card .who { font-size: .6em; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: var(--accent); margin-bottom: .35em;
               white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .card .text { line-height: 1.3; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
  .card .x { display: none; position: absolute; top: .3em; right: .3em; border: 0; border-radius: 99px; width: 1.4em; height: 1.4em;
             font: inherit; font-size: .7em; line-height: 1; cursor: pointer; background: var(--ink); color: #fff; }
  .mod .card:hover .x { display: block; }
  .empty { grid-column: 1 / -1; font-size: clamp(12px, 2.6vmin, 48px); opacity: .45; padding-top: 2vmin; }
  .more { grid-column: 1 / -1; font-size: .7em; opacity: .55; font-weight: 600; }
  .tools { display: none; position: absolute; right: 0; bottom: 0; gap: 6px; font: 600 12px ui-sans-serif, system-ui, sans-serif; }
  .mod:hover .tools { display: flex; }
  .tools button { border: 0; border-radius: 99px; padding: 7px 12px; cursor: pointer; font: inherit; background: #111114; color: #fff; box-shadow: 0 2px 8px rgba(0,0,0,.2); }
  @keyframes in { from { opacity: 0; transform: translateY(8px) scale(.98); } }
</style></head>
<body>
<div class="board" id="board">
  <div class="head">
    <div><h1 class="q" id="q">${esc(q.question)}</h1><div class="meta" id="meta"></div></div>
    <div class="scan">${qrSvg(url)}<span>${esc(shortAnswerUrl(publicUrl, q.code))}</span></div>
  </div>
  <div class="grid" id="grid"></div>
  <div class="tools"><button id="toggle"></button><button id="clear">Clear all</button></div>
</div>
<script>
${liveBoardFit.toString()}
const code = ${scriptJson(q.code)};
let state = ${scriptJson(boardState(h))};
const board = document.getElementById('board');
const grid = document.getElementById('grid');
let canModerate = false;

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

function render() {
  document.getElementById('q').textContent = state.question;
  board.classList.toggle('closed', !state.open);
  const meta = document.getElementById('meta');
  meta.textContent = '';
  const n = el('b', null, String(state.total));
  meta.append(n, state.total === 1 ? ' answer' : ' answers', state.open ? '' : ' · closed');
  document.getElementById('toggle').textContent = state.open ? 'Close question' : 'Reopen';

  const box = grid.getBoundingClientRect();
  const fit = liveBoardFit(state.answers.length, box.width || innerWidth, box.height || innerHeight * 0.7);
  grid.style.fontSize = fit.fontPx + 'px';
  grid.style.gap = Math.round(fit.fontPx * 0.8) + 'px';
  grid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(' + Math.min(fit.minCardPx, box.width || fit.minCardPx) + 'px, 1fr))';
  const seen = new Set([...grid.querySelectorAll('.card')].map((c) => c.dataset.id));
  grid.textContent = '';
  if (!state.answers.length) {
    grid.append(el('div', 'empty', state.open ? 'Answers will appear here.' : 'No answers.'));
    return;
  }
  const shown = state.answers.slice(0, fit.shown);
  for (const a of shown) {
    const card = el('div', 'card');
    card.dataset.id = a.id;
    if (seen.has(a.id)) card.style.animation = 'none';
    if (a.name) card.append(el('div', 'who', a.name));
    card.append(el('div', 'text', a.text));
    const x = el('button', 'x', '×');
    x.title = 'Hide this answer';
    x.onclick = (e) => { e.stopPropagation(); moderate('/answers/' + encodeURIComponent(a.id) + '/hide', { hidden: true }); };
    card.append(x);
    grid.append(card);
  }
  // Cards that would be cut off are dropped rather than clipped mid-line.
  const limit = grid.getBoundingClientRect().bottom;
  const cards = [...grid.querySelectorAll('.card')];
  while (cards.length > 1 && cards[cards.length - 1].getBoundingClientRect().bottom > limit + 1) cards.pop().remove();
  let rest = state.total - cards.length;
  if (rest > 0) {
    const more = el('div', 'more', '+ ' + rest + ' more');
    grid.append(more);
    if (more.getBoundingClientRect().bottom > limit + 1 && cards.length > 1) {
      cards.pop().remove();
      more.textContent = '+ ' + (++rest) + ' more';
    }
  }
}

async function moderate(path, body, method) {
  const r = await fetch('/api/live/' + code + path, {
    method: method || 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  }).catch(() => null);
  if (r && r.ok) poll(0);
}
document.getElementById('toggle').onclick = () => moderate('', { open: !state.open }, 'PATCH');
document.getElementById('clear').onclick = () => { if (confirm('Hide every answer? They stay stored.')) moderate('/clear'); };

let polling = false;
async function poll(wait) {
  try {
    const r = await fetch('/q/' + code + '/state?v=' + (wait ? state.v : -1) + '&wait=' + wait, { cache: 'no-store' });
    if (r.ok) { const next = await r.json(); if (next.v !== state.v || !wait) { state = next; render(); } }
    else if (r.status === 404) return;
  } catch { await new Promise((ok) => setTimeout(ok, 3000)); }
  if (wait) setTimeout(() => poll(25000), 50);
}

render();
addEventListener('resize', render);
fetch('/api/live/' + code, { credentials: 'same-origin' }).then((r) => r.ok ? r.json() : null).then((me) => {
  canModerate = !!(me && me.canModerate);
  board.classList.toggle('mod', canModerate);
}).catch(() => {});
// Held back a moment so a renderer waiting for the network to go quiet
// (the screenshot path) is not kept waiting by a request that never ends.
setTimeout(() => poll(25000), 1200);
</script>
</body></html>`;
}

export function answerPageHtml(q: LiveQuestion | null, code: string): string {
  const body = q
    ? `<main>
  <p class="eyebrow">Live question</p>
  <h1>${esc(q.question)}</h1>
  <form id="form" ${q.open ? '' : 'hidden'}>
    <label>Your answer<textarea id="text" name="text" maxlength="${LIVE_TEXT_MAX}" rows="5" required placeholder="Type here…"></textarea></label>
    <div class="count"><span id="count">0</span> / ${LIVE_TEXT_MAX}</div>
    <label>Team or name <span class="opt">optional</span><input id="name" name="name" maxlength="${LIVE_NAME_MAX}" autocomplete="nickname"></label>
    <button type="submit" id="send">Send answer</button>
    <p class="error" id="error" role="alert"></p>
  </form>
  <section id="thanks" hidden>
    <p class="big">Thanks — it’s on the screen.</p>
    <button type="button" id="again" class="secondary">Answer again</button>
  </section>
  <p class="closed" ${q.open ? 'hidden' : ''}>This question is closed.</p>
</main>`
    : `<main><h1>This question is not here.</h1><p>Check the code on the slide — it looks like <b>/q/abcd2345</b>.</p></main>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#ededef">
<title>${q ? esc(q.question) : 'Live question'}</title>
<style>
  :root { color-scheme: light dark; --bg: #ededef; --plate: #fff; --ink: #111114; --mute: #6b6b76; --line: #d6d6dc; --cta: #111114; --cta-ink: #fff; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0e0e13; --plate: #1b1b23; --ink: #f2f2f5; --mute: #9a9aa6; --line: #38384a; --cta: #f2f2f5; --cta-ink: #111114; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100dvh; background: var(--bg); color: var(--ink);
         font: 16px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; -webkit-font-smoothing: antialiased; }
  main { max-width: 34rem; margin: 0 auto; padding: max(28px, env(safe-area-inset-top)) 16px 40px; }
  .eyebrow { margin: 0 0 8px; font-size: 12px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: var(--mute); }
  h1 { margin: 0 0 24px; font-size: 26px; line-height: 1.2; letter-spacing: -0.01em; text-wrap: balance; }
  form, #thanks { background: var(--plate); border-radius: 22px; padding: 18px; box-shadow: 0 1px 2px rgba(17,17,20,.05), 0 8px 24px rgba(17,17,20,.07); }
  label { display: block; font-size: 14px; font-weight: 600; margin-bottom: 14px; }
  .opt { font-weight: 400; color: var(--mute); }
  textarea, input { display: block; width: 100%; margin-top: 6px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 14px;
                    background: transparent; color: inherit; font-size: 17px; line-height: 1.4; font-family: inherit; resize: vertical; }
  textarea:focus, input:focus { outline: 2px solid var(--ink); outline-offset: 1px; border-color: transparent; }
  .count { margin: -8px 0 14px; text-align: right; font-size: 12px; color: var(--mute); font-variant-numeric: tabular-nums; }
  button { width: 100%; min-height: 52px; border: 0; border-radius: 999px; background: var(--cta); color: var(--cta-ink); font-size: 17px; font-weight: 600; font-family: inherit; cursor: pointer; }
  button:disabled { opacity: .5; }
  button.secondary { background: transparent; color: var(--ink); box-shadow: inset 0 0 0 1px var(--line); }
  .error { min-height: 1.2em; margin: 10px 0 0; color: #d93a1e; font-size: 14px; }
  .big { font-size: 20px; font-weight: 600; margin: 4px 0 18px; }
  .closed { color: var(--mute); }
</style></head>
<body>${body}
${q ? `<script>
const code = ${scriptJson(code)};
const form = document.getElementById('form'), text = document.getElementById('text'), name = document.getElementById('name');
const err = document.getElementById('error'), send = document.getElementById('send'), thanks = document.getElementById('thanks');
let client = '';
try { client = localStorage.getItem('live-client') || ''; if (!client) { client = crypto.randomUUID(); localStorage.setItem('live-client', client); } name.value = localStorage.getItem('live-name') || ''; } catch {}
if (!client) client = Math.random().toString(36).slice(2) + Date.now().toString(36);
text.addEventListener('input', () => { document.getElementById('count').textContent = text.value.length; });
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  err.textContent = '';
  send.disabled = true;
  try {
    const r = await fetch('/q/' + code + '/answers', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: text.value, name: name.value, client }) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) { err.textContent = body.error || 'That did not send. Try again.'; return; }
    try { localStorage.setItem('live-name', name.value); } catch {}
    text.value = ''; document.getElementById('count').textContent = '0';
    form.hidden = true; thanks.hidden = false;
  } catch { err.textContent = 'No connection. Try again.'; }
  finally { send.disabled = false; }
});
document.getElementById('again').addEventListener('click', () => { thanks.hidden = true; form.hidden = false; text.focus(); });
</script>` : ''}
</body></html>`;
}
