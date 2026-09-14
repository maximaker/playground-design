/**
 * Value arithmetic for the property panel's numeric fields.
 *
 * Two jobs, both of which exist because CSS values are strings and a design
 * tool has to treat them as numbers without losing what they are:
 *
 * - stepping `2rem` must produce `3rem`, not `3px` and not `3`;
 * - typing `+8` into a field holding `24px` must mean 32px, because that is
 *   what every other design tool does and what the hand expects.
 *
 * Anything that is not plainly a number with a unit is left alone. `calc()`,
 * `var()` and keywords pass through untouched rather than being mangled into
 * something that looks numeric.
 */

/** A CSS length/number split into its parts, or null if it is not one. */
export interface NumericValue {
  number: number;
  unit: string;
}

const NUMERIC = /^\s*(-?(?:\d+\.?\d*|\.\d+))\s*([a-z%]*)\s*$/i;

export function parseNumeric(value: string): NumericValue | null {
  const m = NUMERIC.exec(value);
  if (!m) return null;
  const number = Number(m[1]);
  if (!Number.isFinite(number)) return null;
  return { number, unit: m[2] ?? '' };
}

/**
 * Formats a number without floating-point noise.
 *
 * Stepping 0.1 at a time through JavaScript floats otherwise lands on values
 * like `0.30000000000000004px`, which is both wrong-looking and, once written
 * into a stylesheet, permanent.
 */
export function formatNumber(n: number): string {
  const rounded = Math.round(n * 1e4) / 1e4;
  return String(rounded);
}

export interface StepOptions {
  /** The base increment. Defaults to 1. */
  step?: number;
  min?: number;
  max?: number;
  /** Unit to use when the current value carries none. */
  suffix?: string;
}

/**
 * Steps a value by `direction` increments.
 *
 * Returns null when the value is not steppable, so the caller can let the key
 * event do whatever it would normally have done rather than swallowing it.
 */
export function stepValue(value: string, direction: number, opts: StepOptions = {}): string | null {
  const parsed = parseNumeric(value);
  if (!parsed) return null;

  const step = opts.step ?? 1;
  let next = parsed.number + direction * step;
  if (opts.min !== undefined) next = Math.max(opts.min, next);
  if (opts.max !== undefined) next = Math.min(opts.max, next);

  return `${formatNumber(next)}${parsed.unit || opts.suffix || ''}`;
}

/**
 * The multiplier for a step, from the modifier keys held.
 *
 * Shift for ten at a time and Alt for a tenth is the convention across design
 * tools; matching it means the muscle memory people arrive with works here.
 */
export function stepMultiplier(mods: { shiftKey?: boolean; altKey?: boolean }): number {
  if (mods.shiftKey) return 10;
  if (mods.altKey) return 0.1;
  return 1;
}

const RELATIVE = /^\s*([+\-*/])\s*(-?(?:\d+\.?\d*|\.\d+))\s*([a-z%]*)\s*$/i;
const EXPRESSION = /^\s*(-?(?:\d+\.?\d*|\.\d+))\s*([a-z%]*)\s*([+\-*/])\s*(-?(?:\d+\.?\d*|\.\d+))\s*([a-z%]*)\s*$/i;

/**
 * Resolves what the user typed against the value the field already held.
 *
 * Supports `+8` / `-4` / `*2` / `/2` relative to the current value, and a
 * self-contained `24 + 8`. Everything else — `calc(...)`, `var(--x)`, `auto`,
 * a plain number — is returned unchanged for the caller's normal handling.
 */
export function evaluateInput(input: string, current: string, suffix = ''): string {
  const relative = RELATIVE.exec(input);
  if (relative) {
    const base = parseNumeric(current);
    // Relative arithmetic against a value that is not a number has no meaning;
    // better to hand the text back than to invent a base of zero.
    if (!base) return input;
    const result = apply(base.number, relative[1]!, Number(relative[2]));
    if (result === null) return input;
    return `${formatNumber(result)}${relative[3] || base.unit || suffix}`;
  }

  const expression = EXPRESSION.exec(input);
  if (expression) {
    const result = apply(Number(expression[1]), expression[3]!, Number(expression[4]));
    if (result === null) return input;
    return `${formatNumber(result)}${expression[2] || expression[5] || suffix}`;
  }

  return input;
}

function apply(a: number, operator: string, b: number): number | null {
  switch (operator) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    // Dividing by zero would write `Infinitypx` into the stylesheet.
    case '/': return b === 0 ? null : a / b;
    default: return null;
  }
}
