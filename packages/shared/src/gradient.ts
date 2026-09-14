/**
 * Gradient parsing and serialization.
 *
 * Kept as pure functions over the CSS text rather than a separate model: the
 * document stores real CSS, so the editor has to be able to read a gradient
 * someone typed, pasted, or imported from a live page — not only ones it wrote.
 */

export type GradientType = 'linear' | 'radial' | 'conic';

export interface GradientStop {
  color: string;
  /** Percentage along the gradient, 0–100. */
  position: number;
}

export interface Gradient {
  type: GradientType;
  /** Degrees, for linear and conic. */
  angle: number;
  stops: GradientStop[];
  /** For radial: `circle` / `ellipse at top left` etc., preserved verbatim. */
  shape?: string;
  repeating?: boolean;
}

export const DEFAULT_GRADIENT: Gradient = {
  type: 'linear',
  angle: 180,
  stops: [
    { color: '#6366f1', position: 0 },
    { color: '#ec4899', position: 100 },
  ],
};

/** Splits on commas that are not inside parentheses. */
function splitTopLevel(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of input) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

export function parseGradient(value: string): Gradient | null {
  const text = value.trim();
  const match = /^(repeating-)?(linear|radial|conic)-gradient\s*\(([\s\S]*)\)$/i.exec(text);
  if (!match) return null;

  const repeating = !!match[1];
  const type = match[2]!.toLowerCase() as GradientType;
  const parts = splitTopLevel(match[3]!);
  if (!parts.length) return null;

  let angle = type === 'linear' ? 180 : 0;
  let shape: string | undefined;
  let stopParts = parts;

  const head = parts[0]!;
  const isStop = /^(#|rgb|hsl|var\(|[a-z]+\s*\d|transparent|currentcolor|[a-z]+$)/i.test(head)
    && !/^(to\s|\d+deg|\d+turn|\d+rad|circle|ellipse|at\s|from\s)/i.test(head);

  if (!isStop) {
    stopParts = parts.slice(1);
    if (type === 'linear') {
      angle = parseAngle(head) ?? 180;
    } else if (type === 'conic') {
      angle = parseAngle(head.replace(/^from\s+/i, '')) ?? 0;
    } else {
      shape = head;
    }
  }

  const stops = stopParts.map((part, i) => parseStop(part, i, stopParts.length)).filter((s): s is GradientStop => !!s);
  if (stops.length < 2) return null;

  return { type, angle, stops, shape, repeating };
}

function parseAngle(text: string): number | null {
  const toDirection = /^to\s+(.+)$/i.exec(text.trim());
  if (toDirection) {
    // `to bottom` is 180deg, `to right` is 90deg, and so on.
    const dirs: Record<string, number> = {
      top: 0, 'top right': 45, right: 90, 'bottom right': 135,
      bottom: 180, 'bottom left': 225, left: 270, 'top left': 315,
      'right top': 45, 'right bottom': 135, 'left bottom': 225, 'left top': 315,
    };
    return dirs[toDirection[1]!.trim().toLowerCase()] ?? null;
  }
  const deg = /^(-?[\d.]+)(deg|turn|rad|grad)?$/i.exec(text.trim());
  if (!deg) return null;
  const n = parseFloat(deg[1]!);
  switch ((deg[2] ?? 'deg').toLowerCase()) {
    case 'turn': return n * 360;
    case 'rad': return (n * 180) / Math.PI;
    case 'grad': return n * 0.9;
    default: return n;
  }
}

function parseStop(part: string, index: number, total: number): GradientStop | null {
  const text = part.trim();
  if (!text) return null;

  // A stop is "<color> [position]"; the colour may itself contain spaces.
  const positionMatch = /\s+(-?[\d.]+)%\s*$/.exec(text);
  const color = positionMatch ? text.slice(0, positionMatch.index).trim() : text;
  if (!color) return null;

  const position = positionMatch
    ? parseFloat(positionMatch[1]!)
    // Evenly distribute stops that did not declare a position, which is what
    // the browser does.
    : total > 1 ? (index / (total - 1)) * 100 : 0;

  return { color, position: clamp(position) };
}

function clamp(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

export function serializeGradient(gradient: Gradient): string {
  const stops = [...gradient.stops]
    .sort((a, b) => a.position - b.position)
    .map((s) => `${s.color} ${round(s.position)}%`)
    .join(', ');

  const prefix = gradient.repeating ? 'repeating-' : '';

  if (gradient.type === 'linear') {
    return `${prefix}linear-gradient(${round(gradient.angle)}deg, ${stops})`;
  }
  if (gradient.type === 'conic') {
    return `${prefix}conic-gradient(from ${round(gradient.angle)}deg, ${stops})`;
  }
  return `${prefix}radial-gradient(${gradient.shape ? `${gradient.shape}, ` : ''}${stops})`;
}

/** Whether a CSS value is a gradient this editor can handle. */
export function isGradient(value: string): boolean {
  return parseGradient(value) !== null;
}

/** A CSS value for previewing a gradient in a swatch, regardless of type. */
export function previewGradient(gradient: Gradient): string {
  return serializeGradient(
    gradient.type === 'linear' ? { ...gradient, angle: 90 } : gradient,
  );
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
