/**
 * Publishing a document as a plain web page.
 *
 * The documents here are already HTML and CSS, so "publish" is not an export —
 * it is serving what is already there at a URL with no editor around it and no
 * account required. That is the difference between a design tool that claims to
 * be HTML-native and one that is.
 *
 * The page is rendered from the document on every request rather than frozen at
 * publish time. This is a design tool: the point of a link is that it keeps up
 * with the work, and a "republish" button people forget to press is a link that
 * quietly shows last week.
 */

import { emitStandalone, getArtboardSize, type CanvasDocument, type NodeId } from '@playground/shared';
import { persistence, type StoredPublication } from './persistence.ts';

/** Reserved so a published page can never shadow a route. */
const RESERVED = new Set([
  'api', 'assets', 'mcp', 'd', 's', 'p', 'join', 'new', 'admin', 'static', 'health', 'index',
]);

export function slugify(name: string): string {
  const base = name.toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60)
    .replace(/^-|-$/g, '');
  return base || 'page';
}

/** A free slug near the one asked for: `deck`, then `deck-2`, `deck-3`. */
export async function freeSlug(wanted: string, docId: string): Promise<string> {
  const store = await persistence();
  const base = slugify(wanted);
  for (let n = 1; n < 500; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (RESERVED.has(candidate)) continue;
    const taken = await store.loadPublication(candidate);
    // Its own slug is not "taken" — republishing under the same name is fine.
    if (!taken || taken.docId === docId) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/**
 * The artboard a publication shows.
 *
 * The chosen one, or the first on the first page. Deliberately *not* the
 * busiest, which is the right guess for a thumbnail and the wrong one here: the
 * busiest artboard in a real document turned out to be the foundations sheet,
 * and publishing a colour-swatch reference as someone's website is a confident
 * kind of wrong. Choosing is the author's job; this is only the fallback.
 */
export function pageArtboard(doc: CanvasDocument, chosen: string | null): NodeId | null {
  if (chosen && doc.nodes[chosen]) return chosen;
  for (const page of doc.pages) {
    if (page.artboards.length) return page.artboards[0]!;
  }
  return null;
}

/**
 * The published HTML.
 *
 * Two adjustments to the standalone emit, both about the difference between an
 * artboard and a page:
 *
 *  - an artboard has a fixed width and height, which on a real page would be a
 *    1,440px-wide block on a phone and a scrollbar on a laptop. The frame is
 *    released to fill the viewport, and the media queries inside it — which
 *    were written against the artboard's width — then resolve against the
 *    window, which is what they were always for.
 *  - `<head>` gets a title, a description and the fonts the document uses.
 */
export function publishedHtml(
  doc: CanvasDocument, artboardId: NodeId, pub: StoredPublication, canonical: string,
): string {
  const html = emitStandalone(doc, artboardId, { mode: 'stylesheet' });
  const { width } = getArtboardSize(doc.nodes[artboardId]!);

  const head = `
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="description" content="${escapeAttr(pub.description ?? '')}" />
<meta property="og:title" content="${escapeAttr(pub.title)}" />
<meta property="og:description" content="${escapeAttr(pub.description ?? '')}" />
<meta property="og:url" content="${escapeAttr(canonical)}" />
<link rel="canonical" href="${escapeAttr(canonical)}" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" />
<style>
  /* The artboard becomes the page: full width, natural height, and its own
     background carried up to the document so there is no band of white under a
     short page. */
  html, body { margin: 0; padding: 0; min-height: 100%; }
  body > [data-artboard], body > :first-child {
    width: 100% !important;
    max-width: 100% !important;
    height: auto !important;
    min-height: 100vh;
    overflow: visible !important;
  }
  /* Authored against a ${Math.round(width)}px frame; on a narrower window the
     media queries in the document take over from here. */
  img, video, svg { max-width: 100%; }
</style>`;

  return html
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeText(pub.title)}</title>`)
    .replace('</head>', `${head}\n</head>`);
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
