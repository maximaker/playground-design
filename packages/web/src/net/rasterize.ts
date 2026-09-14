/**
 * In-browser rasterization, used when the server has no Playwright install.
 *
 * Renders a node to PNG by cloning it into an SVG <foreignObject>. This is the
 * standard trick and it has real limits: cross-origin images and web fonts must
 * be inlined first or they drop out, and anything drawn by script (canvas,
 * WebGL) will not appear. Those limits are why the server prefers Playwright
 * and only falls back to here.
 */

import type { NodeId } from '@playground/shared';
import { findElement } from '../canvas/registry.ts';

export async function rasterizeNode(nodeId: NodeId, scale = 1, format = 'png'): Promise<string> {
  const el = findElement(nodeId);
  if (!el) throw new Error(`node ${nodeId} is not currently rendered`);

  const doc = el.ownerDocument;
  const rect = el.getBoundingClientRect();
  const width = Math.max(1, Math.ceil(rect.width));
  const height = Math.max(1, Math.ceil(rect.height));

  const clone = el.cloneNode(true) as HTMLElement;
  await inlineImages(clone);
  inlineComputedStyles(el, clone);

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width * scale}" height="${height * scale}" viewBox="0 0 ${width} ${height}">` +
    `<foreignObject width="100%" height="100%">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${width}px;height:${height}px">` +
    new XMLSerializer().serializeToString(clone) +
    `</div></foreignObject></svg>`;

  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error(
      'Could not rasterize this node in the browser. Install Playwright on the server for reliable screenshots.',
    ));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });

  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const mime = format === 'jpg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';
  return canvas.toDataURL(mime).split(',')[1]!;
}

/**
 * foreignObject only honours styles that travel with the markup, so every
 * computed declaration has to be written onto the clone.
 */
function inlineComputedStyles(source: Element, clone: Element): void {
  const view = source.ownerDocument.defaultView;
  if (!view) return;
  const computed = view.getComputedStyle(source);
  const decls: string[] = [];
  for (let i = 0; i < computed.length; i++) {
    const prop = computed[i]!;
    decls.push(`${prop}:${computed.getPropertyValue(prop)}`);
  }
  (clone as HTMLElement).setAttribute('style', decls.join(';'));

  const sourceKids = [...source.children];
  const cloneKids = [...clone.children];
  for (let i = 0; i < sourceKids.length && i < cloneKids.length; i++) {
    inlineComputedStyles(sourceKids[i]!, cloneKids[i]!);
  }
}

async function inlineImages(clone: HTMLElement): Promise<void> {
  const imgs: HTMLImageElement[] = [];
  if (clone.tagName === 'IMG') imgs.push(clone as HTMLImageElement);
  imgs.push(...Array.from(clone.querySelectorAll('img')));

  await Promise.all(imgs.map(async (img) => {
    const src = img.getAttribute('src');
    if (!src || src.startsWith('data:')) return;
    try {
      const res = await fetch(src);
      img.setAttribute('src', await blobToDataUrl(await res.blob()));
    } catch {
      // A missing image should not fail the whole screenshot.
      img.removeAttribute('src');
    }
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
