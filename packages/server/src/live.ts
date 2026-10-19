/**
 * Live questions: the server half.
 *
 * Three surfaces, all addressed by the question's code:
 *
 * - `/q/<code>` is the answer page: a text box, a button per option for a poll, or a whole form. Public, no account, built for a phone on
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

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import QRCode from 'qrcode';
import {
  type CanvasDocument, type LiveAnswer, type LiveFieldSummary, type LiveKind, type LiveQuestion, livePlacements,
  LIVE_NAME_MAX, LIVE_QUESTION_MAX, LIVE_TEXT_MAX, cleanFormFields, cleanFormValues, cleanLiveText, cleanPollOptions, formSummary,
  liveBoardFit, pollCounts, pollPercentages, visibleAnswers,
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

export interface LiveSettings {
  kind?: LiveKind;
  options?: unknown;
  onePerPerson?: boolean;
  votable?: boolean;
  qr?: boolean;
  /** A form's fields; see cleanFormFields. */
  fields?: unknown;
}

export async function createLiveQuestion(docId: string, question: string, settings: LiveSettings = {}): Promise<LiveQuestion> {
  const text = cleanLiveText(question, LIVE_QUESTION_MAX);
  if (!text) throw new LiveError('A live question needs some text.');
  const kind: LiveKind = settings.kind === 'poll' || settings.kind === 'form' ? settings.kind : 'text';
  let code = newCode();
  while (await held(code)) code = newCode();
  const q: LiveQuestion = {
    code, docId, question: text, open: true, createdAt: Date.now(), answers: [], kind,
    // New questions are once per person unless asked otherwise.
    onePerPerson: settings.onePerPerson ?? true,
    ...(settings.qr === false ? { qr: false } : {}),
  };
  if (kind === 'poll') {
    const options = cleanPollOptions(settings.options);
    if (typeof options === 'string') throw new LiveError(options);
    q.options = options;
    q.votes = [];
  } else if (kind === 'form') {
    const fields = cleanFormFields(settings.fields);
    if (typeof fields === 'string') throw new LiveError(fields);
    q.fields = fields;
    q.submissions = [];
  } else if (settings.votable) {
    q.votable = true;
  }
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

export async function updateLiveQuestion(
  code: string,
  patch: { question?: string; open?: boolean; options?: unknown; fields?: unknown; onePerPerson?: boolean; votable?: boolean; qr?: boolean },
): Promise<LiveQuestion> {
  const h = await mustHold(code);
  const q = h.q;
  if (patch.question !== undefined) {
    const text = cleanLiveText(patch.question, LIVE_QUESTION_MAX);
    if (!text) throw new LiveError('A live question needs some text.');
    q.question = text;
  }
  if (patch.options !== undefined) {
    if (q.kind !== 'poll') throw new LiveError('Only a poll has options.');
    // Relabelling options under existing votes would move people's votes to answers they did not pick.
    if (q.votes?.length) throw new LiveError('This poll has votes. Reset them before changing the options.', 409);
    const options = cleanPollOptions(patch.options);
    if (typeof options === 'string') throw new LiveError(options);
    q.options = options;
  }
  if (patch.fields !== undefined) {
    if (q.kind !== 'form') throw new LiveError('Only a form has fields.');
    // Renaming or reordering fields under existing responses would file people's answers under questions they did not see.
    const fields = cleanFormFields(patch.fields);
    if (typeof fields === 'string') throw new LiveError(fields);
    // Showing or hiding a field on the board only changes the display, so it is allowed under responses.
    const shape = (list: typeof fields) => JSON.stringify(list.map(({ onBoard: _o, ...f }) => f));
    if (q.submissions?.length && shape(fields) !== shape(q.fields ?? [])) {
      throw new LiveError('This form has responses. Reset them before changing the fields (onBoard alone may change).', 409);
    }
    q.fields = fields;
  }
  if (patch.votable !== undefined) {
    if (q.kind === 'poll' && patch.votable) throw new LiveError('A poll is already a vote; votable is for text questions.');
    if (q.kind === 'form' && patch.votable) throw new LiveError('votable is for text questions, not forms.');
    q.votable = patch.votable;
  }
  if (patch.onePerPerson !== undefined) q.onePerPerson = patch.onePerPerson;
  if (patch.qr !== undefined) q.qr = patch.qr;
  if (patch.open !== undefined) q.open = patch.open;
  await changed(h);
  return q;
}

/**
 * Hides or shows an answer. In a form an "answer" is one written field of one
 * submission, addressed as `<submissionId>:<fieldId>`; ratings and choices
 * are counts, and there is nothing to hide in a count.
 */
export async function hideLiveAnswer(code: string, answerId: string, hidden = true): Promise<{ id: string; hidden: boolean }> {
  const h = await mustHold(code);
  if (h.q.kind === 'form') {
    const [submissionId, fieldId] = answerId.split(':');
    const sub = h.q.submissions?.find((s) => s.id === submissionId);
    const field = h.q.fields?.find((f) => f.id === fieldId && f.type === 'text');
    if (!sub || !field || sub.values[field.id] === undefined) throw new LiveError('No such answer.', 404);
    const set = new Set(sub.hidden ?? []);
    if (hidden) set.add(field.id); else set.delete(field.id);
    if (set.size) sub.hidden = [...set]; else delete sub.hidden;
    await changed(h);
    return { id: answerId, hidden };
  }
  const answer = h.q.answers.find((a) => a.id === answerId);
  if (!answer) throw new LiveError('No such answer.', 404);
  answer.hidden = hidden;
  await changed(h);
  return answer;
}

/**
 * Clears the slide. Text answers are hidden, not deleted: clearing the slide
 * is not erasing what people said. A poll's votes are reset, because a hidden
 * vote has no meaning — the point of resetting a poll is to ask again.
 */
export async function clearLiveAnswers(code: string): Promise<{ hidden: number } | { votesReset: number }> {
  const h = await mustHold(code);
  if (h.q.kind === 'form') {
    // A form's ratings and choices stay: clearing takes the written answers off the slide, as for a question.
    let n = 0;
    for (const sub of h.q.submissions ?? []) {
      for (const f of h.q.fields ?? []) {
        if (f.type !== 'text' || sub.values[f.id] === undefined || sub.hidden?.includes(f.id)) continue;
        (sub.hidden ??= []).push(f.id);
        n++;
      }
    }
    await changed(h);
    return { hidden: n };
  }
  if (h.q.kind === 'poll') {
    const votesReset = h.q.votes?.length ?? 0;
    h.q.votes = [];
    await changed(h);
    return { votesReset };
  }
  let n = 0;
  for (const a of h.q.answers) if (!a.hidden) { a.hidden = true; n++; }
  await changed(h);
  return { hidden: n };
}

/**
 * Removes a question and everything answered to it, for good: the leftovers of
 * a slide that was deleted or replaced. Its answer page and board stop working.
 */
export async function deleteLiveQuestion(code: string): Promise<{ deleted: string }> {
  const h = await mustHold(code);
  await (await persistence()).deleteLiveQuestion(h.q.code);
  cache.delete(h.q.code);
  const list = waiters.get(h.q.code);
  waiters.delete(h.q.code);
  for (const wake of list ?? []) wake();
  return { deleted: h.q.code };
}

/**
 * Deletes every response to a form, so it can be asked again or its fields
 * changed. Unlike clearing, this is not undoable.
 */
export async function resetLiveForm(code: string): Promise<{ submissionsReset: number }> {
  const h = await mustHold(code);
  if (h.q.kind !== 'form') throw new LiveError('Only a form has responses to reset; clear a question, or reset a poll’s votes.');
  const submissionsReset = h.q.submissions?.length ?? 0;
  h.q.submissions = [];
  await changed(h);
  return { submissionsReset };
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

/*
 * "One answer per person" without accounts means one per phone. The phone
 * gets a random id, signed so it cannot simply be made up, and keeps it twice
 * — in an httpOnly cookie and in localStorage — so clearing one does not
 * reset it. It stops casual double answers; another browser, or a private
 * window, is a new phone, and nothing short of accounts changes that.
 */

const DEVICE_COOKIE = 'pg_live';

let secret: Buffer | null = null;

/**
 * The signing key. LIVE_SECRET when set; otherwise one generated once and kept
 * beside the database, so devices survive a redeploy; otherwise per process.
 */
function deviceSecret(): Buffer {
  if (secret) return secret;
  if (process.env.LIVE_SECRET) return (secret = Buffer.from(process.env.LIVE_SECRET));
  const db = process.env.PLAYGROUND_DB;
  if (db) {
    const file = join(dirname(db), 'live-secret');
    try {
      if (existsSync(file)) return (secret = readFileSync(file));
      const fresh = randomBytes(32);
      writeFileSync(file, fresh, { mode: 0o600 });
      return (secret = fresh);
    } catch { /* read-only or missing directory: fall through */ }
  }
  return (secret = randomBytes(32));
}

function sign(id: string): string {
  return createHmac('sha256', deviceSecret()).update(id).digest('base64url').slice(0, 22);
}

/** The device id inside a token, or null when the token is not one of ours. */
export function verifyDevice(token: string | undefined | null): string | null {
  if (!token || token.length > 80) return null;
  const [id, mac] = token.split('.');
  if (!id || !mac || !/^[\w-]{16,32}$/.test(id)) return null;
  const want = Buffer.from(sign(id));
  const got = Buffer.from(mac);
  return want.length === got.length && timingSafeEqual(want, got) ? id : null;
}

export function newDeviceToken(): string {
  const id = randomBytes(16).toString('base64url');
  return `${id}.${sign(id)}`;
}

/**
 * The phone behind a request: the cookie first, then the copy the page kept
 * in localStorage. Mints one when neither is valid. `token` is what the page
 * should keep; `cookie` is set when the browser needs it (again).
 */
export function deviceFor(cookieHeader: string | undefined, kept: string | undefined): { id: string; token: string; cookie: string | null } {
  const fromCookie = cookieHeader?.split(/;\s*/).find((p) => p.startsWith(`${DEVICE_COOKIE}=`))?.slice(DEVICE_COOKIE.length + 1);
  for (const [token, fromJar] of [[fromCookie, true], [kept, false]] as const) {
    const id = verifyDevice(token);
    if (id) return { id, token: token!, cookie: fromJar ? null : deviceCookie(token!) };
  }
  const token = newDeviceToken();
  return { id: token.split('.')[0]!, token, cookie: deviceCookie(token) };
}

function deviceCookie(token: string): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${DEVICE_COOKIE}=${token}; Path=/q; Max-Age=31536000; HttpOnly; SameSite=Lax${secure}`;
}

// ---------------------------------------------------------------------------
// Submitting
// ---------------------------------------------------------------------------

/*
 * Two limits, because a room of students is one IP address. Per phone is the
 * one that bites: a few seconds between answers and a ceiling per ten
 * minutes. Per IP is only a flood guard, set high enough for a whole venue
 * behind one NAT.
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

function sweep(now: number): void {
  if (now - lastSweep <= CLIENT_WINDOW_MS) return;
  for (const [k, v] of clientHits) if (!v.some((t) => now - t < CLIENT_WINDOW_MS)) clientHits.delete(k);
  for (const [k, v] of ipHits) if (!v.some((t) => now - t < IP_WINDOW_MS)) ipHits.delete(k);
  lastSweep = now;
}

/** Counts one write from this IP, or refuses it. */
function limitIp(ip: string, now: number): void {
  sweep(now);
  const byIp = recent(ipHits, ip, IP_WINDOW_MS, now);
  if (byIp.length >= IP_LIMIT) throw new LiveError('Too many answers from this network. Try again in a minute.', 429);
  byIp.push(now);
}

/** Counts one answer or vote from this phone, or refuses it. */
function limitDevice(code: string, device: string, gapMs: number, now: number): void {
  const byDevice = recent(clientHits, `${code}|${device}`, CLIENT_WINDOW_MS, now);
  if (byDevice.length && now - byDevice[byDevice.length - 1]! < gapMs) {
    throw new LiveError('One moment — you just sent one.', 429);
  }
  if (byDevice.length >= CLIENT_LIMIT) throw new LiveError('That is a lot of answers. Give someone else a turn.', 429);
  byDevice.push(now);
}

export async function submitLiveAnswer(
  code: string,
  input: { text?: unknown; name?: unknown },
  device: string,
  ip: string,
): Promise<LiveAnswer> {
  const h = await mustHold(code);
  if (h.q.kind === 'poll') throw new LiveError('This is a poll: pick an option.');
  if (h.q.kind === 'form') throw new LiveError('This is a form: send it whole to /submit.');
  if (!h.q.open) throw new LiveError('This question is closed.', 409);
  const text = cleanLiveText(input.text, LIVE_TEXT_MAX);
  if (!text) throw new LiveError('Write an answer first.');
  const name = cleanLiveText(input.name, LIVE_NAME_MAX);
  // A hidden answer still counts: hiding it is the presenter's call, not a second chance.
  if (h.q.onePerPerson && h.q.answers.some((a) => a.device === device)) {
    throw new LiveError('You’ve already answered this one.', 409);
  }
  if (h.q.answers.length >= MAX_ANSWERS) throw new LiveError('This question has all the answers it can take.', 409);
  const now = Date.now();
  limitIp(ip, now);
  limitDevice(code, device, CLIENT_GAP_MS, now);

  const answer: LiveAnswer = { id: randomBytes(6).toString('base64url'), name, text, createdAt: now, hidden: false, device };
  h.q.answers.push(answer);
  await changed(h);
  return answer;
}

/**
 * A vote in a poll. Once per person, a second vote replaces the first — changing
 * your mind is fine, voting twice is not. Otherwise every vote counts.
 */
export async function castLiveVote(code: string, option: unknown, device: string, ip: string): Promise<{ option: number; changed: boolean }> {
  const h = await mustHold(code);
  const q = h.q;
  if (q.kind !== 'poll') throw new LiveError('This question takes written answers, not votes.');
  if (!q.open) throw new LiveError('This poll is closed.', 409);
  const index = typeof option === 'number' ? option : Number.NaN;
  if (!Number.isInteger(index) || index < 0 || index >= (q.options?.length ?? 0)) throw new LiveError('Pick one of the options.');
  const votes = (q.votes ??= []);
  const now = Date.now();
  limitIp(ip, now);
  const mine = q.onePerPerson ? votes.find((v) => v.device === device) : undefined;
  if (mine?.option === index) return { option: index, changed: false };
  // Changing a vote is quicker to allow than a fresh answer: a mis-tap is fixed at once.
  limitDevice(code, device, mine ? 500 : 1_000, now);
  if (votes.length >= MAX_ANSWERS * 5 && !mine) throw new LiveError('This poll has all the votes it can take.', 409);
  if (mine) { mine.option = index; mine.at = now; } else votes.push({ device, option: index, at: now });
  await changed(h);
  return { option: index, changed: !!mine };
}

/**
 * A filled-in form. Once per person, a second submission from the same phone
 * replaces the first (editing your answers is fine, answering twice is not);
 * a written answer the presenter hid stays hidden. Otherwise every one counts.
 */
export async function submitLiveForm(code: string, values: unknown, device: string, ip: string): Promise<{ id: string; replaced: boolean }> {
  const h = await mustHold(code);
  const q = h.q;
  if (q.kind !== 'form') throw new LiveError('This question is not a form.');
  if (!q.open) throw new LiveError('This form is closed.', 409);
  const clean = cleanFormValues(q.fields ?? [], values);
  if (typeof clean === 'string') throw new LiveError(clean);
  const subs = (q.submissions ??= []);
  const mine = q.onePerPerson ? subs.find((s) => s.device === device) : undefined;
  if (!mine && subs.length >= MAX_ANSWERS) throw new LiveError('This form has all the responses it can take.', 409);
  const now = Date.now();
  limitIp(ip, now);
  limitDevice(code, device, mine ? 1_000 : CLIENT_GAP_MS, now);
  if (mine) {
    mine.values = clean;
    mine.updatedAt = now;
  } else {
    subs.push({ id: randomBytes(6).toString('base64url'), device, createdAt: now, values: clean });
  }
  await changed(h);
  return { id: (mine ?? subs[subs.length - 1]!).id, replaced: !!mine };
}

/** Likes or unlikes an answer on a votable question: one like per answer per phone. */
export async function likeLiveAnswer(code: string, answerId: string, liked: boolean, device: string, ip: string): Promise<number> {
  const h = await mustHold(code);
  if (!h.q.votable) throw new LiveError('This question does not take votes on answers.');
  if (!h.q.open) throw new LiveError('This question is closed.', 409);
  const answer = h.q.answers.find((a) => a.id === answerId && !a.hidden);
  if (!answer) throw new LiveError('No such answer.', 404);
  if (answer.device === device && liked) throw new LiveError('That one is yours — vote for someone else’s.', 409);
  limitIp(ip, Date.now());
  const likes = (answer.likes ??= []);
  const has = likes.includes(device);
  if (liked !== has) {
    if (liked) likes.push(device); else likes.splice(likes.indexOf(device), 1);
    await changed(h);
  }
  return likes.length;
}

/** What the answer page needs to know about this phone. */
export async function deviceView(code: string, device: string) {
  const h = await mustHold(code);
  const q = h.q;
  const mine = q.answers.filter((a) => a.device === device);
  if (q.kind === 'form') {
    const sub = q.submissions?.findLast((s) => s.device === device);
    return {
      open: q.open, kind: 'form' as const, onePerPerson: !!q.onePerPerson, answered: !!sub, vote: null,
      // What "Edit my answers" fills the form with.
      values: q.onePerPerson && sub ? sub.values : null,
      answers: undefined,
    };
  }
  return {
    open: q.open,
    kind: q.kind ?? 'text',
    onePerPerson: !!q.onePerPerson,
    answered: q.kind === 'poll' ? !!q.votes?.some((v) => v.device === device) : mine.length > 0,
    vote: q.kind === 'poll' && q.onePerPerson ? (q.votes?.find((v) => v.device === device)?.option ?? null) : null,
    answers: q.votable
      ? visibleAnswers(q).slice(0, 200).map((a) => ({
        id: a.id, name: a.name, text: a.text, likes: a.likes?.length ?? 0,
        liked: !!a.likes?.includes(device), mine: a.device === device,
      }))
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Board state
// ---------------------------------------------------------------------------

/** What the board draws. Never carries the document id or a device. */
export interface BoardState {
  v: number;
  kind: LiveKind;
  question: string;
  open: boolean;
  votable: boolean;
  /** Whether the board shows the QR code and short URL. */
  qr: boolean;
  /** Visible answers, or votes cast in a poll. */
  total: number;
  answers: { id: string; name: string; text: string; likes: number }[];
  options: { label: string; count: number; percent: number }[];
  /** A form's fields with their results; written answers visible only, `shown` of them in all. */
  fields: (LiveFieldSummary & { shown?: number })[];
}

/** More than this is never shown at once; the board says how many there are. */
const BOARD_MAX = 120;

function boardState(h: Held): BoardState {
  const q = h.q;
  if (q.kind === 'form') {
    return {
      v: h.version, kind: 'form', question: q.question, open: q.open, votable: false, qr: q.qr !== false,
      total: q.submissions?.length ?? 0,
      answers: [],
      options: [],
      fields: formSummary(q).filter((f) => f.onBoard).map((f) => {
        if (!f.answers) return f;
        const visible = f.answers.filter((a) => !a.hidden);
        return { ...f, shown: visible.length, answers: visible.slice(0, BOARD_MAX) };
      }),
    };
  }
  if (q.kind === 'poll') {
    const counts = pollCounts(q);
    const percents = pollPercentages(counts);
    return {
      v: h.version, kind: 'poll', question: q.question, open: q.open, votable: false, qr: q.qr !== false,
      total: counts.reduce((a, b) => a + b, 0),
      answers: [],
      options: (q.options ?? []).map((label, i) => ({ label, count: counts[i]!, percent: percents[i]! })),
      fields: [],
    };
  }
  const visible = visibleAnswers(q);
  return {
    v: h.version, kind: 'text', question: q.question, open: q.open, votable: !!q.votable, qr: q.qr !== false,
    total: visible.length,
    answers: visible.slice(0, BOARD_MAX).map(({ id, name, text, likes }) => ({ id, name, text, likes: likes?.length ?? 0 })),
    options: [],
    fields: [],
  };
}

/** A question as a moderator or an agent sees it: counts, never device ids. */
export function moderatorView(q: LiveQuestion) {
  const counts = q.kind === 'poll' ? pollCounts(q) : [];
  return {
    code: q.code,
    question: q.question,
    kind: q.kind ?? 'text',
    open: q.open,
    onePerPerson: !!q.onePerPerson,
    votable: !!q.votable,
    qr: q.qr !== false,
    createdAt: q.createdAt,
    ...(q.kind === 'poll'
      ? {
        options: (q.options ?? []).map((label, i) => ({ label, votes: counts[i]!, percent: pollPercentages(counts)[i]! })),
        totalVotes: q.votes?.length ?? 0,
      }
      : {}),
    ...(q.kind === 'form'
      ? {
        fields: formSummary(q),
        totalResponses: q.submissions?.length ?? 0,
        // Oldest first; a choice reads as its label, so nobody has to look an index up.
        submissions: (q.submissions ?? []).map((s) => ({
          id: s.id,
          createdAt: s.createdAt,
          ...(s.updatedAt ? { updatedAt: s.updatedAt } : {}),
          values: Object.fromEntries((q.fields ?? []).filter((f) => s.values[f.id] !== undefined).map((f) => [
            f.id, f.type === 'choice' ? (f.options?.[Number(s.values[f.id])] ?? s.values[f.id]) : s.values[f.id],
          ])),
          hidden: s.hidden ?? [],
        })),
      }
      : {}),
    answers: q.answers.map((a) => ({
      id: a.id, name: a.name, text: a.text, createdAt: a.createdAt, hidden: a.hidden,
      ...(q.votable ? { likes: a.likes?.length ?? 0 } : {}),
    })),
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
  /** "0" or "false" hides the QR block whatever the question says. */
  qr?: string;
  /** "0" hides the question heading, for a slide that carries the question as its own title. */
  title?: string;
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
    qr: look.qr === '0' || look.qr === 'false' ? '0' : '1',
    title: look.title === '0' || look.title === 'false' ? '0' : '1',
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
  [hidden] { display: none !important; }
  html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; }
  body { font-family: ${fontStack(l.font)}; color: var(--ink); -webkit-font-smoothing: antialiased; }
  .board { position: absolute; inset: 0; display: flex; flex-direction: column; gap: 3.2vmin; padding: 0; }
  .head { display: flex; gap: 4vmin; align-items: flex-start; justify-content: space-between; }
  .q { margin: 0; font-size: clamp(18px, 5.4vmin, 120px); line-height: 1.12; font-weight: 700; letter-spacing: -0.02em; text-wrap: balance; }
  .meta { margin-top: 1.6vmin; font-size: clamp(11px, 2.1vmin, 40px); opacity: .6; font-weight: 500; }
  .meta b { color: var(--accent); opacity: 1; font-weight: 700; }
  .scan { flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 1vmin; }
  .scan svg { width: 22vmin; height: 22vmin; display: block; border-radius: 1.2vmin; }
  .scan span { font-size: clamp(9px, 1.7vmin, 32px); font-weight: 600; white-space: nowrap; letter-spacing: .01em; }
  .closed .scan svg { opacity: .25; }
  .grid { flex: 1; min-height: 0; display: grid; align-content: start; overflow: hidden; }
  .card { position: relative; background: var(--card); border-radius: .7em; padding: .7em .9em .8em; min-width: 0;
          animation: in .4s cubic-bezier(.2,.8,.2,1); }
  .card .who { font-size: .6em; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: var(--accent); margin-bottom: .35em;
               white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .card .text { line-height: 1.3; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
  .card .likes { margin-top: .45em; font-size: .62em; font-weight: 700; color: var(--accent); font-variant-numeric: tabular-nums; }
  .card .x { display: none; position: absolute; top: .3em; right: .3em; border: 0; border-radius: 99px; width: 1.4em; height: 1.4em;
             font: inherit; font-size: .7em; line-height: 1; cursor: pointer; background: var(--ink); color: #fff; }
  .mod .card:hover .x { display: block; }
  .empty { grid-column: 1 / -1; font-size: clamp(12px, 2.6vmin, 48px); opacity: .45; padding-top: 2vmin; }
  .more { grid-column: 1 / -1; font-size: .7em; opacity: .55; font-weight: 600; }
  .poll { flex: 1; min-height: 0; display: flex; flex-direction: column; justify-content: center; gap: 1.1em; }
  .opt { display: grid; grid-template-columns: 1fr auto; align-items: baseline; row-gap: .35em; column-gap: 1em; }
  .opt .label { font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .opt .num { font-weight: 700; font-variant-numeric: tabular-nums; }
  .opt .num small { font-size: .62em; font-weight: 600; opacity: .55; margin-left: .5em; }
  .opt .track { grid-column: 1 / -1; height: .9em; border-radius: 99px; background: var(--card); overflow: hidden; }
  .opt .bar { height: 100%; width: 0; border-radius: 99px; background: var(--accent); transition: width .7s cubic-bezier(.2,.8,.2,1); }
  .opt.lead .bar { box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 40%, transparent); }
  .form { flex: 1; min-height: 0; display: flex; gap: 2.2em; }
  .form .sums { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 1.5em; overflow: hidden; }
  .form.split .sums { flex: 0 0 34%; }
  .form.only-sums .sums { flex-direction: row; gap: 2.4em; }
  .form.only-sums .sums > .fld { flex: 1 1 0; }
  .form .texts { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 1.2em; }
  .fld { min-width: 0; }
  .fld .lbl { font-size: .72em; font-weight: 600; line-height: 1.25; opacity: .7; margin-bottom: .55em; text-wrap: balance; }
  .fld .avg { font-weight: 700; line-height: .95; font-variant-numeric: tabular-nums; letter-spacing: -0.03em; white-space: nowrap; }
  .fld .avg b { font-size: 3.2em; color: var(--accent); }
  .fld .avg span { font-size: 1.3em; opacity: .45; margin-left: .15em; }
  .fld .avg small { display: block; margin-top: .55em; font-size: .55em; font-weight: 600; opacity: .55; letter-spacing: 0; }
  .dist { display: flex; gap: .25em; align-items: flex-end; height: 2.2em; margin-top: .7em; }
  .dist i { flex: 1; min-height: 3px; height: 0; border-radius: .18em .18em .06em .06em; background: var(--accent); transition: height .7s cubic-bezier(.2,.8,.2,1); }
  .dist i.zero { background: var(--card); }
  .nums { display: flex; gap: .25em; margin-top: .3em; font-size: .5em; font-weight: 600; opacity: .5; font-variant-numeric: tabular-nums; }
  .nums span { flex: 1; text-align: center; }
  .ends { display: flex; justify-content: space-between; gap: 1em; margin-top: .25em; font-size: .5em; opacity: .55; font-weight: 500; }
  .fld .opts { display: flex; flex-direction: column; gap: .7em; font-size: .9em; }
  .fld .opt .track { height: .55em; }
  .fld.text { flex: 1 1 0; min-height: 0; display: flex; flex-direction: column; }
  .fld.text .cards { flex: 1; min-height: 0; display: grid; align-content: start; overflow: hidden; }
  .tools { display: none; position: absolute; right: 0; bottom: 0; gap: 6px; font: 600 12px ui-sans-serif, system-ui, sans-serif; }
  .mod:hover .tools { display: flex; }
  .tools button { border: 0; border-radius: 99px; padding: 7px 12px; cursor: pointer; font: inherit; background: #111114; color: #fff; box-shadow: 0 2px 8px rgba(0,0,0,.2); }
  @keyframes in { from { opacity: 0; transform: translateY(8px) scale(.98); } }
</style></head>
<body>
<div class="board" id="board">${l.title === '0' ? '<style>#q{display:none}</style>' : ''}
  <div class="head">
    <div><h1 class="q" id="q">${esc(q.question)}</h1><div class="meta" id="meta"></div></div>
    <div class="scan" id="scan"${l.qr === '0' || q.qr === false ? ' style="display:none"' : ''}>${qrSvg(url)}<span>${esc(shortAnswerUrl(publicUrl, q.code))}</span></div>
  </div>
  <div class="grid" id="grid"></div>
  <div class="poll" id="poll" hidden></div>
  <div class="form" id="form" hidden></div>
  <div class="tools"><button id="toggle"></button><button id="clear"></button><button id="controls">Open controls</button></div>
</div>
<script>
${liveBoardFit.toString()}
const code = ${scriptJson(q.code)};
const qrOff = ${scriptJson(look.qr === '0' || look.qr === 'false')};
let state = ${scriptJson(boardState(h))};
const board = document.getElementById('board');
const grid = document.getElementById('grid');
const pollBox = document.getElementById('poll');
const formBox = document.getElementById('form');
let canModerate = false;

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

function render() {
  const isPoll = state.kind === 'poll';
  const isForm = state.kind === 'form';
  document.getElementById('q').textContent = state.question;
  board.classList.toggle('closed', !state.open);
  // Without the QR block the question and answers take the full width.
  document.getElementById('scan').hidden = qrOff || state.qr === false;
  const meta = document.getElementById('meta');
  meta.textContent = '';
  const one = state.total === 1;
  const noun = isPoll ? (one ? ' vote' : ' votes') : isForm ? (one ? ' response' : ' responses') : (one ? ' answer' : ' answers');
  meta.append(el('b', null, String(state.total)), noun, state.open ? '' : ' · closed');
  document.getElementById('toggle').textContent = state.open ? (isPoll ? 'Close poll' : isForm ? 'Close form' : 'Close question') : 'Reopen';
  document.getElementById('clear').textContent = isPoll ? 'Reset votes' : 'Clear all';
  grid.hidden = isPoll || isForm;
  pollBox.hidden = !isPoll;
  formBox.hidden = !isForm;
  if (isPoll) renderPoll(); else if (isForm) renderForm(); else renderCards();
}

/*
 * A form: ratings and choices as numbers and bars in one column, written
 * answers as cards beside them. The skeleton is kept while the fields stay the
 * same, so bars grow from where they were when a response arrives.
 */
function renderForm() {
  const fields = state.fields || [];
  const sums = fields.filter((f) => f.type !== 'text');
  const texts = fields.filter((f) => f.type === 'text');
  const sig = fields.map((f) => f.id + ':' + f.type + ':' + (f.max || (f.options || []).length)).join('|');
  if (formBox.dataset.sig !== sig) {
    formBox.dataset.sig = sig;
    formBox.textContent = '';
    formBox.className = 'form' + (sums.length && texts.length ? ' split' : sums.length ? ' only-sums' : ' only-texts');
    const sumCol = el('div', 'sums');
    const textCol = el('div', 'texts');
    sumCol.hidden = !sums.length;
    textCol.hidden = !texts.length;
    for (const f of fields) {
      const box = el('div', 'fld ' + f.type);
      box.dataset.id = f.id;
      box.append(el('div', 'lbl'));
      if (f.type === 'rating') {
        box.append(el('div', 'avg'));
        const dist = el('div', 'dist'), nums = el('div', 'nums');
        for (let i = 1; i <= f.max; i++) { dist.append(el('i')); nums.append(el('span', null, String(i))); }
        box.append(dist, nums);
        if (f.lowLabel || f.highLabel) { const ends = el('div', 'ends'); ends.append(el('span', null, f.lowLabel || ''), el('span', null, f.highLabel || '')); box.append(ends); }
      } else if (f.type === 'choice') {
        const opts = el('div', 'opts');
        for (const _ of f.options) {
          const row = el('div', 'opt');
          row.append(el('div', 'label'), el('div', 'num'));
          const track = el('div', 'track'); track.append(el('div', 'bar')); row.append(track);
          opts.append(row);
        }
        box.append(opts);
      } else {
        box.append(el('div', 'cards'));
      }
      (f.type === 'text' ? textCol : sumCol).append(box);
    }
    formBox.append(sumCol, textCol);
  }
  const rect = formBox.getBoundingClientRect();
  const w = rect.width || innerWidth, h = rect.height || innerHeight * 0.65;
  let size = Math.max(11, Math.min(w / (texts.length && sums.length ? 46 : 52), h / 16));
  formBox.style.fontSize = Math.round(size) + 'px';
  for (const f of fields) {
    const box = formBox.querySelector('[data-id="' + CSS.escape(f.id) + '"]');
    box.querySelector('.lbl').textContent = f.label;
    if (f.type === 'rating') {
      const avg = box.querySelector('.avg');
      avg.textContent = '';
      avg.append(el('b', null, f.average == null ? '–' : f.average.toFixed(1)), el('span', null, '/ ' + f.max),
        el('small', null, f.responses + (f.responses === 1 ? ' rating' : ' ratings')));
      const top = Math.max(1, ...f.distribution);
      [...box.querySelectorAll('.dist i')].forEach((bar, i) => {
        const n = f.distribution[i] || 0;
        bar.title = n + ' × ' + (i + 1);
        bar.classList.toggle('zero', !n);
        requestAnimationFrame(() => { bar.style.height = (n ? Math.max(8, (n / top) * 100) : 0) + '%'; });
      });
    } else if (f.type === 'choice') {
      const best = Math.max(...f.options.map((o) => o.count));
      [...box.querySelectorAll('.opt')].forEach((row, i) => {
        const o = f.options[i];
        row.classList.toggle('lead', o.count > 0 && o.count === best);
        row.querySelector('.label').textContent = o.label;
        const num = row.querySelector('.num');
        num.textContent = String(o.count);
        num.append(el('small', null, o.percent + '%'));
        requestAnimationFrame(() => { row.querySelector('.bar').style.width = o.percent + '%'; });
      });
    }
  }
  // The number column shrinks until it fits rather than being cut off.
  const sumCol = formBox.querySelector('.sums');
  for (let i = 0; i < 12 && sums.length && sumCol.scrollHeight > sumCol.clientHeight + 1; i++) {
    size *= 0.92;
    formBox.style.fontSize = Math.round(size) + 'px';
  }
  for (const f of texts) {
    const box = formBox.querySelector('[data-id="' + CSS.escape(f.id) + '"] .cards');
    fillCards(box, f.answers, f.shown, state.open ? 'Answers will appear here.' : 'No answers.', false);
  }
}

/*
 * Rows are kept between renders and only their numbers change, so a new vote
 * slides the bar from where it was instead of redrawing it from zero.
 */
function renderPoll() {
  const n = Math.max(2, state.options.length);
  const box = pollBox.getBoundingClientRect();
  const h = box.height || innerHeight * 0.6;
  pollBox.style.fontSize = Math.round(Math.max(14, Math.min(h / (n * 3.8), (box.width || innerWidth) / 22))) + 'px';
  const top = Math.max(...state.options.map((o) => o.count));
  if (pollBox.children.length !== state.options.length) {
    pollBox.textContent = '';
    for (const o of state.options) {
      const row = el('div', 'opt');
      row.append(el('div', 'label'), el('div', 'num'));
      const track = el('div', 'track');
      track.append(el('div', 'bar'));
      row.append(track);
      pollBox.append(row);
    }
  }
  state.options.forEach((o, i) => {
    const row = pollBox.children[i];
    row.classList.toggle('lead', o.count > 0 && o.count === top);
    row.querySelector('.label').textContent = o.label;
    const num = row.querySelector('.num');
    num.textContent = String(o.count);
    num.append(el('small', null, o.percent + '%'));
    // Set after layout so the width transition runs on first paint too.
    requestAnimationFrame(() => { row.querySelector('.bar').style.width = o.percent + '%'; });
  });
}

function renderCards() {
  fillCards(grid, state.answers, state.total, state.open ? 'Answers will appear here.' : 'No answers.', state.votable);
}

/** Answer cards into a grid: as many as fit at a readable size, newest first, then "+ N more". */
function fillCards(grid, answers, total, emptyText, votable) {
  const box = grid.getBoundingClientRect();
  const fit = liveBoardFit(answers.length, box.width || innerWidth, box.height || innerHeight * 0.7);
  grid.style.fontSize = fit.fontPx + 'px';
  grid.style.gap = Math.round(fit.fontPx * 0.8) + 'px';
  grid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(' + Math.min(fit.minCardPx, box.width || fit.minCardPx) + 'px, 1fr))';
  const seen = new Set([...grid.querySelectorAll('.card')].map((c) => c.dataset.id));
  grid.textContent = '';
  if (!answers.length) {
    grid.append(el('div', 'empty', emptyText));
    return;
  }
  const shown = answers.slice(0, fit.shown);
  for (const a of shown) {
    const card = el('div', 'card');
    card.dataset.id = a.id;
    if (seen.has(a.id)) card.style.animation = 'none';
    if (a.name) card.append(el('div', 'who', a.name));
    card.append(el('div', 'text', a.text));
    if (votable) card.append(el('div', 'likes', '♥ ' + a.likes));
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
  let rest = total - cards.length;
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
// The board never knows its document; the server resolves it for someone allowed to see it.
document.getElementById('controls').onclick = () => window.open('/api/live/' + code + '/controls', '_blank');
document.getElementById('clear').onclick = () => {
  const ask = state.kind === 'poll' ? 'Reset every vote to zero?'
    : state.kind === 'form' ? 'Hide every written answer? They stay stored; ratings and choices stay counted.' : 'Hide every answer? They stay stored.';
  if (confirm(ask)) moderate('/clear');
};

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

/** A form's fields as phone controls, in order. */
function formFieldsHtml(q: LiveQuestion): string {
  return (q.fields ?? []).map((f) => {
    const head = `<legend>${esc(f.label)} <span class="req">${f.required ? 'required' : 'optional'}</span></legend>`;
    let control = '';
    if (f.type === 'rating') {
      const max = f.max ?? 5;
      control = `<div class="scale" style="--n:${max}">${Array.from({ length: max }, (_, i) =>
        `<button type="button" class="pip" data-v="${i + 1}" aria-pressed="false" aria-label="${i + 1} of ${max}">${i + 1}</button>`).join('')}</div>`
        + (f.lowLabel || f.highLabel ? `<div class="ends"><span>${esc(f.lowLabel ?? '')}</span><span>${esc(f.highLabel ?? '')}</span></div>` : '');
    } else if (f.type === 'choice') {
      control = `<div class="fchoices">${(f.options ?? []).map((o, i) =>
        `<button type="button" class="fchoice" data-v="${i}" aria-pressed="false">${esc(o)}</button>`).join('')}</div>`;
    } else {
      control = `<textarea maxlength="${LIVE_TEXT_MAX}" rows="4" placeholder="Type here…" aria-label="${esc(f.label)}"></textarea>`
        + `<div class="count"><span class="n">0</span> / ${LIVE_TEXT_MAX}</div>`;
    }
    return `<fieldset class="field" data-id="${esc(f.id)}" data-type="${f.type}" data-label="${esc(f.label)}"${f.required ? ' data-required="1"' : ''}>${head}${control}</fieldset>`;
  }).join('\n    ');
}

export function answerPageHtml(q: LiveQuestion | null, code: string): string {
  const poll = q?.kind === 'poll';
  const isForm = q?.kind === 'form';
  const body = q
    ? `<main>
  <p class="eyebrow">${poll ? 'Live poll' : isForm ? 'Live feedback' : 'Live question'}</p>
  <h1>${esc(q.question)}</h1>
  <form id="form" hidden>
    <label>Your answer<textarea id="text" name="text" maxlength="${LIVE_TEXT_MAX}" rows="5" required placeholder="Type here…"></textarea></label>
    <div class="count"><span id="count">0</span> / ${LIVE_TEXT_MAX}</div>
    <label>Team or name <span class="opt">optional</span><input id="name" name="name" maxlength="${LIVE_NAME_MAX}" autocomplete="nickname"></label>
    <button type="submit" id="send">Send answer</button>
  </form>
  <form id="fform" class="fform" hidden novalidate>
    ${isForm ? formFieldsHtml(q) : ''}
    <button type="submit" id="fsend">Submit</button>
  </form>
  <section id="choices" class="choices" hidden>
    ${(q.options ?? []).map((o, i) => `<button type="button" class="choice" data-i="${i}">${esc(o)}</button>`).join('\n    ')}
  </section>
  <p class="error" id="error" role="alert"></p>
  <section id="thanks" class="plate" hidden>
    <p class="big" id="thanks-text"></p>
    <button type="button" id="again" class="secondary" hidden></button>
  </section>
  <section id="vote" hidden>
    <h2>Vote for the best answers</h2>
    <ul id="answers"></ul>
  </section>
  <p class="closed" id="closed" hidden>This question is closed.</p>
</main>`
    : `<main><h1>This question is not here.</h1><p>Check the code on the slide — it looks like <b>/q/abcd2345</b>.</p></main>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#e6e9ec">
<title>${q ? esc(q.question) : 'Live question'}</title>
<style>
  :root { color-scheme: light dark; --bg: #e6e9ec; --plate: #fff; --ink: #13202e; --mute: #646a73; --line: #dfe2e6; --wash: #f4f5f6; --cta: #13202e; --cta-ink: #fff; --like: #b5441c; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0d131a; --plate: #1e2026; --ink: #e8edf2; --mute: #a2a9b3; --line: #3a3e46; --wash: #262931; --cta: #dfe6ee; --cta-ink: #13202e; --like: #f4a27d; } }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  body { margin: 0; min-height: 100dvh; background: var(--bg); color: var(--ink);
         font: 16px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; -webkit-font-smoothing: antialiased; }
  main { max-width: 34rem; margin: 0 auto; padding: max(28px, env(safe-area-inset-top)) 16px 40px; }
  .eyebrow { margin: 0 0 8px; font-size: 13px; font-weight: 500; color: var(--mute); }
  h1 { margin: 0 0 24px; font-size: 28px; line-height: 1.15; font-weight: 700; letter-spacing: -0.02em; text-wrap: balance; }
  h2 { margin: 28px 0 12px; font-size: 15px; font-weight: 700; color: var(--mute); }
  form, .plate { background: var(--plate); border-radius: 24px; padding: 20px; box-shadow: 0 1px 2px rgb(19 32 46 / .04); }
  label { display: block; font-size: 14px; font-weight: 600; margin-bottom: 14px; }
  .opt { font-weight: 400; color: var(--mute); }
  textarea, input { display: block; width: 100%; margin-top: 6px; padding: 12px 14px; border: 1.5px solid transparent; border-radius: 14px;
                    background: var(--wash); color: inherit; font-size: 17px; line-height: 1.4; font-family: inherit; resize: vertical; }
  textarea:focus, input:focus { outline: 2px solid var(--ink); outline-offset: 1px; border-color: transparent; }
  .count { margin: -8px 0 14px; text-align: right; font-size: 12px; color: var(--mute); font-variant-numeric: tabular-nums; }
  button { width: 100%; min-height: 52px; border: 0; border-radius: 14px; background: var(--cta); color: var(--cta-ink); font-size: 17px; font-weight: 600; font-family: inherit; cursor: pointer; }
  button:disabled { opacity: .5; }
  button.secondary { background: transparent; color: var(--ink); box-shadow: inset 0 0 0 1px var(--line); }
  .choices { display: grid; gap: 12px; }
  .choice { min-height: 64px; border-radius: 16px; background: var(--plate); color: var(--ink); font-size: 18px; text-align: left; padding: 0 20px;
            box-shadow: inset 0 0 0 1.5px var(--line); }
  .choice.mine { background: var(--cta); color: var(--cta-ink); }
  .error { min-height: 1.2em; margin: 10px 0; color: var(--like); font-size: 14px; }
  .big { font-size: 20px; font-weight: 600; margin: 4px 0 18px; }
  .big:last-child { margin-bottom: 4px; }
  .closed { color: var(--mute); }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
  li { display: flex; gap: 12px; align-items: center; background: var(--plate); border-radius: 16px; padding: 12px 12px 12px 16px; box-shadow: inset 0 0 0 1.5px var(--line); }
  li .t { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  li .n { display: block; font-size: 12px; font-weight: 700; color: var(--mute); text-transform: uppercase; letter-spacing: .06em; }
  .heart { flex: none; width: auto; min-width: 64px; min-height: 44px; padding: 0 12px; background: transparent; color: var(--ink);
           box-shadow: inset 0 0 0 1px var(--line); font-size: 15px; font-variant-numeric: tabular-nums; }
  .heart.on { color: var(--like); box-shadow: inset 0 0 0 1px var(--like); }
  form.fform { display: grid; gap: 14px; background: none; padding: 0; box-shadow: none; border-radius: 0; }
  .field { min-width: 0; margin: 0; border: 0; padding: 20px; background: var(--plate); border-radius: 24px;
           box-shadow: 0 1px 2px rgb(19 32 46 / .04); }
  .field legend { float: left; width: 100%; padding: 0; margin: 0 0 14px; font-size: 17px; font-weight: 650; line-height: 1.3; }
  .field legend + * { clear: both; }
  .req { font-size: 12px; font-weight: 500; color: var(--mute); margin-left: 4px; }
  .field.missing { background: repeating-linear-gradient(-55deg, var(--wash) 0 14px, var(--plate) 14px 28px); box-shadow: inset 0 0 0 2px var(--like); }
  .scale { display: grid; grid-template-columns: repeat(var(--n), minmax(0, 1fr)); gap: 6px; }
  .pip { min-height: 52px; padding: 0; border-radius: 14px; background: transparent; color: var(--ink); box-shadow: inset 0 0 0 1px var(--line);
         font-size: 18px; font-variant-numeric: tabular-nums; }
  .ends { display: flex; justify-content: space-between; gap: 12px; margin-top: 8px; font-size: 13px; color: var(--mute); }
  .ends span:last-child { text-align: right; }
  .fchoices { display: grid; gap: 10px; }
  .fchoice { min-height: 56px; border-radius: 16px; padding: 0 18px; text-align: left; background: transparent; color: var(--ink);
             box-shadow: inset 0 0 0 1px var(--line); font-size: 18px; }
  .pip.on, .fchoice.on { background: var(--cta); color: var(--cta-ink); box-shadow: none; }
  .field textarea { margin-top: 0; }
  .field .count { margin: 6px 0 0; }
</style></head>
<body>${body}
${q ? `<script>
const code = ${scriptJson(code)};
const options = ${scriptJson(q.options ?? [])};
const $ = (id) => document.getElementById(id);
const form = $('form'), text = $('text'), name = $('name'), err = $('error'), thanks = $('thanks'), again = $('again');
let device = '';
let me = null;
let changing = false;
try { device = localStorage.getItem('live-device') || ''; name.value = localStorage.getItem('live-name') || ''; } catch {}

/** Every request carries the device the page kept, in case the cookie was cleared. */
async function call(path, body) {
  const r = await fetch('/q/' + code + path, {
    method: body ? 'POST' : 'GET', cache: 'no-store',
    headers: { 'content-type': 'application/json', 'x-live-device': device }, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (data.device && data.device !== device) { device = data.device; try { localStorage.setItem('live-device', device); } catch {} }
  if (!r.ok) throw new Error(data.error || 'That did not send. Try again.');
  return data;
}

function show() {
  if (!me) return;
  if (me.kind === 'form') {
    const done = me.answered && !changing;
    $('closed').hidden = me.open;
    form.hidden = true; $('choices').hidden = true; $('vote').hidden = true;
    fform.hidden = !me.open || done;
    thanks.hidden = !done;
    if (done) {
      $('thanks-text').textContent = 'Thanks — you’ve answered.';
      again.hidden = !me.open;
      again.textContent = me.onePerPerson ? 'Edit my answers' : 'Answer again';
    }
    return;
  }
  const poll = me.kind === 'poll';
  const done = me.answered && me.onePerPerson && !changing;
  $('closed').hidden = me.open;
  form.hidden = poll || !me.open || done || (me.answered && !changing && !me.onePerPerson);
  $('choices').hidden = !poll || !me.open || (me.answered && !changing);
  thanks.hidden = !me.answered || changing;
  if (me.answered) {
    if (poll && me.vote != null) $('thanks-text').textContent = 'Thanks — you voted for “' + options[me.vote] + '”.';
    else $('thanks-text').textContent = me.onePerPerson ? 'Thanks — you’ve answered.' : 'Thanks — it’s on the screen.';
    again.hidden = !me.open;
    again.textContent = poll ? (me.onePerPerson ? 'Change my vote' : 'Vote again') : 'Answer again';
    if (!poll && me.onePerPerson) again.hidden = true;
  }
  for (const b of document.querySelectorAll('.choice')) b.classList.toggle('mine', Number(b.dataset.i) === me.vote);
  $('vote').hidden = !me.answers || !me.answered;
  if (me.answers && me.answered) renderAnswers();
}

function renderAnswers() {
  const list = $('answers');
  list.textContent = '';
  for (const a of me.answers) {
    const li = document.createElement('li');
    const t = document.createElement('div');
    t.className = 't';
    if (a.name) { const n = document.createElement('span'); n.className = 'n'; n.textContent = a.name; t.append(n); }
    t.append(a.text);
    li.append(t);
    if (!a.mine) {
      const b = document.createElement('button');
      b.className = 'heart' + (a.liked ? ' on' : '');
      b.textContent = (a.liked ? '♥ ' : '♡ ') + a.likes;
      b.setAttribute('aria-pressed', String(a.liked));
      b.onclick = async () => {
        b.disabled = true;
        try { await call('/answers/' + encodeURIComponent(a.id) + '/like', { liked: !a.liked }); await refresh(); }
        catch (e) { err.textContent = e.message; }
        finally { b.disabled = false; }
      };
      li.append(b);
    }
    list.append(li);
  }
}

async function refresh() {
  try { me = await call('/me'); err.textContent = ''; show(); } catch (e) { err.textContent = e.message; }
}

text.addEventListener('input', () => { $('count').textContent = text.value.length; });
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  err.textContent = '';
  $('send').disabled = true;
  try {
    await call('/answers', { text: text.value, name: name.value });
    try { localStorage.setItem('live-name', name.value); } catch {}
    text.value = ''; $('count').textContent = '0';
    changing = false;
    await refresh();
  } catch (e) { err.textContent = e.message; }
  finally { $('send').disabled = false; }
});
for (const b of document.querySelectorAll('.choice')) {
  b.addEventListener('click', async () => {
    err.textContent = '';
    try { await call('/vote', { option: Number(b.dataset.i) }); changing = false; await refresh(); }
    catch (e) { err.textContent = e.message; }
  });
}
again.addEventListener('click', () => {
  changing = true; err.textContent = '';
  if (me && me.kind === 'form') prefill(me.onePerPerson ? me.values : null);
  show();
  if (!form.hidden) text.focus();
});

// A form: one value per field, sent whole.
const fform = $('fform');
let fvals = {};
const fields = [...document.querySelectorAll('.field')];
function paint() {
  for (const fs of fields) {
    for (const b of fs.querySelectorAll('[data-v]')) {
      const on = fvals[fs.dataset.id] === Number(b.dataset.v);
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
  }
}
function prefill(values) {
  fvals = Object.assign({}, values || {});
  for (const fs of fields) {
    const ta = fs.querySelector('textarea');
    if (ta) { ta.value = fvals[fs.dataset.id] || ''; fs.querySelector('.n').textContent = ta.value.length; }
    fs.classList.remove('missing');
  }
  paint();
}
for (const fs of fields) {
  const id = fs.dataset.id;
  for (const b of fs.querySelectorAll('[data-v]')) {
    b.addEventListener('click', () => {
      const v = Number(b.dataset.v);
      if (fvals[id] === v) delete fvals[id]; else fvals[id] = v;
      fs.classList.remove('missing');
      paint();
    });
  }
  const ta = fs.querySelector('textarea');
  if (ta) ta.addEventListener('input', () => { fvals[id] = ta.value; fs.querySelector('.n').textContent = ta.value.length; fs.classList.remove('missing'); });
}
fform.addEventListener('submit', async (e) => {
  e.preventDefault();
  err.textContent = '';
  const missing = fields.filter((fs) => fs.dataset.required && (fvals[fs.dataset.id] === undefined || String(fvals[fs.dataset.id]).trim() === ''));
  for (const fs of fields) fs.classList.toggle('missing', missing.includes(fs));
  if (missing.length) {
    err.textContent = '“' + missing[0].dataset.label + '” needs an answer.';
    missing[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  $('fsend').disabled = true;
  try { await call('/submit', { values: fvals }); changing = false; await refresh(); window.scrollTo(0, 0); }
  catch (e) { err.textContent = e.message; }
  finally { $('fsend').disabled = false; }
});
refresh();
// The list of answers to vote on grows while the room writes.
setInterval(() => { if (me && me.answers && me.answered && !document.hidden) refresh(); }, 5000);
</script>` : ''}
</body></html>`;
}

// ---------------------------------------------------------------------------
// Presenter controls
// ---------------------------------------------------------------------------

/**
 * Every live question in a document, in the order the presenter meets them —
 * page, then slide — with the ones no longer on any slide at the end.
 */
export async function liveQuestionsInOrder(doc: CanvasDocument, publicUrl: string) {
  const placed = livePlacements(doc);
  const pageIndex = new Map(doc.pages.map((p, i) => [p.id, i]));
  const all = await liveQuestionsFor(doc.id);
  const rank = (code: string) => {
    const at = placed.get(code);
    return at ? (pageIndex.get(at.pageId) ?? 0) * 100_000 + at.slide : Number.MAX_SAFE_INTEGER;
  };
  return all
    .sort((a, b) => rank(a.code) - rank(b.code) || a.createdAt - b.createdAt)
    .map((q) => {
      const { answers: _answers, submissions: _submissions, fields, ...view } = moderatorView(q);
      return {
        ...view,
        // The list carries a form's results but not what each person wrote; the detail has those.
        ...(fields ? { fields: fields.map(({ answers: _a, ...f }) => f) } : {}),
        answers: q.kind === 'form' ? (q.submissions?.length ?? 0) : q.answers.length,
        shown: q.kind === 'form' ? (q.submissions?.length ?? 0) : visibleAnswers(q).length,
        url: `${publicUrl}/q/${q.code}`,
        shortUrl: shortAnswerUrl(publicUrl, q.code),
        placement: placed.get(q.code) ?? null,
      };
    });
}

/** Everything said, for after the session: one row per answer, or per option for a poll. */
export function answersCsv(q: LiveQuestion): string {
  const cell = (v: unknown) => {
    const s = String(v ?? '');
    // A leading = + - @ makes a spreadsheet run the cell as a formula.
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  if (q.kind === 'form') {
    const fields = q.fields ?? [];
    const rows: unknown[][] = [
      ['time', 'edited', ...fields.map((f) => f.label), 'hidden'],
      ...(q.submissions ?? []).map((s) => [
        new Date(s.createdAt).toISOString(),
        s.updatedAt ? new Date(s.updatedAt).toISOString() : '',
        ...fields.map((f) => {
          const v = s.values[f.id];
          return v === undefined ? '' : f.type === 'choice' ? (f.options?.[Number(v)] ?? '') : v;
        }),
        fields.filter((f) => s.hidden?.includes(f.id)).map((f) => f.label).join('; '),
      ]),
    ];
    return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
  }
  const rows: unknown[][] = q.kind === 'poll'
    ? [['option', 'votes', 'percent'], ...(q.options ?? []).map((o, i) => [o, pollCounts(q)[i], pollPercentages(pollCounts(q))[i]])]
    : [['time', 'name', 'answer', 'hidden', ...(q.votable ? ['likes'] : [])],
      ...q.answers.map((a) => [new Date(a.createdAt).toISOString(), a.name, a.text, a.hidden ? 'yes' : 'no', ...(q.votable ? [a.likes?.length ?? 0] : [])])];
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

export function controlPageHtml(docId: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>Live questions · controls</title>
<style>
  :root { color-scheme: light dark; --bg: #e6e9ec; --plate: #fff; --ink: #13202e; --mute: #646a73; --line: #ecedef; --wash: #f4f5f6; --cta: #13202e; --cta-ink: #fff;
          --now: #e2531e; --blush: #fbe4dc; --rust: #9c3a16; --accent: #2848c8; --danger: #9c3a16; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0d131a; --plate: #1e2026; --ink: #e8edf2; --mute: #a2a9b3; --line: #2e3138; --wash: #262931; --cta: #dfe6ee; --cta-ink: #13202e;
          --now: #f08a5d; --blush: #3a2219; --rust: #f4a27d; --accent: #a9bcff; --danger: #f4a27d; } }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  body { margin: 0; min-height: 100dvh; background: var(--bg); color: var(--ink);
         font: 15px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; -webkit-font-smoothing: antialiased; }
  main { max-width: 44rem; margin: 16px auto; padding: max(28px, env(safe-area-inset-top)) 28px 48px; background: var(--plate); border-radius: 28px;
         box-shadow: 0 1px 2px rgb(19 32 46 / .04), 0 40px 80px -40px rgb(19 32 46 / .3); }
  @media (max-width: 760px) { main { margin: 0; border-radius: 0; padding: max(20px, env(safe-area-inset-top)) 16px 48px; box-shadow: none; } }
  header { display: flex; align-items: center; gap: 10px; margin-bottom: 20px; min-height: 40px; }
  header h1 { flex: 1; margin: 0; font-size: 34px; line-height: 1.1; font-weight: 700; letter-spacing: -0.02em; min-width: 0; }
  .eyebrow { font-size: 13px; font-weight: 500; color: var(--mute); margin-bottom: 6px; }
  .card { background: var(--plate); border: 1.5px solid var(--line); border-radius: 18px; padding: 16px 18px; margin-bottom: 12px; }
  .card.tap { cursor: pointer; }
  .q { font-size: 17px; font-weight: 650; margin: 2px 0 8px; overflow-wrap: anywhere; }
  .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .chip { font-size: 13px; font-weight: 500; padding: 3px 10px; border-radius: 99px; background: var(--wash); color: var(--mute); }
  .chip.open { background: var(--blush); color: var(--rust); display: inline-flex; align-items: center; gap: 6px; }
  .chip.open::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--now); }
  .count { margin-left: auto; font-weight: 700; font-variant-numeric: tabular-nums; }
  .url { font-size: 13px; color: var(--mute); margin: 8px 0 10px; word-break: break-all; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  button, .btn { appearance: none; border: 0; border-radius: 10px; min-height: 40px; padding: 0 14px; font: inherit; font-weight: 500; cursor: pointer;
                 background: var(--wash); color: var(--ink); text-decoration: none; display: inline-flex; align-items: center; }
  button.primary { background: var(--cta); color: var(--cta-ink); }
  button.danger { color: var(--danger); }
  button:disabled { opacity: .5; }
  .switch { display: inline-flex; align-items: center; gap: 8px; font-weight: 600; cursor: pointer; user-select: none; }
  .switch input { appearance: none; width: 44px; height: 26px; border-radius: 99px; background: color-mix(in srgb, var(--mute) 35%, transparent);
                  position: relative; margin: 0; cursor: pointer; transition: background .2s; }
  .switch input::after { content: ''; position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; border-radius: 50%; background: #fff;
                         box-shadow: 0 1px 2px rgba(0,0,0,.3); transition: transform .2s; }
  .switch input:checked { background: var(--cta); }
  .switch input:checked::after { transform: translateX(18px); }
  .answer { display: flex; gap: 12px; align-items: flex-start; padding: 12px 0; border-top: 1px solid var(--line); }
  .answer:first-child { border-top: 0; }
  .answer .t { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .answer .n { display: block; font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--accent); }
  .answer .m { font-size: 12px; color: var(--mute); }
  .answer.hidden .t { opacity: .45; text-decoration: line-through; }
  .opt { margin: 10px 0 14px; }
  .opt .l { display: flex; justify-content: space-between; font-weight: 600; margin-bottom: 6px; }
  .bar { height: 10px; border-radius: 99px; background: var(--wash); overflow: hidden; }
  .bar i { display: block; height: 100%; background: var(--accent); border-radius: 99px; transition: width .5s; }
  .empty, .note { color: var(--mute); }
  .where { font-size: 12px; color: var(--mute); }
  .fsum { margin: 4px 0 18px; }
  .fsum .l { font-weight: 650; margin-bottom: 6px; }
  .fsum .big { font-size: 28px; font-weight: 750; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
  .fsum .big small { font-size: 14px; font-weight: 600; color: var(--mute); margin-left: 6px; letter-spacing: 0; }
  .hist { display: flex; gap: 4px; align-items: flex-end; height: 40px; margin-top: 6px; }
  .hist i { flex: 1; min-height: 2px; border-radius: 4px 4px 1px 1px; background: var(--accent); }
  .hist-n { display: flex; gap: 4px; font-size: 11px; color: var(--mute); font-variant-numeric: tabular-nums; }
  .hist-n span { flex: 1; text-align: center; }
  h3 { font-size: 12px; font-weight: 500; letter-spacing: .04em; text-transform: uppercase; color: var(--mute); margin: 22px 0 4px; }
  .sub { padding: 12px 0; border-top: 1px solid var(--line); }
  .sub .kv { margin: 6px 0 0; }
  .sub .kv .k { display: block; font-size: 12px; color: var(--mute); }
  .sub .kv .v { display: flex; gap: 10px; align-items: flex-start; }
  .sub .kv .v span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .sub .kv.hidden .v span { opacity: .45; text-decoration: line-through; }
  .sub button { min-height: 32px; font-size: 13px; }
</style></head>
<body><main>
  <section id="list">
    <header><div style="flex:1"><div class="eyebrow">Presenter controls</div><h1>Live questions</h1></div></header>
    <div id="questions"><p class="note">Loading…</p></div>
  </section>
  <section id="detail" hidden>
    <header><button id="back" aria-label="All questions">←</button><div style="flex:1;min-width:0"><div class="eyebrow" id="d-kind"></div></div></header>
    <div id="d-head"></div>
    <div class="card" id="d-body"></div>
  </section>
</main>
<script>
const docId = ${scriptJson(docId)};
const $ = (id) => document.getElementById(id);
let questions = [];
let current = null;
let detailRun = 0;

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

async function api(path, method, body) {
  const r = await fetch('/api' + path, { method: method || 'GET', credentials: 'same-origin', cache: 'no-store',
    headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) { location.href = '/d/' + docId; throw new Error('Sign in first.'); }
  if (!r.ok) throw new Error(data.error || 'That did not work.');
  return data;
}

/** The controls every question shows, in the list and on its own page. */
function controls(q, after) {
  const box = el('div');
  const row = el('div', 'row');
  row.append(el('span', 'chip', q.kind === 'poll' ? 'Poll' : q.kind === 'form' ? 'Form' : q.votable ? 'Votable' : 'Answers'));
  const sw = el('label', 'switch');
  const input = document.createElement('input');
  input.type = 'checkbox'; input.checked = q.open;
  input.onclick = (e) => e.stopPropagation();
  input.onchange = async () => { try { await api('/live/' + q.code, 'PATCH', { open: input.checked }); after(); } catch (e) { alert(e.message); input.checked = !input.checked; } };
  sw.append(input, q.open ? 'Open' : 'Closed');
  sw.onclick = (e) => e.stopPropagation();
  row.append(sw);
  const n = q.kind === 'poll' ? q.totalVotes : q.kind === 'form' ? q.totalResponses : (typeof q.answers === 'number' ? q.shown : q.answers.filter((a) => !a.hidden).length);
  const noun = q.kind === 'poll' ? ['vote', 'votes'] : q.kind === 'form' ? ['response', 'responses'] : ['answer', 'answers'];
  row.append(el('span', 'count', n + ' ' + noun[n === 1 ? 0 : 1]));
  box.append(row);
  box.append(el('div', 'url', q.shortUrl || ''));
  const actions = el('div', 'actions');
  const clear = el('button', 'danger', q.kind === 'poll' ? 'Reset votes' : 'Clear all');
  clear.onclick = async (e) => {
    e.stopPropagation();
    const ask = q.kind === 'poll' ? 'Reset every vote on “' + q.question + '” to zero?'
      : q.kind === 'form' ? 'Hide every written answer to “' + q.question + '”? They stay stored; ratings and choices stay counted.'
      : 'Hide every answer to “' + q.question + '”? They stay stored.';
    if (!confirm(ask)) return;
    try { await api('/live/' + q.code + '/clear', 'POST'); after(); } catch (err) { alert(err.message); }
  };
  const csv = el('a', 'btn', 'Download CSV');
  csv.href = '/api/live/' + q.code + '/csv';
  csv.onclick = (e) => e.stopPropagation();
  actions.append(clear);
  if (q.kind === 'form') {
    const reset = el('button', 'danger', 'Reset responses');
    reset.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm('Delete every response to “' + q.question + '”? This cannot be undone.')) return;
      try { await api('/live/' + q.code + '/reset', 'POST'); after(); } catch (err) { alert(err.message); }
    };
    actions.append(reset);
  }
  actions.append(csv);
  if (!q.placement) {
    const del = el('button', 'danger', 'Delete question');
    del.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm('Delete “' + q.question + '” and all its answers? It is on no slide. This cannot be undone.')) return;
      try { await api('/live/' + q.code + '/delete', 'POST'); after(); } catch (err) { alert(err.message); }
    };
    actions.append(del);
  }
  box.append(actions);
  return box;
}

async function loadList() {
  try {
    questions = (await api('/documents/' + docId + '/live')).questions;
  } catch (e) { $('questions').textContent = e.message; return; }
  const box = $('questions');
  box.textContent = '';
  if (!questions.length) { box.append(el('p', 'note', 'No live questions in this document yet. Add one with ⌘K → Add a live question.')); return; }
  for (const q of questions) {
    const card = el('div', 'card tap');
    card.onclick = () => { location.hash = q.code; };
    card.append(el('div', 'where', q.placement ? q.placement.pageName + ' · slide ' + q.placement.slide : 'Not on a slide'));
    card.append(el('div', 'q', q.question));
    card.append(controls(q, loadList));
    box.append(card);
  }
}

async function loadDetail(code) {
  const q = await api('/live/' + code);
  q.shortUrl = (questions.find((x) => x.code === code) || {}).shortUrl || location.host + '/q/' + code;
  current = q;
  $('d-kind').textContent = q.kind === 'poll' ? 'Poll' : q.kind === 'form' ? 'Form' : 'Question';
  const head = $('d-head');
  head.textContent = '';
  const card = el('div', 'card');
  card.append(el('div', 'q', q.question), controls(q, () => loadDetail(code)));
  head.append(card);
  const body = $('d-body');
  body.textContent = '';
  if (q.kind === 'form') { renderFormDetail(q, code, body); return; }
  if (q.kind === 'poll') {
    for (const o of q.options) {
      const row = el('div', 'opt');
      const l = el('div', 'l');
      l.append(el('span', null, o.label), el('span', null, o.votes + ' · ' + o.percent + '%'));
      const bar = el('div', 'bar'); const fill = el('i'); fill.style.width = o.percent + '%'; bar.append(fill);
      row.append(l, bar);
      body.append(row);
    }
    return;
  }
  const answers = q.answers.slice().reverse();
  if (!answers.length) { body.append(el('p', 'empty', 'No answers yet.')); return; }
  for (const a of answers) {
    const row = el('div', 'answer' + (a.hidden ? ' hidden' : ''));
    const t = el('div', 't');
    if (a.name) t.append(el('span', 'n', a.name));
    t.append(a.text);
    t.append(el('div', 'm', new Date(a.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + (q.votable ? ' · ♥ ' + (a.likes || 0) : '') + (a.hidden ? ' · hidden' : '')));
    const b = el('button', a.hidden ? 'primary' : '', a.hidden ? 'Show' : 'Hide');
    b.onclick = async () => {
      b.disabled = true;
      try { await api('/live/' + code + '/answers/' + encodeURIComponent(a.id) + '/hide', 'POST', { hidden: !a.hidden }); await loadDetail(code); }
      catch (e) { alert(e.message); b.disabled = false; }
    };
    row.append(t, b);
    body.append(row);
  }
}

/** A form: each rating and choice summed up, then every response, newest first, with Hide/Show on written answers. */
function renderFormDetail(q, code, body) {
  for (const f of q.fields) {
    if (f.type === 'text') continue;
    const box = el('div', 'fsum');
    box.append(el('div', 'l', f.label));
    if (f.type === 'rating') {
      const big = el('div', 'big', f.average == null ? '–' : f.average.toFixed(1));
      big.append(el('small', null, '/ ' + f.max + ' · ' + f.responses + (f.responses === 1 ? ' rating' : ' ratings')));
      const hist = el('div', 'hist'), nums = el('div', 'hist-n');
      const top = Math.max(1, ...f.distribution);
      f.distribution.forEach((c, i) => {
        const bar = el('i'); bar.style.height = (c / top) * 100 + '%'; bar.title = c + ' × ' + (i + 1); hist.append(bar);
        nums.append(el('span', null, (i + 1) + (c ? ' · ' + c : '')));
      });
      box.append(big, hist, nums);
    } else {
      for (const o of f.options) {
        const row = el('div', 'opt');
        const l = el('div', 'l');
        l.append(el('span', null, o.label), el('span', null, o.count + ' · ' + o.percent + '%'));
        const bar = el('div', 'bar'); const fill = el('i'); fill.style.width = o.percent + '%'; bar.append(fill);
        row.append(l, bar);
        box.append(row);
      }
    }
    body.append(box);
  }
  body.append(el('h3', null, 'Responses'));
  const subs = q.submissions.slice().reverse();
  if (!subs.length) { body.append(el('p', 'empty', 'No responses yet.')); return; }
  for (const s of subs) {
    const row = el('div', 'sub');
    const when = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    row.append(el('div', 'where', when(s.createdAt) + (s.updatedAt ? ' · edited ' + when(s.updatedAt) : '')));
    for (const f of q.fields) {
      if (s.values[f.id] === undefined) continue;
      const hidden = s.hidden.includes(f.id);
      const kv = el('div', 'kv' + (hidden ? ' hidden' : ''));
      kv.append(el('span', 'k', f.label));
      const v = el('div', 'v');
      v.append(el('span', null, f.type === 'rating' ? s.values[f.id] + ' / ' + f.max : String(s.values[f.id])));
      if (f.type === 'text') {
        const b = el('button', hidden ? 'primary' : '', hidden ? 'Show' : 'Hide');
        b.onclick = async () => {
          b.disabled = true;
          try { await api('/live/' + code + '/answers/' + encodeURIComponent(s.id + ':' + f.id) + '/hide', 'POST', { hidden: !hidden }); await loadDetail(code); }
          catch (e) { alert(e.message); b.disabled = false; }
        };
        v.append(b);
      }
      kv.append(v);
      row.append(kv);
    }
    body.append(row);
  }
}

/** The same held request the board uses: answers the moment the question changes. */
async function follow(code, run) {
  let v = -1;
  while (run === detailRun) {
    try {
      const r = await fetch('/q/' + code + '/state?v=' + v + '&wait=' + (v < 0 ? 0 : 25000), { cache: 'no-store' });
      if (!r.ok) return;
      const s = await r.json();
      if (run !== detailRun) return;
      if (s.v !== v) { if (v >= 0) await loadDetail(code); v = s.v; }
    } catch { await new Promise((ok) => setTimeout(ok, 3000)); }
  }
}

async function route() {
  const code = location.hash.slice(1);
  detailRun++;
  $('list').hidden = !!code;
  $('detail').hidden = !code;
  if (!code) { await loadList(); return; }
  try { await loadDetail(code); follow(code, detailRun); } catch (e) { $('d-body').textContent = e.message; }
}
$('back').onclick = () => { location.hash = ''; };
addEventListener('hashchange', route);
route();
// Counts on the list stay roughly current without holding a request per question.
setInterval(() => { if (!location.hash && !document.hidden) loadList(); }, 5000);
</script>
</body></html>`;
}
