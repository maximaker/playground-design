/**
 * Token interchange with a codebase.
 *
 * Playground runs in a browser and cannot read a repository; the agent
 * connected over MCP can. So sync is shaped around that: the agent reads
 * `tailwind.config` or a stylesheet and pushes tokens in, pulls them back out
 * in whichever format the project uses, and `diffTokens` says what drifted.
 *
 * Without this the token system is decorative — it is real CSS, but it parts
 * company with the codebase the moment either side changes.
 */

import { type CanvasDocument, type Token, type TokenGroup } from './model.ts';
import { parseStylesheet } from './css.ts';

export type TokenFormat = 'css' | 'tailwind' | 'json';

/** `color.brand.500` -> `--color-brand-500` */
export function cssVarName(tokenName: string): string {
  return `--${tokenName.replace(/\./g, '-')}`;
}

/**
 * `--color-brand-500` -> `color.brand.500`, using the declared groups so a
 * hyphenated name like `color.on-brand` survives the round trip.
 */
export function tokenNameFromVar(cssVar: string, known: readonly string[] = []): string {
  const bare = cssVar.replace(/^--/, '');
  const match = known.find((name) => name.replace(/\./g, '-') === bare);
  if (match) return match;

  // Otherwise the first segment is the group and the rest is the path.
  const [head, ...rest] = bare.split('-');
  return rest.length ? `${head}.${rest.join('-')}` : bare;
}

const GROUP_BY_PREFIX: Record<string, TokenGroup> = {
  color: 'color', colour: 'color', bg: 'color', text: 'color',
  space: 'space', spacing: 'space', gap: 'space',
  radius: 'radius', rounded: 'radius',
  font: 'font', text_: 'font',
  shadow: 'shadow', elevation: 'shadow',
  duration: 'duration', transition: 'duration', ease: 'duration',
};

