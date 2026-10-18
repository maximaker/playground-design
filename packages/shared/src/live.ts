/**
 * Live questions: an audience answers on their phones, the answers appear on
 * the slide while it is being presented.
 *
 * The question lives on the server, keyed by a short unguessable code, and is
 * placed on an artboard as an ordinary embed whose source is the server's
 * board page for that code. That keeps the canvas, presentation mode, the
 * headless screenshot and a published page all rendering it the same way —
 * as a real page — instead of teaching four renderers a new node type.
 *
 * What is here is the part both ends agree on: the shapes, the limits, and the
 * cleaning an answer goes through before anyone sees it.
 */

import { type CanvasDocument, type CanvasNode, getArtboardSize, makeNode } from './model.ts';

export interface LiveAnswer {
  id: string;
  /** Team or name, optional. Empty when the person left it blank. */
  name: string;
  text: string;
  createdAt: number;
  hidden: boolean;
  /** The phone that sent it, for once-per-person. Never leaves the server. */
  device?: string;
  /** Phones that liked it, on a votable question. Only the count leaves the server. */
  likes?: string[];
}

/** One phone's choice in a poll. */
export interface LiveVote {
  device: string;
  /** Index into `options`. */
  option: number;
  at: number;
}

export type LiveKind = 'text' | 'poll' | 'form';

export type LiveFieldType = 'rating' | 'choice' | 'text';

/** One question inside a form: a rating scale, a pick-one choice, or a short written answer. */
export interface LiveFormField {
  /** Stable within the form; values and the CSV are keyed by it. */
  id: string;
  type: LiveFieldType;
  label: string;
  /** A choice field's options, 2–6. */
  options?: string[];
  /** A rating's top score; the scale runs 1..max. Default 5. */
  max?: number;
  /** Words under the two ends of a rating scale, e.g. "Not useful" / "Very useful". */
  lowLabel?: string;
  highLabel?: string;
  required?: boolean;
  /** false keeps the field off the board while it is still collected. Default true. */
  onBoard?: boolean;
}

/**
 * One phone's filled-in form. A rating is its score, a choice the option's
 * index, text the cleaned answer. A field left blank is absent.
 */
export interface LiveSubmission {
  id: string;
  device: string;
  createdAt: number;
  /** Set when the phone edited its answers (once per person replaces, not adds). */
  updatedAt?: number;
  values: Record<string, number | string>;
  /** Text fields the presenter took off the board. Their text stays stored. */
  hidden?: string[];
}

export interface LiveQuestion {
  /** The public code: `/q/<code>` answers it. */
  code: string;
  docId: string;
  question: string;
  /** Closed questions keep their answers but take no new ones. */
  open: boolean;
  createdAt: number;
  /** Oldest first, as received. */
  answers: LiveAnswer[];
  /** Absent on questions made before polls existed: those are text. */
  kind?: LiveKind;
  /** A poll's choices, 2–6. */
  options?: string[];
  votes?: LiveVote[];
  /**
   * One answer (or one vote, which can be changed) per phone. Absent on
   * questions made before this existed, which keep taking several.
   */
  onePerPerson?: boolean;
  /** A text question whose answers the room can like; the board ranks by likes. */
  votable?: boolean;
  /** false hides the QR code and short URL on the board, for a deck that shows them on a slide of their own. */
  qr?: boolean;
  /** A form's fields, in the order the phone shows them. */
  fields?: LiveFormField[];
  /** A form's responses, oldest first. */
  submissions?: LiveSubmission[];
}

export const LIVE_TEXT_MAX = 280;
export const LIVE_NAME_MAX = 40;
export const LIVE_QUESTION_MAX = 200;
export const LIVE_OPTION_MAX = 60;
export const LIVE_OPTIONS_MIN = 2;
export const LIVE_OPTIONS_MAX = 6;

/**
 * A poll's options, cleaned, or a reason they cannot be used. Duplicates are
 * an error rather than merged: two bars with one label would split the vote.
 */
export function cleanPollOptions(raw: unknown): string[] | string {
  if (!Array.isArray(raw)) return 'A poll needs a list of options.';
  const options = raw.map((o) => cleanLiveText(o, LIVE_OPTION_MAX)).filter(Boolean);
  if (options.length < LIVE_OPTIONS_MIN || options.length > LIVE_OPTIONS_MAX) {
    return `A poll needs ${LIVE_OPTIONS_MIN} to ${LIVE_OPTIONS_MAX} options; got ${options.length}.`;
  }
  const seen = new Set(options.map((o) => o.toLowerCase()));
  if (seen.size !== options.length) return 'Two options say the same thing.';
  return options;
}

