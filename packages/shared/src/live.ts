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
}

export const LIVE_TEXT_MAX = 280;
export const LIVE_NAME_MAX = 40;
export const LIVE_QUESTION_MAX = 200;

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
export function visibleAnswers(q: Pick<LiveQuestion, 'answers'>): LiveAnswer[] {
  return q.answers.filter((a) => !a.hidden).sort((a, b) => b.createdAt - a.createdAt);
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