export function groupFor(name: string, value: string): TokenGroup {
  const prefix = name.split('.')[0]!.toLowerCase();
  const byName = GROUP_BY_PREFIX[prefix];
  if (byName) return byName;

  // Fall back to the shape of the value.
  if (/^#|^rgb|^hsl|^oklch/i.test(value.trim())) return 'color';
  if (/^\d+m?s$/i.test(value.trim())) return 'duration';
  if (/(px|rem|em)\s|\d+px\s+\d+px/.test(value)) return 'shadow';
  if (/^[\d.]+(px|rem|em)$/.test(value.trim())) return 'space';
  return 'color';
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface ParsedTokens {
  tokens: Token[];
  /** Theme names found, in declaration order. */
  themes: string[];
  warnings: string[];
}

/**
 * Reads custom properties out of a stylesheet.
 *
 * `:root` is the default theme; `:root[data-theme="dark"]`, `.dark` and
 * `[data-theme=dark]` are read as named themes, which covers how most projects
 * actually write them.
 */
export function parseTokensFromCss(css: string, known: readonly string[] = []): ParsedTokens {
  const rules = parseStylesheet(css);
  const byName = new Map<string, Token>();
  const themes = new Set<string>(['default']);
  const warnings: string[] = [];

  for (const rule of rules) {
    for (const selector of rule.selector.split(',').map((s) => s.trim())) {
      const theme = themeForSelector(selector);
      if (theme === null) continue;
      themes.add(theme);

      for (const [prop, value] of Object.entries(rule.styles)) {
        if (!prop.startsWith('--')) continue;
        const name = tokenNameFromVar(prop, known);
        const existing = byName.get(name);
        if (existing) existing.values[theme] = value;
        else byName.set(name, { name, group: groupFor(name, value), values: { [theme]: value } });
      }
    }
  }

  const tokens = [...byName.values()];
  for (const token of tokens) {
    if (!token.values.default) {
      // A token defined only inside a theme has nothing to fall back to.
      const first = Object.values(token.values)[0]!;
      token.values.default = first;
      warnings.push(`"${token.name}" is only defined for a theme; using that value as the default.`);
    }
  }

  if (!tokens.length) warnings.push('No custom properties found. Tokens are read from --custom-property declarations.');
  return { tokens, themes: [...themes], warnings };
}

function themeForSelector(selector: string): string | null {
  const s = selector.trim();
  if (s === ':root' || s === 'html' || s === ':host') return 'default';
  const attr = /\[data-theme\s*=\s*["']?([\w-]+)["']?\]/.exec(s);
  if (attr) return attr[1]!;
  const cls = /^(?::root|html)?\.([\w-]+)$/.exec(s);
  if (cls) return cls[1]!;
  return null;
}

/**
 * Reads a Tailwind theme object — what an agent gets from importing
 * `tailwind.config.js` and handing over `theme.extend` (or `theme`).
 */
export function parseTokensFromTailwind(theme: Record<string, unknown>): ParsedTokens {
  const tokens: Token[] = [];
  const warnings: string[] = [];

  const sections: [string, TokenGroup][] = [
    ['colors', 'color'], ['spacing', 'space'], ['borderRadius', 'radius'],
    ['fontSize', 'font'], ['fontFamily', 'font'], ['boxShadow', 'shadow'],
    ['transitionDuration', 'duration'],
  ];

  for (const [key, group] of sections) {
    const section = theme[key];
    if (!section || typeof section !== 'object') continue;
    flatten(section as Record<string, unknown>, key === 'colors' ? 'color' : prefixFor(key), (name, value) => {
      tokens.push({ name, group, values: { default: value } });
    }, warnings);
  }

  if (!tokens.length) warnings.push('Nothing recognised. Pass the theme object, e.g. the value of `theme.extend`.');
  return { tokens, themes: ['default'], warnings };
}

function prefixFor(key: string): string {
  return { spacing: 'space', borderRadius: 'radius', fontSize: 'font.size', fontFamily: 'font.family', boxShadow: 'shadow', transitionDuration: 'duration' }[key] ?? key;
}

function flatten(
  value: Record<string, unknown>,
  prefix: string,
  emit: (name: string, value: string) => void,
  warnings: string[],
): void {
  for (const [key, raw] of Object.entries(value)) {
    // Tailwind uses DEFAULT for the unsuffixed value of a scale.
    const name = key === 'DEFAULT' ? prefix : `${prefix}.${key}`;
    if (typeof raw === 'string') { emit(name, raw); continue; }
    if (Array.isArray(raw)) { emit(name, String(raw[0])); continue; }
    if (raw && typeof raw === 'object') { flatten(raw as Record<string, unknown>, name, emit, warnings); continue; }
    warnings.push(`Skipped "${name}": ${typeof raw} is not a token value.`);
  }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export function serializeTokens(doc: CanvasDocument, format: TokenFormat): string {
  if (format === 'json') return JSON.stringify(toDesignTokensJson(doc), null, 2);
  if (format === 'tailwind') return toTailwindConfig(doc);
  return toCss(doc);
}

function toCss(doc: CanvasDocument): string {
  const blocks: string[] = [];
  for (const theme of doc.themes.length ? doc.themes : ['default']) {
    const decls = doc.tokens
      .map((t) => {
        const value = theme === 'default' ? (t.values.default ?? '') : t.values[theme];
        // Only emit what a theme actually overrides; the rest cascades.
        return value && (theme === 'default' || value !== t.values.default)
          ? `  ${cssVarName(t.name)}: ${value};`
          : '';
      })
      .filter(Boolean);
    if (!decls.length) continue;
    const selector = theme === 'default' ? ':root' : `:root[data-theme="${theme}"]`;
    blocks.push(`${selector} {\n${decls.join('\n')}\n}`);
  }
  return blocks.join('\n\n');
}

function toTailwindConfig(doc: CanvasDocument): string {
  const groups: Record<TokenGroup, string> = {
    color: 'colors', space: 'spacing', radius: 'borderRadius',
    font: 'fontSize', shadow: 'boxShadow', duration: 'transitionDuration',
  };

  const theme: Record<string, unknown> = {};
  for (const token of doc.tokens) {
    const section = groups[token.group];
    const path = token.name.split('.');
    // Drop the group prefix: `color.brand.500` sits at colors.brand.500.
    const keys = path.length > 1 ? path.slice(1) : path;
    const bucket = (theme[section] ??= {}) as Record<string, unknown>;
    let cursor = bucket;
    for (let i = 0; i < keys.length - 1; i++) {
      cursor = (cursor[keys[i]!] ??= {}) as Record<string, unknown>;
    }
    // Point at the CSS variable rather than the literal, so switching theme in
    // the browser switches the Tailwind classes too.
    cursor[keys[keys.length - 1]!] = `var(${cssVarName(token.name)})`;
  }

  return `/** Generated from Playground. Values reference the CSS variables, so themes work at runtime. */
export default {
  theme: {
    extend: ${JSON.stringify(theme, null, 6).replace(/\n/g, '\n  ')},
  },
};`;
}

function toDesignTokensJson(doc: CanvasDocument): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const typeFor: Record<TokenGroup, string> = {
    color: 'color', space: 'dimension', radius: 'dimension',
    font: 'fontFamily', shadow: 'shadow', duration: 'duration',
  };

  for (const token of doc.tokens) {
    const keys = token.name.split('.');
    let cursor = out;
    for (let i = 0; i < keys.length - 1; i++) {
      cursor = (cursor[keys[i]!] ??= {}) as Record<string, unknown>;
    }
    cursor[keys[keys.length - 1]!] = {
      $type: typeFor[token.group],
      $value: token.values.default ?? '',
      ...(Object.keys(token.values).length > 1
        ? { $extensions: { 'playground.themes': token.values } }
        : {}),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

export interface TokenDiff {
  added: Token[];
  removed: Token[];
  changed: { name: string; theme: string; from: string; to: string }[];
  unchanged: number;
}

/** What differs between the document's tokens and a set read from code. */
export function diffTokens(current: readonly Token[], incoming: readonly Token[]): TokenDiff {
  const byName = new Map(current.map((t) => [t.name, t]));
  const incomingNames = new Set(incoming.map((t) => t.name));

  const added: Token[] = [];
  const changed: TokenDiff['changed'] = [];
  let unchanged = 0;

  for (const token of incoming) {
    const existing = byName.get(token.name);
    if (!existing) { added.push(token); continue; }

    let differs = false;
    for (const [theme, value] of Object.entries(token.values)) {
      const before = existing.values[theme];
      if (before !== value) {
        changed.push({ name: token.name, theme, from: before ?? '(unset)', to: value });
        differs = true;
      }
    }
    if (!differs) unchanged++;
  }

  return {
    added,
    removed: current.filter((t) => !incomingNames.has(t.name)),
    changed,
    unchanged,
  };
}

/**
 * Merges incoming tokens into the current set.
 *
 * `removeMissing` is off by default: a stylesheet usually holds part of a
 * design system, and deleting every token it happens not to mention would be a
 * destructive surprise.
 */
export function mergeTokens(
  current: readonly Token[],
  incoming: readonly Token[],
  options: { removeMissing?: boolean } = {},
): Token[] {
  const byName = new Map(current.map((t) => [t.name, { ...t, values: { ...t.values } }]));

  for (const token of incoming) {
    const existing = byName.get(token.name);
    if (existing) {
      Object.assign(existing.values, token.values);
      existing.group = token.group;
    } else {
      byName.set(token.name, { ...token, values: { ...token.values } });
    }
  }

  if (options.removeMissing) {
    const keep = new Set(incoming.map((t) => t.name));
    for (const name of [...byName.keys()]) if (!keep.has(name)) byName.delete(name);
  }

  return [...byName.values()];
}