export const LIVE_FIELDS_MIN = 1;
export const LIVE_FIELDS_MAX = 8;
export const LIVE_FIELD_LABEL_MAX = 120;
export const LIVE_RATING_MAX = 10;
const FIELD_ID = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * A form's fields, cleaned, or a reason they cannot be used. Ids are kept as
 * given (they key the values and the CSV); a field without one gets `f<n>`.
 */
export function cleanFormFields(raw: unknown): LiveFormField[] | string {
  if (!Array.isArray(raw)) return 'A form needs a list of fields.';
  if (raw.length < LIVE_FIELDS_MIN || raw.length > LIVE_FIELDS_MAX) {
    return `A form needs ${LIVE_FIELDS_MIN} to ${LIVE_FIELDS_MAX} fields; got ${raw.length}.`;
  }
  const out: LiveFormField[] = [];
  const ids = new Set<string>();
  for (const [i, f] of raw.entries()) {
    if (!f || typeof f !== 'object') return `Field ${i + 1} is not an object.`;
    const r = f as Record<string, unknown>;
    const id = r.id === undefined || r.id === '' ? `f${i + 1}` : r.id;
    if (typeof id !== 'string' || !FIELD_ID.test(id)) return `Field ${i + 1}: id must be 1–32 letters, digits, _ or -.`;
    if (ids.has(id)) return `Two fields have the id "${id}".`;
    ids.add(id);
    const type = r.type;
    if (type !== 'rating' && type !== 'choice' && type !== 'text') return `Field "${id}": type must be rating, choice or text.`;
    const label = cleanLiveText(r.label, LIVE_FIELD_LABEL_MAX);
    if (!label) return `Field "${id}" needs a label.`;
    const field: LiveFormField = { id, type, label, required: r.required === true, ...(r.onBoard === false ? { onBoard: false } : {}) };
    if (type === 'choice') {
      const options = cleanPollOptions(r.options);
      if (typeof options === 'string') return `Field "${id}": a choice needs ${LIVE_OPTIONS_MIN} to ${LIVE_OPTIONS_MAX} different options.`;
      field.options = options;
    } else if (r.options !== undefined) {
      return `Field "${id}": options are for choice fields.`;
    }
    if (type === 'rating') {
      const max = r.max === undefined ? 5 : r.max;
      if (typeof max !== 'number' || !Number.isInteger(max) || max < 2 || max > LIVE_RATING_MAX) {
        return `Field "${id}": max must be a whole number from 2 to ${LIVE_RATING_MAX}.`;
      }
      field.max = max;
      const low = cleanLiveText(r.lowLabel, LIVE_OPTION_MAX);
      const high = cleanLiveText(r.highLabel, LIVE_OPTION_MAX);
      if (low) field.lowLabel = low;
      if (high) field.highLabel = high;
    }
    out.push(field);
  }
  return out;
}

/**
 * A phone's values for a form, cleaned, or the first problem in them. A choice
 * may be sent as its index or its label; unknown field ids are ignored.
 */
export function cleanFormValues(fields: LiveFormField[], raw: unknown): Record<string, number | string> | string {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const out: Record<string, number | string> = {};
  for (const f of fields) {
    const v = input[f.id];
    const blank = v === undefined || v === null || v === '';
    if (!blank) {
      if (f.type === 'rating') {
        const n = typeof v === 'string' ? Number(v) : v;
        if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > (f.max ?? 5)) return `“${f.label}”: pick 1 to ${f.max ?? 5}.`;
        out[f.id] = n;
      } else if (f.type === 'choice') {
        const options = f.options ?? [];
        const n = typeof v === 'number' ? v : options.findIndex((o) => typeof v === 'string' && o.toLowerCase() === v.trim().toLowerCase());
        if (!Number.isInteger(n) || n < 0 || n >= options.length) return `“${f.label}”: pick one of the options.`;
        out[f.id] = n;
      } else {
        const text = cleanLiveText(v, LIVE_TEXT_MAX);
        if (text) out[f.id] = text;
      }
    }
    if (f.required && out[f.id] === undefined) return `“${f.label}” needs an answer.`;
  }
  if (!Object.keys(out).length) return 'Answer at least one question first.';
  return out;
}

export interface LiveFormTextAnswer {
  /** `<submissionId>:<fieldId>`: what hiding it takes. */
  id: string;
  text: string;
  createdAt: number;
  hidden: boolean;
}

/** One field's results: what the board draws and what an agent reads. */
export interface LiveFieldSummary {
  id: string;
  type: LiveFieldType;
  label: string;
  required: boolean;
  /** false: collected, but not drawn on the board. */
  onBoard: boolean;
  /** Submissions that answered this field. */
  responses: number;
  /** Rating: mean score to one decimal, or null with no ratings. */
  average?: number | null;
  max?: number;
  lowLabel?: string;
  highLabel?: string;
  /** Rating: how many gave each score; index 0 is a score of 1. */
  distribution?: number[];
  /** Choice: each option's count and whole percentage. */
  options?: { label: string; count: number; percent: number }[];
  /** Text: the answers, newest first, hidden ones included and marked. */
  answers?: LiveFormTextAnswer[];
}

