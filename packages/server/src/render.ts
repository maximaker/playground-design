/**
 * Rasterization and export.
 *
 * Two backends, tried in order:
 *  1. Playwright, if installed. Works with no browser tab open, which is what
 *     makes headless agent sessions possible.
 *  2. The connected tab, via RPC. Always available when a human has the
 *     document open, and needs no extra install.
 *
 * SVG export needs neither, since vector nodes already hold SVG source.
 */

import { emitStandalone, getNode, getArtboardSize, type CanvasDocument, type NodeId } from '@canvas/shared';
import { callTab, NoTabError } from './realtime.ts';

export type RenderFormat = 'png' | 'jpg' | 'webp' | 'svg' | 'html';

export interface RenderOptions {
  format: RenderFormat;
  scale?: number;
  /** Absolute origin so `/assets/...` references resolve during headless render. */
  baseUrl?: string;
  quality?: number;
}

export interface RenderResult {
  data: Buffer;
  mime: string;
}

const MIME: Record<RenderFormat, string> = {
  png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp',
  svg: 'image/svg+xml', html: 'text/html',
};

export async function renderNode(
  doc: CanvasDocument,
  nodeId: NodeId,
  opts: RenderOptions,
): Promise<RenderResult> {
  const node = getNode(doc, nodeId);
  if (!node) throw new Error(`node ${nodeId} not found`);

  if (opts.format === 'html') {
    return { data: Buffer.from(emitStandalone(doc, nodeId), 'utf8'), mime: MIME.html };
  }

  if (opts.format === 'svg') {
    if (node.type !== 'vector') {
      throw new Error(
        `SVG export needs a vector node; ${nodeId} is a ${node.type}. Export it as PNG, or select the vector inside it.`,
      );
    }
    const { width, height } = sizeOf(doc, nodeId);
    const attrs = Object.entries(node.attrs).map(([k, v]) => `${k}="${v}"`).join(' ');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${node.attrs.viewBox ?? `0 0 ${width} ${height}`}" ${attrs}>${node.text ?? ''}</svg>`;
    return { data: Buffer.from(svg, 'utf8'), mime: MIME.svg };
  }

  const playwright = await tryLoadPlaywright();
  if (playwright) return renderWithPlaywright(playwright, doc, nodeId, opts);

  try {
    const base64 = await callTab<string>(doc.id, 'screenshot', {
      nodeId, format: opts.format, scale: opts.scale ?? 1,
    }, 30_000);
    return { data: Buffer.from(base64, 'base64'), mime: MIME[opts.format] };
  } catch (err) {
    if (err instanceof NoTabError) {
      throw new Error(
        `Cannot rasterize: Playwright is not installed and no browser tab is connected. ` +
        `Either open the document in Canvas, or run "npm i -D playwright && npx playwright install chromium" ` +
        `in the server package to enable headless rendering.`,
      );
    }
    throw err;
  }
}

function sizeOf(doc: CanvasDocument, nodeId: NodeId): { width: number; height: number } {
  const node = getNode(doc, nodeId)!;
  if (node.type === 'artboard') return getArtboardSize(node);
  const w = parseFloat(node.styles.width ?? '') || 0;
  const h = parseFloat(node.styles.height ?? '') || 0;
  return { width: w || 800, height: h || 600 };
}

// ---------------------------------------------------------------------------
// Playwright backend (optional dependency)
// ---------------------------------------------------------------------------

/**
 * Playwright is an optional dependency, so it is typed structurally rather than
 * imported for types — the server must compile without it installed.
 */
interface PlaywrightPage {
  setContent(html: string, opts?: { waitUntil?: string }): Promise<void>;
  evaluate(fn: () => unknown): Promise<unknown>;
  $(selector: string): Promise<PlaywrightElement | null>;
  screenshot(opts: Record<string, unknown>): Promise<Uint8Array>;
}
interface PlaywrightElement { screenshot(opts: Record<string, unknown>): Promise<Uint8Array> }
interface PlaywrightContext { newPage(): Promise<PlaywrightPage>; close(): Promise<void> }
interface PlaywrightBrowser {
  newContext(opts: Record<string, unknown>): Promise<PlaywrightContext>;
  close(): Promise<void>;
}
interface PlaywrightModule {
  chromium: { launch(opts?: Record<string, unknown>): Promise<PlaywrightBrowser> };
}

let playwrightCache: PlaywrightModule | null | undefined;
let browserPromise: Promise<PlaywrightBrowser> | null = null;

async function tryLoadPlaywright(): Promise<PlaywrightModule | null> {
  if (playwrightCache !== undefined) return playwrightCache;
  try {
    playwrightCache = (await import(/* @vite-ignore */ 'playwright' as string)) as PlaywrightModule;
  } catch {
    playwrightCache = null;
  }
  return playwrightCache;
}

async function getBrowser(pw: PlaywrightModule) {
  // One browser, reused: launching per screenshot costs ~400ms and agents take
  // screenshots in tight loops while checking their own work.
  if (!browserPromise) {
    browserPromise = pw.chromium.launch({ args: ['--font-render-hinting=none'] }).catch((err: unknown) => {
      browserPromise = null;
      throw new Error(
        `Playwright is installed but Chromium failed to launch (${err instanceof Error ? err.message : err}). ` +
        `Run "npx playwright install chromium".`,
      );
    });
  }
  return browserPromise;
}

async function renderWithPlaywright(
  pw: PlaywrightModule,
  doc: CanvasDocument,
  nodeId: NodeId,
  opts: RenderOptions,
): Promise<RenderResult> {
  const { width, height } = sizeOf(doc, nodeId);
  const scale = clampScale(opts.scale);
  const browser = await getBrowser(pw);
  const context = await browser.newContext({
    viewport: { width: Math.ceil(width), height: Math.ceil(height) },
    deviceScaleFactor: scale,
  });
  const page = await context.newPage();
  try {
    let html = emitStandalone(doc, nodeId, { mode: 'stylesheet' });
    if (opts.baseUrl) html = html.replace('<head>', `<head>\n<base href="${opts.baseUrl}" />`);

    await page.setContent(html, { waitUntil: 'networkidle' });
    // Web fonts are requested after first paint; without this, text rasterizes
    // in the fallback face.
    await page.evaluate(() => (document as unknown as { fonts: FontFaceSet }).fonts.ready);

    const target = (await page.$('body > *')) ?? page;
    const buf = await target.screenshot({
      type: opts.format === 'jpg' ? 'jpeg' : opts.format === 'webp' ? 'png' : 'png',
      quality: opts.format === 'jpg' ? (opts.quality ?? 90) : undefined,
      omitBackground: false,
    });
    return { data: Buffer.from(buf), mime: MIME[opts.format] };
  } finally {
    await context.close();
  }
}

function clampScale(scale: number | undefined): number {
  const s = Number(scale ?? 1);
  if (!Number.isFinite(s)) return 1;
  return Math.max(1, Math.min(3, s));
}

export async function shutdownRenderer(): Promise<void> {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    await b?.close().catch(() => {});
    browserPromise = null;
  }
}
