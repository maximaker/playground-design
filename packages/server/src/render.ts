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

import { emitStandalone, getNode, getArtboardSize, type CanvasDocument, type NodeId } from '@playground/shared';
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
        `Either open the document in Playground, or run "npm i -D playwright && npx playwright install chromium" ` +
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

/**
 * A small picture of the top of an artboard, for the library.
 *
 * Not `renderNode` with a scale: that clamps to 1× and up, because it exists for
 * exports where you never want less detail than the design has. A thumbnail
 * wants exactly the opposite — a 1440×3610 landing page has to come back as a
 * few kilobytes, so the device scale factor goes *below* one and the shot is
 * clipped to the first screenful rather than the whole page. A 3,610px-tall
 * strip scaled to fit a card is a grey smear.
 */
export async function renderThumbnail(
  doc: CanvasDocument,
  nodeId: NodeId,
  opts: {
    width: number;
    ratio: number;
    baseUrl?: string;
    /**
     * Shoot the element rather than a fixed window onto it.
     *
     * A page thumbnail wants the first screenful of something enormous; a
     * component preview wants the whole button, whatever shape it is. `ratio`
     * then only caps how long a thing may be before it gets clipped.
     */
    fit?: boolean;
  },
): Promise<RenderResult | null> {
  const pw = await tryLoadPlaywright();
  // No Playwright, no thumbnail. The caller falls back to the tinted card, which
  // is a perfectly good library; this is not worth failing a request over.
  if (!pw) return null;

  const { width, height } = sizeOf(doc, nodeId);
  const browser = await getBrowser(pw);
  const page = opts.fit
    ? await fitShot(browser, doc, nodeId, opts)
    : await windowShot(browser, doc, nodeId, opts, { width, height });
  return page;
}

/** The first screenful of something, scaled down. Used for page thumbnails. */
async function windowShot(
  browser: PlaywrightBrowser,
  doc: CanvasDocument,
  nodeId: NodeId,
  opts: { width: number; ratio: number; baseUrl?: string },
  size: { width: number; height: number },
): Promise<RenderResult> {
  const scale = Math.min(1, opts.width / Math.max(1, size.width));
  const clipHeight = Math.ceil(Math.min(size.height, size.width / opts.ratio));
  const context = await browser.newContext({
    viewport: { width: Math.ceil(size.width), height: clipHeight },
    deviceScaleFactor: scale,
  });
  const page = await context.newPage();
  try {
    await load(page, doc, nodeId, opts.baseUrl);
    const buf = await page.screenshot({
      type: 'jpeg', quality: 72,
      clip: { x: 0, y: 0, width: Math.ceil(size.width), height: clipHeight },
    });
    return { data: Buffer.from(buf), mime: 'image/jpeg' };
  } finally {
    await context.close();
  }
}

/**
 * The whole element, whatever shape it is. Used for component previews.
 *
 * The element is measured after layout rather than from its styles: a button is
 * `width: fit-content`, so the authored styles say nothing about how wide it
 * actually is, and a viewport guessed from them crops it or floats it in a sea
 * of white.
 */