/** Per-field results of a form, in field order. */
export function formSummary(q: Pick<LiveQuestion, 'fields' | 'submissions'>): LiveFieldSummary[] {
  const subs = q.submissions ?? [];
  return (q.fields ?? []).map((f): LiveFieldSummary => {
    const given = subs.filter((s) => s.values[f.id] !== undefined);
    const base = { id: f.id, type: f.type, label: f.label, required: !!f.required, onBoard: f.onBoard !== false, responses: given.length };
    if (f.type === 'rating') {
      const max = f.max ?? 5;
      const distribution = Array.from({ length: max }, () => 0);
      let sum = 0;
      for (const s of given) { const n = Number(s.values[f.id]); if (n >= 1 && n <= max) { distribution[n - 1]!++; sum += n; } }
      const count = distribution.reduce((a, b) => a + b, 0);
      return {
        ...base, max, distribution, average: count ? Math.round((sum / count) * 10) / 10 : null,
        ...(f.lowLabel ? { lowLabel: f.lowLabel } : {}), ...(f.highLabel ? { highLabel: f.highLabel } : {}),
      };
    }
    if (f.type === 'choice') {
      const counts = (f.options ?? []).map(() => 0);
      for (const s of given) { const n = Number(s.values[f.id]); if (n >= 0 && n < counts.length) counts[n]!++; }
      const percents = pollPercentages(counts);
      return { ...base, options: (f.options ?? []).map((label, i) => ({ label, count: counts[i]!, percent: percents[i]! })) };
    }
    return {
      ...base,
      answers: given
        .map((s) => ({ id: `${s.id}:${f.id}`, text: String(s.values[f.id]), createdAt: s.updatedAt ?? s.createdAt, hidden: !!s.hidden?.includes(f.id) }))
        .sort((a, b) => b.createdAt - a.createdAt),
    };
  });
}

/** Votes per option, in option order. */
export function pollCounts(q: Pick<LiveQuestion, 'options' | 'votes'>): number[] {
  const counts = (q.options ?? []).map(() => 0);
  for (const v of q.votes ?? []) if (v.option >= 0 && v.option < counts.length) counts[v.option]!++;
  return counts;
}

/** Whole percentages that add up to 100 (largest remainder), so the bars never claim 101%. */
export function pollPercentages(counts: number[]): number[] {
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return counts.map(() => 0);
  const exact = counts.map((c) => (c * 100) / total);
  const out = exact.map(Math.floor);
  let left = 100 - out.reduce((a, b) => a + b, 0);
  const order = exact.map((e, i) => [e - Math.floor(e), i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) { if (left-- <= 0) break; out[i]!++; }
  return out;
}

/**
 * Plain text, one paragraph's worth. Tags are dropped rather than escaped:
 * an answer is never markup, and `<b>hi</b>` shown literally on a projector
 * is noise. Escaping for display is still the renderer's job.
 */
export function cleanLiveText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/<\/?[a-z!][^>]*>/gi, '')
    .replace(/<|>/g, '')
    // Control characters, but not newlines — those become spaces below.
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F\u200B-\u200F\u202A-\u202E]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

/** Visible answers, newest first: what the slide shows. */
export function visibleAnswers(q: Pick<LiveQuestion, 'answers' | 'votable'>): LiveAnswer[] {
  const likes = (a: LiveAnswer) => (q.votable ? a.likes?.length ?? 0 : 0);
  // On a votable question the best rise; ties, and every other question, newest first.
  return q.answers.filter((a) => !a.hidden).sort((a, b) => likes(b) - likes(a) || b.createdAt - a.createdAt);
}

/**
 * How many cards fit and at what type size, for a board of a given size.
 *
 * Sixty answers on one slide cannot all be readable from the back of a room,
 * so the board shows the newest that fit at a legible size and says how many
 * more there are. Few answers get bigger type, so three answers do not look
 * lost on a 1920×1080 slide. `width`/`height` are the room for the cards
 * alone, in CSS pixels of the board.
 */
