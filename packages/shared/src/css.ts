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
 * Parses a stylesheet into a flat rule list. Nested at-rules deeper than one
 * level are dropped rather than mis-attributed.
 */
export function parseStylesheet(css: string): CssRule[] {
  const rules: CssRule[] = [];
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let i = 0;

  const parseBlock = (atRule?: string) => {
    let buf = '';
    while (i < stripped.length) {
      const ch = stripped[i]!;
      if (ch === '}') { i++; return; }
      if (ch === '{') {
        i++;
        const prelude = buf.trim();
        buf = '';
        if (prelude.startsWith('@')) {
          if (/^@(media|supports|container|layer)/i.test(prelude) && !atRule) {
            parseBlock(prelude);
          } else {
            skipBlock();
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

/** Extracts the token name from `var(--color-brand)`, if the value is a ref. */
export function parseTokenRef(value: string): string | null {
  const m = /^var\(\s*--([\w-]+)\s*(?:,.*)?\)$/.exec(value.trim());
  return m ? m[1]!.replace(/-/g, '.') : null;
}