async function fitShot(
  browser: PlaywrightBrowser,
  doc: CanvasDocument,
  nodeId: NodeId,
  opts: { width: number; ratio: number; baseUrl?: string },
): Promise<RenderResult> {
  const context = await browser.newContext({
    // Wide enough that nothing wraps because of the window, and tall enough not
    // to provoke a scrollbar; the shot is of the element, not the page.
    viewport: { width: 1600, height: 1400 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  try {
    await load(page, doc, nodeId, opts.baseUrl, true);

    // Measure, then scale the element in place and shoot it — rather than
    // reopening the browser at the right size, which is a second page load and
    // doubles what a panel of five previews costs. A CSS transform scales the
    // rendering, not a bitmap, so the text stays sharp.
    const box = (await page.evaluate(`(() => {
      const el = document.body.firstElementChild;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const scale = Math.max(0.1, Math.min(3, ${opts.width} / Math.max(1, r.width)));
      document.body.style.transformOrigin = 'top left';
      document.body.style.transform = 'scale(' + scale + ')';
      return { width: Math.ceil(r.width * scale), height: Math.ceil(r.height * scale) };
    })()` as unknown as () => unknown)) as { width: number; height: number } | null;

    if (!box || box.width === 0 || box.height === 0) {
      throw new Error(`${nodeId} renders to nothing, so there is no preview to take`);
    }
    const buf = await page.screenshot({
      type: 'jpeg', quality: 80,
      clip: {
        x: 0, y: 0,
        width: Math.min(box.width, 1600),
        // Only absurdly long things get cut: a component is usually wider than
        // it is tall, and cropping a card in half is worse than a tall picture.
        height: Math.min(box.height, Math.ceil(box.width / opts.ratio), 1400),
      },
    });
    return { data: Buffer.from(buf), mime: 'image/jpeg' };
  } finally {
    await context.close();
  }
}

/**
 * Typography and sizing a component definition would otherwise not have.
 *
 * A definition has no ancestors, so it inherits nothing: the page sets the font
 * on its root and the button underneath just uses it. Rendered on its own, that
 * button came out in Times, and a card declaring flex: 1 1 0 stretched to the
 * full 1600px window. The document's own tokens are already in the emitted
 * stylesheet, so this only has to point at them.
 */
const INHERITED = `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" />
<style>
  html, body { margin: 0; padding: 0; }
  body {
    font-family: var(--font-sans, 'Inter', system-ui, sans-serif);
    color: var(--color-fg, #171717);
    background: var(--color-bg, #ffffff);
    width: max-content;
    max-width: 760px;
  }
</style>`;

/**
 * Bumped when the preview pipeline itself changes.
 *
 * Previews are cached against a hash of what they show, which correctly ignores
 * everything else — including this file. Adding web fonts to the render changed
 * every picture and invalidated none of them, and the caches had to be deleted
 * by hand to see it.
 */
export const RENDERER_VERSION = 'r3';

async function load(
  page: PlaywrightPage, doc: CanvasDocument, nodeId: NodeId, baseUrl?: string, inherit = false,
  opts: { includeNodeIds?: boolean } = {},
) {
  let html = emitStandalone(doc, nodeId, { mode: 'stylesheet', includeNodeIds: opts.includeNodeIds });
  if (inherit) html = html.replace('</head>', `${INHERITED}\n</head>`);
  if (baseUrl) html = html.replace('<head>', `<head>\n<base href="${baseUrl}" />`);
  await page.setContent(html, { waitUntil: 'networkidle' });
  // Web fonts arrive after first paint; without this, text rasterizes in the
  // fallback face.
  await page.evaluate(() => (document as unknown as { fonts: FontFaceSet }).fonts.ready);
}

/**
 * Measured boxes for a node and its descendants.
 *
 * The spec quotes authored values — `padding: var(--space-6)` is what a
 * developer should write — but the *size* of a thing is only knowable after
 * layout: `width: fit-content` says nothing, and `flex: 1 1 0` says less.
 *
 * `get_computed_styles` can already measure, but only when a browser tab has
 * the document open, which an agent working alone does not have. This renders
 * the artboard headlessly and measures there, so a spec is exact with nobody
 * watching.
 */
export async function measureSubtree(
  doc: CanvasDocument,
  artboardId: NodeId,
  baseUrl?: string,
): Promise<Record<string, { width: number; height: number; x: number; y: number }> | null> {
  const pw = await tryLoadPlaywright();
  if (!pw) return null;

  const { width, height } = sizeOf(doc, artboardId);
  const browser = await getBrowser(pw);
  const context = await browser.newContext({
    viewport: { width: Math.ceil(width), height: Math.ceil(height) },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  try {
    await load(page, doc, artboardId, baseUrl, false, { includeNodeIds: true });
    return (await page.evaluate(`(() => {
      const out = {};
      const root = document.body.firstElementChild;
      const origin = root ? root.getBoundingClientRect() : { left: 0, top: 0 };
      for (const el of document.querySelectorAll('[data-node-id]')) {
        const r = el.getBoundingClientRect();
        out[el.getAttribute('data-node-id')] = {
          width: Math.round(r.width * 100) / 100,
          height: Math.round(r.height * 100) / 100,
          x: Math.round((r.left - origin.left) * 100) / 100,
          y: Math.round((r.top - origin.top) * 100) / 100,
        };
      }
      return out;
    })()` as unknown as () => unknown)) as Record<string, { width: number; height: number; x: number; y: number }>;
  } finally {
    await context.close();
  }
}

export async function shutdownRenderer(): Promise<void> {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    await b?.close().catch(() => {});
    browserPromise = null;
  }
}