export function liveBoardFit(count: number, width: number, height: number): { shown: number; fontPx: number; minCardPx: number } {
  // Relative to the slide, so a board drawn at half size keeps its proportions.
  const unit = Math.max(0.4, Math.min(2, Math.min(width / 1800, height / 760)));
  const sizes = [34, 28, 24, 20].map((s) => Math.round(s * unit));
  let fit = { shown: count, fontPx: sizes[0]!, minCardPx: sizes[0]! * 13 };
  for (const fontPx of sizes) {
    const gap = fontPx * 0.8;
    const minCardPx = fontPx * 13;
    // A card is about three lines of text plus the name and its padding.
    const cardHeight = fontPx * 1.3 * 3 + fontPx * 2.6;
    const columns = Math.max(1, Math.floor((width + gap) / (minCardPx + gap)));
    const rows = Math.max(1, Math.floor((height + gap) / (cardHeight + gap)));
    fit = { shown: Math.min(count, columns * rows), fontPx, minCardPx };
    if (count <= columns * rows) break;
  }
  return fit;
}

/** Marks an embed as a live question; the value is the question's code. */
export const LIVE_ATTR = 'data-live-question';

export interface LiveLook { font?: string; ink?: string; accent?: string; card?: string }

/**
 * The deck's look, read off the artboard the question goes on, so the board
 * picks up the slide's type and colour without the author restating them.
 */
export function liveLookFrom(doc: CanvasDocument | null, artboard: CanvasNode | undefined, overrides: LiveLook = {}): LiveLook {
  const look: LiveLook = {};
  // The artboard first, then its layers in order: a deck often sets its type
  // on the first heading rather than on the frame.
  const queue: CanvasNode[] = artboard ? [artboard] : [];
  for (let i = 0; i < queue.length && i < 400 && (!look.font || !look.ink); i++) {
    const n = queue[i]!;
    const font = n.styles['font-family'];
    const ink = n.styles.color;
    // A token reference means nothing outside the document; leave those to the default.
    if (!look.font && font && !font.includes('var(')) look.font = font.split(',')[0]!.replace(/['"]/g, '').trim();
    if (!look.ink && ink && !ink.includes('var(')) look.ink = ink;
    for (const id of n.children) { const child = doc?.nodes[id]; if (child) queue.push(child); }
  }
  return { ...look, ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v)) };
}

/** The board's address for a code and a look. */
export function liveBoardUrl(baseUrl: string, code: string, look: LiveLook = {}): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(look)) if (v) params.set(k, v);
  const query = params.toString();
  return `${baseUrl}/q/${code}/board${query ? `?${query}` : ''}`;
}

/**
 * The embed that puts a live question on an artboard: absolutely placed,
 * inset from the edges unless told where. Pointer events are off like any
 * embed's, so the canvas can select and move it; the editor turns them on for
 * a selected question and in presentation, where the moderation controls are.
 */
export function makeLiveQuestionNode(opts: {
  baseUrl: string; code: string; question: string; artboard: CanvasNode; doc?: CanvasDocument | null;
  x?: number; y?: number; width?: number; height?: number; look?: LiveLook;
}): CanvasNode {
  const size = getArtboardSize(opts.artboard);
  const inset = Math.round(Math.min(size.width, size.height) * 0.08);
  const x = opts.x ?? inset;
  const y = opts.y ?? inset;
  const width = opts.width ?? Math.max(240, size.width - x - inset);
  const height = opts.height ?? Math.max(160, size.height - y - inset);
  return makeNode({
    type: 'embed',
    name: `Live question: ${opts.question.slice(0, 40)}`,
    attrs: {
      src: liveBoardUrl(opts.baseUrl, opts.code, liveLookFrom(opts.doc ?? null, opts.artboard, opts.look)),
      title: opts.question,
      [LIVE_ATTR]: opts.code,
    },
    styles: {
      position: 'absolute', left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px`,
      border: '0', display: 'block', background: 'transparent', 'pointer-events': 'none',
    },
  });
}

export interface LivePlacement {
  pageId: string;
  pageName: string;
  /** 1-based position of the artboard on its page: the slide number when presenting. */
  slide: number;
  artboardId: string;
  artboardName: string;
  nodeId: string;
}

/**
 * Where each live question sits, by code, in page and slide order: the order
 * a presenter meets them. A question placed twice is listed where it comes first.
 */
export function livePlacements(doc: CanvasDocument): Map<string, LivePlacement> {
  const out = new Map<string, LivePlacement>();
  for (const page of doc.pages) {
    page.artboards.forEach((artboardId, index) => {
      const artboard = doc.nodes[artboardId];
      if (!artboard) return;
      const stack = [...artboard.children];
      while (stack.length) {
        const n = doc.nodes[stack.shift()!];
        if (!n) continue;
        const code = n.attrs[LIVE_ATTR];
        if (code && !out.has(code)) {
          out.set(code, {
            pageId: page.id, pageName: page.name, slide: index + 1,
            artboardId, artboardName: artboard.name, nodeId: n.id,
          });
        }
        stack.push(...n.children);
      }
    });
  }
  return out;
}
