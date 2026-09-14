/** Conversions between the document's CSS-shaped styles and React style objects. */

import type { CanvasDocument, CanvasNode, NodeId, StyleMap } from '@canvas/shared';
import { descendants } from '@canvas/shared';
import type { CSSProperties } from 'react';

export function toReactStyle(styles: StyleMap): CSSProperties {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(styles)) {
    if (!v) continue;
    // Custom properties must keep their literal name; React passes them through.
    out[k.startsWith('--') ? k : camel(k)] = v;
  }
  return out as CSSProperties;
}

export function camel(prop: string): string {
  return prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

export function kebab(prop: string): string {
  return prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/**
 * Builds the stylesheet for one artboard: token custom properties plus every
 * descendant's variants. Variants (`:hover`, `@media`) cannot be expressed as
 * inline styles, so they have to live in a real stylesheet inside the iframe.
 */
export function artboardStylesheet(doc: CanvasDocument, artboardId: NodeId, theme = 'default'): string {
  const blocks: string[] = [];

  const vars = doc.tokens
    .map((t) => {
      const v = t.values[theme] ?? t.values.default;
      return v ? `  --${t.name.replace(/\./g, '-')}: ${v};` : '';
    })
    .filter(Boolean);
  if (vars.length) blocks.push(`:root {\n${vars.join('\n')}\n}`);

  for (const id of [artboardId, ...descendants(doc, artboardId)]) {
    const node = doc.nodes[id];
    if (!node?.variants.length) continue;
    for (const variant of node.variants) {
      const decls = Object.entries(variant.styles)
        .filter(([, v]) => v)
        .map(([k, v]) => `  ${k}: ${v};`)
        .join('\n');
      if (!decls) continue;
      const sel = `[data-node-id="${id}"]`;
      blocks.push(variant.selector.startsWith('@')
        ? `${variant.selector} {\n${sel} {\n${decls}\n}\n}`
        : `${sel}${variant.selector} {\n${decls}\n}`);
    }
  }

  return blocks.join('\n\n');
}

/** Font families referenced anywhere in an artboard, for Google Fonts loading. */
export function fontFamilies(doc: CanvasDocument, artboardId: NodeId): string[] {
  const families = new Set<string>();
  for (const id of [artboardId, ...descendants(doc, artboardId)]) {
    const node = doc.nodes[id];
    if (!node) continue;
    for (const source of [node.styles, ...node.variants.map((v) => v.styles)]) {
      const family = source['font-family'];
      if (!family) continue;
      const first = family.split(',')[0]!.trim().replace(/^['"]|['"]$/g, '');
      if (first && !GENERIC.has(first.toLowerCase())) families.add(first);
    }
  }
  return [...families];
}

const GENERIC = new Set([
  'inherit', 'initial', 'unset', 'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy',
  'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', '-apple-system',
  'arial', 'helvetica', 'georgia', 'times new roman', 'courier new', 'verdana',
]);

export function googleFontsHref(families: string[]): string | null {
  if (!families.length) return null;
  const params = families
    .map((f) => `family=${encodeURIComponent(f).replace(/%20/g, '+')}:ital,wght@0,100..900;1,100..900`)
    .join('&');
  return `https://fonts.googleapis.com/css2?${params}&display=swap`;
}

/** Whether a node participates in its parent's flex flow. */
export function isInFlexFlow(doc: CanvasDocument, node: CanvasNode): boolean {
  const parent = node.parent ? doc.nodes[node.parent] : null;
  if (!parent) return false;
  const display = parent.styles.display ?? '';
  if (!display.includes('flex') && !display.includes('grid')) return false;
  const pos = node.styles.position;
  return pos !== 'absolute' && pos !== 'fixed';
}

export function parsePx(value: string | undefined, fallback = 0): number {
  if (!value) return fallback;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}
