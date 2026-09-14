/**
 * Alignment of a container's contents, expressed the way a designer thinks
 * about it rather than the way CSS spells it.
 *
 * "Put the contents in the top-left" is one intent, but in CSS it is two
 * properties whose meanings swap when `flex-direction` changes and invert again
 * when it is reversed. Getting that wrong is the classic flexbox papercut, and a
 * panel that exposes `justify-content` and `align-items` as separate dropdowns
 * hands the problem to the user. This maps both ways so the UI can offer a
 * spatial control — a 3×3 pad — and still write correct CSS.
 *
 * Grid is included because `justify-items` / `align-items` are already
 * axis-absolute there; the mapping is the identity, which is exactly why the
 * flex case feels so surprising by comparison.
 */

import type { StyleMap } from './model.ts';

export type Align = 'start' | 'center' | 'end' | 'stretch';

export interface ContentAlignment {
  horizontal: Align;
  vertical: Align;
}

/** How the container lays its children out, as far as alignment is concerned. */
export type LayoutMode = 'row' | 'column' | 'grid' | 'none';

export function layoutMode(styles: StyleMap): LayoutMode {
  const display = styles.display ?? '';
  if (display.includes('grid')) return 'grid';
  if (!display.includes('flex')) return 'none';
  return (styles['flex-direction'] ?? 'row').startsWith('column') ? 'column' : 'row';
}

/** True when the flow runs backwards, so visual start is CSS end. */
function isReversed(styles: StyleMap): boolean {
  return (styles['flex-direction'] ?? '').endsWith('-reverse');
}

const TO_CSS: Record<Align, string> = {
  start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch',
};

const FROM_CSS: Record<string, Align> = {
  'flex-start': 'start', start: 'start', left: 'start', normal: 'stretch',
  center: 'center',
  'flex-end': 'end', end: 'end', right: 'end',
  stretch: 'stretch', baseline: 'start',
};

function flip(value: Align): Align {
  return value === 'start' ? 'end' : value === 'end' ? 'start' : value;
}

/**
 * The CSS for an alignment, given the container's own styles.
 *
 * Returns only the properties that change meaning, so a caller can merge it
 * into an existing style map without clobbering unrelated declarations.
 */
export function alignmentStyles(
  styles: StyleMap,
  next: Partial<ContentAlignment>,
): StyleMap {
  const mode = layoutMode(styles);
  const current = contentAlignment(styles);
  const horizontal = next.horizontal ?? current.horizontal;
  const vertical = next.vertical ?? current.vertical;

  if (mode === 'grid') {
    return { 'justify-items': TO_CSS[horizontal], 'align-items': TO_CSS[vertical] };
  }
  if (mode === 'none') {
    // A block container has no alignment properties of its own. Centring means
    // an auto margin on the children, which is the caller's business, so say
    // nothing rather than write declarations the browser will ignore.
    return {};
  }

  const reversed = isReversed(styles);
  const main = mode === 'row' ? horizontal : vertical;
  const cross = mode === 'row' ? vertical : horizontal;

  return {
    // `justify-content` has no `stretch`; children stretch along the main axis
    // by growing, not by alignment, so it degrades to the near edge.
    'justify-content': TO_CSS[reversed ? flip(main === 'stretch' ? 'start' : main) : (main === 'stretch' ? 'start' : main)],
    'align-items': TO_CSS[cross],
  };
}

/** Reads the current alignment back out, for the UI to show as selected. */
export function contentAlignment(styles: StyleMap): ContentAlignment {
  const mode = layoutMode(styles);

  if (mode === 'grid') {
    return {
      horizontal: FROM_CSS[styles['justify-items'] ?? ''] ?? 'stretch',
      vertical: FROM_CSS[styles['align-items'] ?? ''] ?? 'stretch',
    };
  }
  if (mode === 'none') return { horizontal: 'stretch', vertical: 'stretch' };

  const justify = styles['justify-content'] ?? 'flex-start';
  // A distribution keyword is not a position; the pad shows no cell for it
  // rather than lighting up a corner the content is not actually in.
  const main: Align = DISTRIBUTIONS.includes(justify)
    ? 'stretch'
    : FROM_CSS[justify] ?? 'start';
  const cross = FROM_CSS[styles['align-items'] ?? ''] ?? 'stretch';

  const resolvedMain = isReversed(styles) ? flip(main) : main;

  return mode === 'row'
    ? { horizontal: resolvedMain, vertical: cross }
    : { horizontal: cross, vertical: resolvedMain };
}

export const DISTRIBUTIONS = ['space-between', 'space-around', 'space-evenly'];

/** The property that spreads children apart, which differs by layout mode. */
export function distributionProperty(styles: StyleMap): string | null {
  return layoutMode(styles) === 'none' ? null : 'justify-content';
}

/**
 * Turns an align-a-multi-selection request into a change on their parent.
 *
 * Children in flex flow cannot be moved individually — the engine owns their
 * position — so the honest translation of "align these left" is "make their
 * container align its contents left". This reports which axis that lands on so
 * the caller can say what it is about to do.
 */
export function alignmentForSelection(
  parentStyles: StyleMap,
  axis: 'left' | 'center-x' | 'right' | 'top' | 'center-y' | 'bottom',
): Partial<ContentAlignment> | null {
  if (layoutMode(parentStyles) === 'none') return null;
  switch (axis) {
    case 'left': return { horizontal: 'start' };
    case 'center-x': return { horizontal: 'center' };
    case 'right': return { horizontal: 'end' };
    case 'top': return { vertical: 'start' };
    case 'center-y': return { vertical: 'center' };
    case 'bottom': return { vertical: 'end' };
  }
}
