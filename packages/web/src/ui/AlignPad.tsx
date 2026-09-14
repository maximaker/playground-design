/**
 * A 3×3 pad for aligning a container's contents.
 *
 * The pad is spatial because the intent is spatial: you want the contents in
 * the top-left, and you should not have to know that saying so means
 * `justify-content` in a row and `align-items` in a column, nor that both
 * invert under `row-reverse`. The mapping lives in shared/align.ts; this is
 * only the surface.
 *
 * The distribution row underneath is separate on purpose. Spreading children
 * apart is a different kind of decision from putting them somewhere, and
 * folding it into the same nine cells would make `space-between` look like a
 * position.
 *
 * `stretch` is the one alignment with no cell, because it is not a position —
 * and it is also the CSS default, so a pad that showed nothing selected for it
 * would look broken on almost every container. Instead a stretched axis
 * highlights the whole row or column: "at the top, spanning the full width" is
 * what that state actually means, and it reads that way.
 */

import {
  type Align, type StyleMap,
  DISTRIBUTIONS, alignmentStyles, contentAlignment, layoutMode,
} from '@playground/shared';

const CELLS: { horizontal: Align; vertical: Align }[] = [
  { horizontal: 'start', vertical: 'start' },
  { horizontal: 'center', vertical: 'start' },
  { horizontal: 'end', vertical: 'start' },
  { horizontal: 'start', vertical: 'center' },
  { horizontal: 'center', vertical: 'center' },
  { horizontal: 'end', vertical: 'center' },
  { horizontal: 'start', vertical: 'end' },
  { horizontal: 'center', vertical: 'end' },
  { horizontal: 'end', vertical: 'end' },
];

const NAMES: Record<Align, string> = {
  start: 'left', center: 'centre', end: 'right', stretch: 'stretch',
};
const VERTICAL_NAMES: Record<Align, string> = {
  start: 'top', center: 'middle', end: 'bottom', stretch: 'stretch',
};

/** Cell previews use real flex values, so what you see is what gets written. */
const JUSTIFY: Record<Align, string> = {
  start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'flex-start',
};
const ALIGN_ITEMS: Record<Align, string> = {
  start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch',
};

const SPREAD: { value: string; label: string; title: string }[] = [
  { value: 'space-between', label: 'Between', title: 'Equal space between items, none at the ends' },
  { value: 'space-around', label: 'Around', title: 'Equal space around each item' },
  { value: 'space-evenly', label: 'Evenly', title: 'Equal space between items and at the ends' },
];

export function AlignPad({ styles, onChange }: {
  styles: StyleMap;
  onChange: (styles: StyleMap) => void;
}) {
  const mode = layoutMode(styles);
  if (mode === 'none') {
    return (
      <p className="panel-hint">
        Set Display to Flex or Grid to align the contents. A block container leaves each child to
        position itself.
      </p>
    );
  }

  const current = contentAlignment(styles);
  const justify = styles['justify-content'] ?? '';
  const spread = DISTRIBUTIONS.includes(justify) ? justify : null;

  return (
    <div className="align-pad" role="group" aria-label="Align contents">
        {CELLS.map((cell) => {
          // A stretched axis matches every cell along it.
          const matches = (axis: Align, cellAxis: Align) => axis === 'stretch' || axis === cellAxis;
          const active = !spread
            && matches(current.horizontal, cell.horizontal)
            && matches(current.vertical, cell.vertical);
          const label = `Align ${VERTICAL_NAMES[cell.vertical]} ${NAMES[cell.horizontal]}`;
          return (
            <button
              key={`${cell.horizontal}-${cell.vertical}`}
              className={active ? 'is-active' : ''}
              title={label}
              aria-label={label}
              aria-pressed={active}
              onClick={() => onChange(alignmentStyles(styles, cell))}
            >
              {/*
                * Three bars laid out the way the container actually lays out —
                * vertical bars in a row, horizontal bars in a column — so the
                * cell previews the result instead of representing it
                * abstractly. A dot in a grid tells you where something goes; it
                * does not tell you which way the content will run.
                */}
              <span
                className="align-preview"
                data-flow={mode === 'column' ? 'column' : 'row'}
                style={{
                  flexDirection: mode === 'column' ? 'column' : 'row',
                  justifyContent: JUSTIFY[mode === 'column' ? cell.vertical : cell.horizontal],
                  alignItems: ALIGN_ITEMS[mode === 'column' ? cell.horizontal : cell.vertical],
                }}
              >
                <i /><i /><i />
              </span>
            </button>
          );
        })}
    </div>
  );
}

/**
 * Fill and Spread, which belong with the pad but not inside it.
 *
 * They are full-width rows beneath the pad rather than squeezed into its
 * column: three labelled options do not fit in the width a square pad wants,
 * and the result was "Between Around" clipped mid-word.
 */
export function AlignExtras({ styles, onChange }: {
  styles: StyleMap;
  onChange: (styles: StyleMap) => void;
}) {
  if (layoutMode(styles) === 'none') return null;

  const current = contentAlignment(styles);
  const justify = styles['justify-content'] ?? '';
  const spread = DISTRIBUTIONS.includes(justify) ? justify : null;

  return (
    <div className="align-extras">
      <div className="align-spread">
        <span className="field-label">Fill</span>
        <div className="segmented">
          {([
            { axis: 'horizontal' as const, label: 'Across', title: 'Children fill the container’s width' },
            { axis: 'vertical' as const, label: 'Down', title: 'Children fill the container’s height' },
          ]).map((f) => {
            const on = current[f.axis] === 'stretch';
            return (
              <button
                key={f.axis}
                className={on ? 'is-active' : ''}
                title={f.title}
                aria-pressed={on}
                // Turning fill off has to land somewhere; the near edge is the
                // least surprising place for the content to go.
                onClick={() => onChange(alignmentStyles(styles, { [f.axis]: on ? 'start' : 'stretch' }))}
              >{f.label}</button>
            );
          })}
        </div>
      </div>

      <div className="align-spread">
        <span className="field-label">Spread</span>
        <div className="segmented">
          {SPREAD.map((s) => (
            <button
              key={s.value}
              className={spread === s.value ? 'is-active' : ''}
              title={s.title}
              aria-pressed={spread === s.value}
              // Clicking the active one turns it off, back to a plain position.
              onClick={() => onChange({
                'justify-content': spread === s.value
                  ? alignmentStyles(styles, current)['justify-content'] ?? 'flex-start'
                  : s.value,
              })}
            >{s.label}</button>
          ))}
        </div>
      </div>
    </div>
  );
}
