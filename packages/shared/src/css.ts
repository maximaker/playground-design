/**
 * CSS parsing and serialization.
 *
 * Hand-rolled rather than pulling in a full CSS parser: the subset we need is
 * small (declaration blocks, simple selectors, at-rules one level deep) and
 * owning it keeps the fidelity behaviour predictable.
 */

import type { StyleMap } from './model.ts';

/** Parses a declaration list (`color: red; gap: 4px`) into a StyleMap. */
export function parseDeclarations(css: string): StyleMap {
  const out: StyleMap = {};
  let i = 0;
  let prop = '';
  let value = '';
  let inProp = true;
  let depth = 0;
  let quote: string | null = null;

  const flush = () => {
    const p = prop.trim().toLowerCase();
    const v = value.trim();
    if (p && v) out[p] = v;
    prop = ''; value = ''; inProp = true;
  };

  while (i < css.length) {
    const ch = css[i]!;
    if (quote) {
      if (ch === quote && css[i - 1] !== '\\') quote = null;
      (inProp ? (prop += ch) : (value += ch));
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      (inProp ? (prop += ch) : (value += ch));
    } else if (ch === '(') { depth++; (inProp ? (prop += ch) : (value += ch)); }
    else if (ch === ')') { depth--; (inProp ? (prop += ch) : (value += ch)); }
    else if (ch === ':' && inProp && depth === 0) { inProp = false; }
    else if (ch === ';' && depth === 0) { flush(); }
    else { (inProp ? (prop += ch) : (value += ch)); }
    i++;
  }
  flush();
  return out;
}

export function serializeDeclarations(styles: StyleMap, indent = ''): string {
  return Object.entries(styles)
    .filter(([, v]) => v !== '' && v != null)
    .map(([k, v]) => `${indent}${k}: ${v};`)
    .join('\n');
}

export function inlineDeclarations(styles: StyleMap): string {
  return Object.entries(styles)
    .filter(([, v]) => v !== '' && v != null)
    .map(([k, v]) => `${k}:${v}`)
    .join(';');
}

export interface CssRule {
  /** Comma-separated selector list, as written. */
  selector: string;
  styles: StyleMap;
  /** Enclosing at-rule prelude, e.g. `@media (max-width: 768px)`, if any. */
  atRule?: string;
}

/**
 * What a stylesheet held besides plain rules. Filled by `parseStylesheet` when
 * asked: blocks kept verbatim (`@keyframes`, `@font-face`, `@import`), and
 * anything that could not be represented at all, so a caller can say so
 * rather than return an empty warnings list.
 */
export interface StylesheetExtras {
  /** At-rules kept as written, to go into the document's preserved CSS. */
  raw: string[];
  /** Short descriptions of what was dropped. */
  dropped: string[];
}

/** At-rules that are whole statements of their own and are kept verbatim. */
const VERBATIM_AT = /^@(-[a-z]+-)?(keyframes|font-face|property|counter-style|font-feature-values|font-palette-values|page)\b/i;

/**
 * Parses a stylesheet into a flat rule list. Group at-rules (`@media`,
 * `@supports`, `@container`, `@layer`) one level deep become the rule's
 * `atRule`; deeper nesting is dropped rather than mis-attributed, and reported
 * through `extras` along with the verbatim at-rules.
 */
export function parseStylesheet(css: string, extras?: StylesheetExtras): CssRule[] {
  const rules: CssRule[] = [];
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let i = 0;

  const parseBlock = (atRule?: string) => {
    let buf = '';
    while (i < stripped.length) {
      const ch = stripped[i]!;
      if (ch === '}') { i++; return; }
      // A statement at-rule (`@import url(x);`) ends at its semicolon. Read as
      // part of the next prelude it swallowed the rule after it.
      if (ch === ';' && buf.trim().startsWith('@')) {
        const statement = buf.trim();
        if (/^@import\b/i.test(statement) && !atRule) extras?.raw.push(`${statement};`);
        else if (!/^@(charset|namespace)\b/i.test(statement)) extras?.dropped.push(statement);
        buf = '';
        i++;
        continue;
      }
      if (ch === '{') {
        i++;
        const prelude = buf.trim();
        buf = '';
        if (prelude.startsWith('@')) {
          if (/^@(media|supports|container|layer)/i.test(prelude) && !atRule) {
            parseBlock(prelude);
          } else {
            const start = i;
            skipBlock();
            const block = `${prelude} {${stripped.slice(start, i - 1)}}`;
            if (VERBATIM_AT.test(prelude) && !atRule) extras?.raw.push(block);
            else if (VERBATIM_AT.test(prelude)) extras?.raw.push(`${atRule} {\n${block}\n}`);
            else extras?.dropped.push(atRule ? `${prelude} inside ${atRule}` : prelude);
          }
        } else {
          const body = readDeclarations();
          if (prelude) rules.push({ selector: prelude, styles: parseDeclarations(body), atRule });
        }
        continue;
      }
      buf += ch;
      i++;
    }
  };

  const readDeclarations = (): string => {
    let buf = '';
    let depth = 0;
    while (i < stripped.length) {
      const ch = stripped[i]!;
      if (ch === '{') depth++;
      if (ch === '}') { if (depth === 0) { i++; break; } depth--; }
      buf += ch;
      i++;
    }
    return buf;
  };

  const skipBlock = () => {
    let depth = 0;
    while (i < stripped.length) {
      const ch = stripped[i]!;
      if (ch === '{') depth++;
      if (ch === '}') { if (depth === 0) { i++; return; } depth--; }
      i++;
    }
  };

  parseBlock();
  return rules;
}

/** Crude specificity score, enough to order simple selectors correctly. */
export function specificity(selector: string): number {
  const ids = (selector.match(/#[\w-]+/g) ?? []).length;
  const classes = (selector.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+/g) ?? []).length;
  const tags = (selector.match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) ?? []).length;
  return ids * 10000 + classes * 100 + tags;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/** `color.brand.500` -> `--color-brand-500` */
export function tokenToCssVar(name: string): string {
  return `--${name.replace(/\./g, '-')}`;
}

export function tokenRef(name: string): string {
  return `var(${tokenToCssVar(name)})`;
}

/** `{color.lime}` inside a token value -> `var(--color-lime)`. Anything else is left alone. */
export function resolveTokenAliases(value: string): string {
  return value.replace(/\{\s*([\w.-]+)\s*\}/g, (_, name: string) => tokenRef(name));
}

/**
 * A token's literal value for a theme, following `{alias}` chains to the
 * end. Used where a value has to be read rather than emitted (contrast checks).
 */
export function literalTokenValue(
  tokens: readonly { name: string; values: Record<string, string> }[], name: string, theme = 'default',
): string | undefined {
  const seen = new Set<string>();
  let current = name;
  for (;;) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    const t = tokens.find((x) => x.name === current);
    const v = t ? (t.values[theme] ?? t.values.default) : undefined;
    if (v === undefined) return undefined;
    const m = /^\{\s*([\w.-]+)\s*\}$/.exec(v.trim());
    if (!m) return v;
    current = m[1]!;
  }
}

/** Extracts the token name from `var(--color-brand)`, if the value is a ref. */
export function parseTokenRef(value: string): string | null {
  const m = /^var\(\s*--([\w-]+)\s*(?:,.*)?\)$/.exec(value.trim());
  return m ? m[1]!.replace(/-/g, '.') : null;
}
