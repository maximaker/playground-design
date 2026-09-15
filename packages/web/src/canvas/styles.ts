/** Conversions between the document's CSS-shaped styles and React style objects. */

import type { CanvasDocument, CanvasNode, NodeId, StyleMap } from '@playground/shared';
import { contestedProperties, descendants, fontFamiliesIn } from '@playground/shared';
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

    // The base values for properties a variant contests. They have to be here
    // rather than inline, or the variant can never win the cascade.
    const contested = contestedProperties(node);
    const base = Object.entries(node.styles)
      .filter(([prop, value]) => contested.has(prop) && value)
      .map(([prop, value]) => `  ${prop}: ${value};`)
      .join('\n');
    if (base) blocks.push(`[data-node-id="${id}"] {\n${base}\n}`);

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

/**
 * Font loading lives in shared now: the canvas and the standalone export have
 * to agree about which families a design needs, and they did not — the export
 * asked for none at all.
 */
export { fontFamiliesIn, googleFontsHref } from '@playground/shared';

export function fontFamilies(doc: CanvasDocument, artboardId: NodeId): string[] {
  return fontFamiliesIn(doc, artboardId);
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
