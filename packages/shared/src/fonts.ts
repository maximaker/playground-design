/**
 * Which web fonts a subtree needs, and where to get them.
 *
 * Shared because three places need the same answer and had two of them: the
 * canvas loads fonts into each artboard iframe, and the standalone export —
 * which did not load them at all, so an exported page silently lost its
 * typefaces and reflowed into the system stack.
 */

import type { CanvasDocument, NodeId } from './model.ts';
import { descendants } from './model.ts';
import { cssVarName } from './tokens.ts';

/** Families that are already on the machine, or are not families at all. */
const GENERIC = new Set([
  'inherit', 'initial', 'unset', 'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy',
  'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', '-apple-system',
  'arial', 'helvetica', 'georgia', 'times new roman', 'courier new', 'verdana',
]);

export function fontFamiliesIn(doc: CanvasDocument, rootId: NodeId): string[] {
  const families = new Set<string>();

  /*
   * A family held in a token is a family.
   *
   * `font-family: var(--font-sans)` went into the web-font URL verbatim, which
   * made the whole request invalid — and one malformed family takes every other
   * font in that request down with it, so a document that referenced a single
   * token loaded none of its fonts.
   */
  const resolve = (value: string): string => {
    const ref = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value.trim());
    if (!ref) return value;
    const token = (doc.tokens ?? []).find((t) => cssVarName(t.name) === ref[1]);
    return token ? (token.values.default ?? '') : '';
  };

  for (const id of [rootId, ...descendants(doc, rootId)]) {
    const node = doc.nodes[id];
    if (!node) continue;
    for (const source of [node.styles, ...node.variants.map((v) => v.styles)]) {
      const family = source['font-family'];
      if (!family) continue;
      const first = resolve(family).split(',')[0]!.trim().replace(/^['"]|['"]$/g, '');
      if (first && !GENERIC.has(first.toLowerCase())) families.add(first);
    }
  }
  return [...families];
}

export const GOOGLE_FONT_WEIGHTS = 'ital,wght@0,100;0,200;0,300;0,400;0,500;0,600;0,700;0,800;0,900;1,400;1,700';

export function googleFontsHref(families: readonly string[]): string | null {
  // Anything that is not a plain family name is dropped rather than sent: one
  // bad entry invalidates the request for all of them.
  const usable = families.filter((f) => /^[\w][\w .'-]*$/.test(f));
  if (!usable.length) return null;
  const params = usable
    // A discrete weight list, not a range: Google rejects a range wider than the
    // family's own axis (Plus Jakarta Sans is 200–800, so "100..900" returned
    // 400 and the font silently fell back), but it tolerates listed weights or
    // italics a family does not have. One request still serves every family.
    .map((f) => `family=${encodeURIComponent(f).replace(/%20/g, '+')}:${GOOGLE_FONT_WEIGHTS}`)
    .join('&');
  return `https://fonts.googleapis.com/css2?${params}&display=swap`;
}

/** Every web font family the document asks for, across all pages. */
export function documentFontFamilies(doc: CanvasDocument): string[] {
  const all = new Set<string>();
  for (const page of doc.pages) for (const a of page.artboards) for (const f of fontFamiliesIn(doc, a)) all.add(f);
  return [...all];
}

const probeCache = new Map<string, 'ok' | 'not-google'>();

/**
 * Families that will not load: names the request would drop, and names Google
 * Fonts answers with an error. Each family is asked for on its own, with the
 * same URL the canvas uses, so one bad name cannot hide another. A network
 * failure is not a verdict — those families are left out rather than flagged.
 */
export async function probeFonts(
  families: readonly string[],
  fetcher: (url: string) => Promise<{ ok: boolean; status: number }> = (u) => fetch(u),
): Promise<{ family: string; status: 'not-google' | 'invalid' }[]> {
  const out: { family: string; status: 'not-google' | 'invalid' }[] = [];
  await Promise.all(families.map(async (family) => {
    const href = googleFontsHref([family]);
    if (!href) { out.push({ family, status: 'invalid' }); return; }
    let verdict = probeCache.get(family);
    if (!verdict) {
      try {
        const res = await fetcher(href);
        if (res.ok) verdict = 'ok';
        else if (res.status === 400 || res.status === 404) verdict = 'not-google';
      } catch { /* offline: no verdict */ }
      if (verdict) probeCache.set(family, verdict);
    }
    if (verdict === 'not-google') out.push({ family, status: 'not-google' });
  }));
  return out.sort((a, b) => a.family.localeCompare(b.family));
}
