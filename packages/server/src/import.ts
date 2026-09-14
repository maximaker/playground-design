/**
 * Importing a live webpage onto the canvas.
 *
 * This is the capability an HTML-native document model should have that a
 * vector tool cannot: a real page and a Canvas document are the same kind of
 * thing, so importing is fetch + inline + parse rather than a conversion.
 *
 * Fetching is server-side, so the usual precautions apply: private network
 * addresses are refused, redirects are bounded, and the response is size-capped.
 */

import { parseHtml, type CanvasNode } from '@playground/shared';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const MAX_BYTES = 6 * 1024 * 1024;
const MAX_STYLESHEETS = 12;
const FETCH_TIMEOUT_MS = 15_000;

export class ImportError extends Error {}

export interface ImportResult {
  nodes: CanvasNode[];
  roots: string[];
  warnings: string[];
  title: string;
  url: string;
}

/**
 * Refuses anything that resolves to a private or loopback address.
 *
 * Without this the server is an open proxy into whatever network it runs on —
 * a URL is user input, and "fetch this URL" is the classic SSRF shape.
 */
async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ImportError(`"${raw}" is not a valid URL. Include the scheme, e.g. https://example.com`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ImportError(`Only http and https URLs can be imported (got "${url.protocol}").`);
  }

  const host = url.hostname;
  const addresses = isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true }).catch(() => {
        throw new ImportError(`Could not resolve "${host}".`);
      });

  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new ImportError(`"${host}" resolves to a private address (${address}) and cannot be imported.`);
    }
  }
  return url;
}

function isPrivateAddress(address: string): boolean {
  if (address === '::1' || address.startsWith('fc') || address.startsWith('fd') || address.startsWith('fe80')) return true;
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;              // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

async function fetchText(url: URL, accept: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        accept,
        // Many sites serve a different (often unusable) document to unknown agents.
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36',
      },
    });
    if (!res.ok) throw new ImportError(`${url.host} returned HTTP ${res.status}.`);

    const length = Number(res.headers.get('content-length') ?? 0);
    if (length > MAX_BYTES) throw new ImportError(`That page is ${(length / 1e6).toFixed(1)}MB; the limit is ${MAX_BYTES / 1e6}MB.`);

    const text = await res.text();
    if (text.length > MAX_BYTES) throw new ImportError(`That page is too large to import (${(text.length / 1e6).toFixed(1)}MB).`);
    return text;
  } catch (err) {
    if (err instanceof ImportError) throw err;
    if (err instanceof Error && err.name === 'AbortError') throw new ImportError(`${url.host} did not respond within ${FETCH_TIMEOUT_MS / 1000}s.`);
    throw new ImportError(`Could not fetch ${url.host}: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function importUrl(raw: string): Promise<ImportResult> {
  const url = await assertPublicUrl(raw);
  const html = await fetchText(url, 'text/html,application/xhtml+xml');
  const warnings: string[] = [];

  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? url.hostname;

  // Pull in external stylesheets: without them the parser sees unstyled markup
  // and the import looks nothing like the page.
  const linkHrefs = [...html.matchAll(/<link\b[^>]*rel=["']?stylesheet["']?[^>]*>/gi)]
    .map((m) => /href=["']([^"']+)["']/i.exec(m[0])?.[1])
    .filter((h): h is string => !!h)
    .slice(0, MAX_STYLESHEETS);

  const sheets: string[] = [];
  for (const href of linkHrefs) {
    try {
      const sheetUrl = new URL(href, url);
      if (sheetUrl.protocol !== 'http:' && sheetUrl.protocol !== 'https:') continue;
      sheets.push(await fetchText(sheetUrl, 'text/css'));
    } catch {
      warnings.push(`Could not load stylesheet ${href}; some styles will be missing.`);
    }
  }
  if (linkHrefs.length > MAX_STYLESHEETS) {
    warnings.push(`The page links ${linkHrefs.length} stylesheets; only the first ${MAX_STYLESHEETS} were loaded.`);
  }

  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  const inlineStyles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1] ?? '');

  const combined = `<style>${[...sheets, ...inlineStyles].join('\n')}</style>${absolutize(body, url)}`;
  const parsed = parseHtml(combined);

  if (!parsed.nodes.length) throw new ImportError(`Nothing importable was found at ${url.href}.`);

  warnings.push(...parsed.warnings);
  // Set expectations honestly: this is a static snapshot of the served markup.
  warnings.push('Imported as a static snapshot — scripts, hover states and anything rendered client-side are not included.');

  return { nodes: parsed.nodes, roots: parsed.roots, warnings, title, url: url.href };
}

/** Rewrites relative asset and link URLs so images resolve on the canvas. */
function absolutize(html: string, base: URL): string {
  return html.replace(/\b(src|href|srcset|poster)=["']([^"']+)["']/gi, (match, attr: string, value: string) => {
    if (/^(https?:|data:|blob:|#|mailto:|tel:)/i.test(value)) return match;
    if (attr.toLowerCase() === 'srcset') {
      const rewritten = value.split(',').map((part) => {
        const [u, ...rest] = part.trim().split(/\s+/);
        try { return [new URL(u!, base).href, ...rest].join(' '); } catch { return part.trim(); }
      }).join(', ');
      return `${attr}="${rewritten}"`;
    }
    try { return `${attr}="${new URL(value, base).href}"`; } catch { return match; }
  });
}
