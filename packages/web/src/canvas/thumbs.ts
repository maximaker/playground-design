/**
 * Static thumbnails for artboards that are not worth a live iframe.
 *
 * Every live artboard is a whole document with its own layout and style engine.
 * Thirty phone frames on one page was thirty of those, and a tab that froze on
 * load and again on zoom-to-fit. Far out, or off screen, an artboard only needs
 * to look right — so it is drawn as a bitmap instead.
 *
 * The bitmap comes from the document model, not from a frame: the artboard is
 * emitted as HTML (the same path export uses), laid out once inside an SVG
 * <foreignObject>, and drawn to a canvas. That means a frame that has never been
 * on screen still gets a picture, and an edit made by someone else while it was
 * off screen still shows. Its limits are the foreignObject ones (see
 * net/rasterize.ts): web fonts fall back, and script-drawn content is absent.
 * Images are inlined, and cached, so they do appear.
 */

import { useSyncExternalStore } from 'react';
import type { CanvasDocument, NodeId } from '@playground/shared';
import { emitHtml, getArtboardSize } from '@playground/shared';

/** Pixels per canvas pixel. Thumbnails are only shown below LIVE_ZOOM, so this
 *  covers a 2x screen out to there without drawing more than needed. */
export const THUMB_SCALE = 0.75;
/** Below this zoom every artboard is a thumbnail, visible or not. */
export const LIVE_ZOOM = 0.35;

interface Entry { key: string; url: string }

const cache = new Map<NodeId, Entry>();
const listeners = new Set<() => void>();
let epoch = 0;

const queue = new Map<NodeId, () => { doc: CanvasDocument; theme: string } | null>();
let pumping = false;

function notify() {
  epoch++;
  for (const l of listeners) l();
}

/** The current thumbnail for an artboard, re-rendering when any arrives. */
export function useThumb(id: NodeId): string | null {
  useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => epoch,
  );
  return cache.get(id)?.url ?? null;
}

export function getThumb(id: NodeId): string | null {
  return cache.get(id)?.url ?? null;
}

/**
 * Asks for an artboard's thumbnail to be (re)drawn when the browser is idle.
 * `read` is called at draw time, so a burst of edits costs one draw, against
 * the document as it is by then.
 */
export function requestThumb(id: NodeId, read: () => { doc: CanvasDocument; theme: string } | null): void {
  queue.set(id, read);
  if (!pumping) { pumping = true; idle(pump); }
}

function idle(fn: () => void) {
  const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
  if (ric) ric(fn, { timeout: 300 }); else setTimeout(fn, 16);
}

async function pump() {
  // One at a time: each draw is a layout and a decode, and doing all thirty
  // in one task is the stall this module exists to avoid.
  const next = queue.entries().next();
  if (next.done) { pumping = false; return; }
  const [id, read] = next.value;
  queue.delete(id);
  try {
    const src = read();
    if (src) await draw(id, src.doc, src.theme);
  } catch {
    // A frame that cannot be drawn keeps its plain placeholder.
  }
  idle(pump);
}

async function draw(id: NodeId, doc: CanvasDocument, theme: string) {
  const node = doc.nodes[id];
  if (!node) return;
  const { width, height } = getArtboardSize(node);
  const { html, css } = emitHtml(doc, id, { mode: 'stylesheet', theme, pretty: false });
  const key = `${width}x${height}|${theme}|${css}|${html}`;
  if (cache.get(id)?.key === key) return;

  // emitHtml writes HTML, and foreignObject wants XML: let the HTML parser
  // read it, then serialise what it built.
  const parsed = new DOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, 'text/html');
  await inlineImages(parsed.body);
  for (const el of Array.from(parsed.body.querySelectorAll<HTMLElement>('[style*="url("]'))) {
    el.setAttribute('style', await inlineCssUrls(el.getAttribute('style') ?? ''));
  }
  const sheet = await inlineCssUrls(css);
  const body = new XMLSerializer().serializeToString(parsed.body)
    .replace(/^<body[^>]*>/, '').replace(/<\/body>$/, '');

  const style = `*,*::before,*::after{box-sizing:border-box}` +
    `.thumb-root{width:${width}px;height:${height}px;overflow:hidden;margin:0;background:#fff}` + sheet;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<foreignObject x="0" y="0" width="${width}" height="${height}">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" class="thumb-root">` +
    `<style>${escapeXml(style)}</style>${body}</div></foreignObject></svg>`;

  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('thumbnail failed'));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * THUMB_SCALE));
  canvas.height = Math.max(1, Math.round(height * THUMB_SCALE));
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
  if (!blob) return;

  const old = cache.get(id);
  cache.set(id, { key, url: URL.createObjectURL(blob) });
  // Revoked a moment later, so an <img> mid-swap does not lose its source.
  if (old) setTimeout(() => URL.revokeObjectURL(old.url), 1000);
  notify();
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

const images = new Map<string, Promise<string | null>>();

function fetchAsData(src: string): Promise<string | null> {
  let p = images.get(src);
  if (!p) {
    p = fetch(src).then((r) => (r.ok ? r.blob() : null)).then((b) => (b ? blobToDataUrl(b) : null)).catch(() => null);
    images.set(src, p);
  }
  return p;
}

/*
 * An SVG drawn as an image loads nothing from outside itself, so background
 * images (every image pasted from Figma) showed only on the live frame, which
 * is why slides had pictures only once selected. They are inlined like <img>.
 */
async function inlineCssUrls(css: string): Promise<string> {
  const re = /url\(\s*(['"]?)([^'")]+)\s*\)/g;
  const urls = [...new Set([...css.matchAll(re)].map((m) => m[2]!).filter((u) => !u.startsWith('data:') && !u.startsWith('#')))];
  if (!urls.length) return css;
  const data = new Map(await Promise.all(urls.map(async (u) => [u, await fetchAsData(u)] as const)));
  return css.replace(re, (all, _q, u: string) => {
    const d = data.get(u);
    return d ? `url('${d}')` : all;
  });
}

async function inlineImages(root: HTMLElement): Promise<void> {
  const imgs = Array.from(root.querySelectorAll('img'));
  await Promise.all(imgs.map(async (img) => {
    const src = img.getAttribute('src');
    if (!src || src.startsWith('data:')) return;
    img.removeAttribute('srcset');
    const data = await fetchAsData(src);
    if (data) img.setAttribute('src', data); else img.removeAttribute('src');
  }));
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('could not read image'));
    reader.readAsDataURL(blob);
  });
}
