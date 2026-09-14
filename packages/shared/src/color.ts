/**
 * Colour parsing and contrast.
 *
 * These are only possible because the document stores real CSS in a real
 * layout engine: contrast is computed from the colours that will actually
 * render, including token references, rather than guessed at.
 */

export interface Rgb { r: number; g: number; b: number; a: number }

const NAMED: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff',
  gray: '#808080', grey: '#808080', silver: '#c0c0c0', navy: '#000080', teal: '#008080',
  orange: '#ffa500', purple: '#800080', yellow: '#ffff00', transparent: 'rgba(0,0,0,0)',
};

/**
 * Parses a CSS colour. `resolve` is consulted for `var(--x)` references, so
 * token-based colours can be evaluated rather than skipped.
 */
export function parseColor(value: string, resolve?: (name: string) => string | undefined): Rgb | null {
  const input = value.trim().toLowerCase();
  if (!input || input === 'none' || input === 'currentcolor' || input === 'inherit') return null;

  const varMatch = /^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)$/.exec(input);
  if (varMatch) {
    const resolved = resolve?.(varMatch[1]!) ?? varMatch[2];
    // A var() with no resolvable value is unknown, not black.
    return resolved ? parseColor(resolved, resolve) : null;
  }

  if (NAMED[input]) return parseColor(NAMED[input]!, resolve);

  if (input.startsWith('#')) {
    const hex = input.slice(1);
    const expand = (h: string) => parseInt(h.length === 1 ? h + h : h, 16);
    if (hex.length === 3 || hex.length === 4) {
      return {
        r: expand(hex[0]!), g: expand(hex[1]!), b: expand(hex[2]!),
        a: hex.length === 4 ? expand(hex[3]!) / 255 : 1,
      };
    }
    if (hex.length === 6 || hex.length === 8) {
      return {
        r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16),
        a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
      };
    }
    return null;
  }

  const rgb = /^rgba?\(([^)]+)\)$/.exec(input);
  if (rgb) {
    const parts = rgb[1]!.split(/[,\s/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const channel = (p: string) => (p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p));
    return {
      r: channel(parts[0]!), g: channel(parts[1]!), b: channel(parts[2]!),
      a: parts[3] === undefined ? 1 : parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]),
    };
  }

  const hsl = /^hsla?\(([^)]+)\)$/.exec(input);
  if (hsl) {
    const parts = hsl[1]!.split(/[,\s/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const h = ((parseFloat(parts[0]!) % 360) + 360) % 360;
    const sat = parseFloat(parts[1]!) / 100;
    const light = parseFloat(parts[2]!) / 100;
    const a = parts[3] === undefined ? 1 : parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
    const c = (1 - Math.abs(2 * light - 1)) * sat;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = light - c / 2;
    const [r, g, b] =
      h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
      : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255, a };
  }

  return null;
}

/** Composites a colour over an opaque backdrop. */
export function flatten(color: Rgb, backdrop: Rgb): Rgb {
  const a = color.a;
  return {
    r: color.r * a + backdrop.r * (1 - a),
    g: color.g * a + backdrop.g * (1 - a),
    b: color.b * a + backdrop.b * (1 - a),
    a: 1,
  };
}

function channelLuminance(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(color: Rgb): number {
  return 0.2126 * channelLuminance(color.r) + 0.7152 * channelLuminance(color.g) + 0.0722 * channelLuminance(color.b);
}

/** WCAG 2.1 contrast ratio, 1–21. */
export function contrastRatio(foreground: Rgb, background: Rgb): number {
  const fg = foreground.a < 1 ? flatten(foreground, background) : foreground;
  const a = relativeLuminance(fg);
  const b = relativeLuminance(background);
  const [light, dark] = a > b ? [a, b] : [b, a];
  return (light + 0.05) / (dark + 0.05);
}

/**
 * The contrast WCAG AA requires. Large text — 24px, or 18.66px when bold —
 * only needs 3:1, which is why font size and weight are part of the check.
 */
export function requiredContrast(fontSizePx: number, fontWeight: number): number {
  const large = fontSizePx >= 24 || (fontSizePx >= 18.66 && fontWeight >= 700);
  return large ? 3 : 4.5;
}

export function formatRatio(ratio: number): string {
  return `${Math.round(ratio * 100) / 100}:1`;
}
