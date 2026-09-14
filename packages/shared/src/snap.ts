/**
 * Snapping and alignment guides.
 *
 * This is the single biggest difference between a canvas that feels like a
 * design tool and one that feels like a prototype. Everything here works in one
 * coordinate space — canvas space for artboards, parent-local CSS pixels for
 * absolutely-positioned nodes — so the caller converts once and the geometry
 * stays honest.
 */

export interface Box {
  id: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type GuideKind = 'edge' | 'center' | 'spacing' | 'size';

export interface SnapGuide {
  axis: 'x' | 'y';
  /** Position along the axis, in the working coordinate space. */
  position: number;
  /** Extent of the guide line along the other axis. */
  from: number;
  to: number;
  kind: GuideKind;
  /** Shown next to spacing guides, e.g. "24". */
  label?: string;
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: SnapGuide[];
}

export const NO_SNAP: SnapResult = { dx: 0, dy: 0, guides: [] };

export function boxOf(id: string, left: number, top: number, width: number, height: number): Box {
  return { id, left, top, right: left + width, bottom: top + height };
}

const centerX = (b: Box) => (b.left + b.right) / 2;
const centerY = (b: Box) => (b.top + b.bottom) / 2;

interface Match {
  delta: number;
  guide: SnapGuide;
}

/**
 * Finds the best snap for a moving box against a set of candidates.
 *
 * `threshold` is in working-space units — the caller divides screen pixels by
 * the zoom, so the snap feels the same at every zoom level.
 */
export function computeSnap(
  moving: Box,
  candidates: Box[],
  threshold: number,
  options: { spacing?: boolean; container?: Box | null } = {},
): SnapResult {
  const others = candidates.filter((c) => c.id !== moving.id);
  const targets = options.container ? [...others, options.container] : others;
  if (!targets.length) return NO_SNAP;

  const xMatches: Match[] = [];
  const yMatches: Match[] = [];

  for (const target of targets) {
    // Vertical guides: left/right/center of the moving box against the target's.
    for (const [movingEdge, movingValue] of [
      ['left', moving.left], ['right', moving.right], ['centerX', centerX(moving)],
    ] as const) {
      for (const [targetEdge, targetValue] of [
        ['left', target.left], ['right', target.right], ['centerX', centerX(target)],
      ] as const) {
        // Centre-to-centre and edge-to-edge read as alignment; an edge meeting a
        // centre almost never does, so those pairs are skipped as noise.
        const isCenter = movingEdge === 'centerX';
        if (isCenter !== (targetEdge === 'centerX')) continue;
        const delta = targetValue - movingValue;
        if (Math.abs(delta) > threshold) continue;
        xMatches.push({
          delta,
          guide: {
            axis: 'x', position: targetValue,
            from: Math.min(moving.top, target.top),
            to: Math.max(moving.bottom, target.bottom),
            kind: isCenter ? 'center' : 'edge',
          },
        });
      }
    }

    for (const [movingEdge, movingValue] of [
      ['top', moving.top], ['bottom', moving.bottom], ['centerY', centerY(moving)],
    ] as const) {
      for (const [targetEdge, targetValue] of [
        ['top', target.top], ['bottom', target.bottom], ['centerY', centerY(target)],
      ] as const) {
        const isCenter = movingEdge === 'centerY';
        if (isCenter !== (targetEdge === 'centerY')) continue;
        const delta = targetValue - movingValue;
        if (Math.abs(delta) > threshold) continue;
        yMatches.push({
          delta,
          guide: {
            axis: 'y', position: targetValue,
            from: Math.min(moving.left, target.left),
            to: Math.max(moving.right, target.right),
            kind: isCenter ? 'center' : 'edge',
          },
        });
      }
    }
  }

  if (options.spacing !== false) {
    xMatches.push(...spacingMatches(moving, others, threshold, 'x'));
    yMatches.push(...spacingMatches(moving, others, threshold, 'y'));
  }

  const x = best(xMatches);
  const y = best(yMatches);

  // Keep every guide that agrees with the chosen offset, so aligning three
  // things at once draws three lines rather than one.
  const guides = [
    ...xMatches.filter((m) => x && Math.abs(m.delta - x.delta) < 0.5).map((m) => m.guide),
    ...yMatches.filter((m) => y && Math.abs(m.delta - y.delta) < 0.5).map((m) => m.guide),
  ];

  return { dx: x?.delta ?? 0, dy: y?.delta ?? 0, guides: dedupe(guides) };
}

function best(matches: Match[]): Match | null {
  if (!matches.length) return null;
  return matches.reduce((a, b) => (Math.abs(b.delta) < Math.abs(a.delta) ? b : a));
}

/**
 * Equal-spacing snapping: if the moving box sits in a row or column with others,
 * offer offsets that make its gap match the gaps already in that run.
 */
function spacingMatches(moving: Box, others: Box[], threshold: number, axis: 'x' | 'y'): Match[] {
  const startOf = (b: Box) => (axis === 'x' ? b.left : b.top);
  const endOf = (b: Box) => (axis === 'x' ? b.right : b.bottom);
  const crossStart = (b: Box) => (axis === 'x' ? b.top : b.left);
  const crossEnd = (b: Box) => (axis === 'x' ? b.bottom : b.right);

  // Only boxes that overlap on the cross axis are part of the same run.
  const run = others
    .filter((o) => crossEnd(o) > crossStart(moving) && crossStart(o) < crossEnd(moving))
    .sort((a, b) => startOf(a) - startOf(b));
  if (run.length < 2) return [];

  const gaps: number[] = [];
  for (let i = 1; i < run.length; i++) {
    const gap = startOf(run[i]!) - endOf(run[i - 1]!);
    if (gap > 0) gaps.push(Math.round(gap));
  }
  if (!gaps.length) return [];

  const common = mode(gaps);
  const matches: Match[] = [];
  const size = endOf(moving) - startOf(moving);

  for (const neighbour of run) {
    // Place the moving box one common gap after, and one before, each neighbour.
    for (const candidateStart of [endOf(neighbour) + common, startOf(neighbour) - common - size]) {
      const delta = candidateStart - startOf(moving);
      if (Math.abs(delta) > threshold) continue;
      const gapStart = candidateStart > startOf(neighbour) ? endOf(neighbour) : candidateStart + size;
      matches.push({
        delta,
        guide: {
          axis: axis === 'x' ? 'x' : 'y',
          position: gapStart,
          from: gapStart,
          to: gapStart + common,
          kind: 'spacing',
          label: String(common),
        },
      });
    }
  }
  return matches;
}

function mode(values: number[]): number {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let bestValue = values[0]!;
  let bestCount = 0;
  for (const [v, c] of counts) if (c > bestCount) { bestValue = v; bestCount = c; }
  return bestValue;
}

function dedupe(guides: SnapGuide[]): SnapGuide[] {
  const seen = new Set<string>();
  return guides.filter((g) => {
    const key = `${g.axis}:${Math.round(g.position)}:${g.kind}:${g.label ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Resize snapping
// ---------------------------------------------------------------------------

/**
 * Snaps the edges a resize is actually moving. Unlike a move, only the dragged
 * edges may shift, so this returns the adjustment for those edges alone.
 */
export function snapResize(
  moving: Box,
  candidates: Box[],
  handle: string,
  threshold: number,
  container?: Box | null,
): { dx: number; dy: number; guides: SnapGuide[] } {
  const targets = container ? [...candidates.filter((c) => c.id !== moving.id), container] : candidates.filter((c) => c.id !== moving.id);
  const guides: SnapGuide[] = [];
  let dx = 0;
  let dy = 0;

  const snapEdge = (value: number, options: number[], axis: 'x' | 'y'): number | null => {
    let bestDelta: number | null = null;
    for (const option of options) {
      const delta = option - value;
      if (Math.abs(delta) > threshold) continue;
      if (bestDelta === null || Math.abs(delta) < Math.abs(bestDelta)) bestDelta = delta;
    }
    if (bestDelta === null) return null;
    const position = value + bestDelta;
    guides.push({
      axis,
      position,
      from: axis === 'x' ? Math.min(moving.top, ...targets.map((t) => t.top)) : Math.min(moving.left, ...targets.map((t) => t.left)),
      to: axis === 'x' ? Math.max(moving.bottom, ...targets.map((t) => t.bottom)) : Math.max(moving.right, ...targets.map((t) => t.right)),
      kind: 'edge',
    });
    return bestDelta;
  };

  const xOptions = targets.flatMap((t) => [t.left, t.right, centerX(t)]);
  const yOptions = targets.flatMap((t) => [t.top, t.bottom, centerY(t)]);

  if (handle.includes('e')) dx = snapEdge(moving.right, xOptions, 'x') ?? 0;
  else if (handle.includes('w')) dx = snapEdge(moving.left, xOptions, 'x') ?? 0;
  if (handle.includes('s')) dy = snapEdge(moving.bottom, yOptions, 'y') ?? 0;
  else if (handle.includes('n')) dy = snapEdge(moving.top, yOptions, 'y') ?? 0;

  return { dx, dy, guides: dedupe(guides) };
}
