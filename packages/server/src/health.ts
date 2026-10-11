/**
 * Document health: the facts the lint rules cannot compute from the model.
 *
 * Fonts need the network (does Google Fonts actually serve this family?),
 * clipping needs a layout engine, and stylesheet coverage only exists at the
 * moment HTML is parsed — the rules are resolved onto nodes and then gone. This
 * gathers all three so `lint_design` and the Check tab report the same thing.
 */

import {
  type CanvasDocument, type HealthFacts, type NodeId, type StyleRuleStat, type OverflowFact,
  artboardOf, documentFontFamilies, probeFonts,
} from '@playground/shared';
import { probeOverflow } from './render.ts';

/**
 * Selector coverage from recent imports, per document. In memory: it describes
 * a parse that already happened, and goes stale as soon as the nodes are edited,
 * so it is not worth a place in the saved document.
 */
const styleReports = new Map<string, StyleRuleStat[]>();

export function recordStyleRules(docId: string, stats: StyleRuleStat[] | undefined): void {
  if (!stats?.length) return;
  // The newest import of a selector replaces the older one.
  const merged = new Map((styleReports.get(docId) ?? []).map((s) => [`${s.root}|${s.selector}`, s]));
  for (const s of stats) merged.set(`${s.root}|${s.selector}`, s);
  styleReports.set(docId, [...merged.values()].slice(-400));
}

export function styleRulesFor(doc: CanvasDocument): StyleRuleStat[] {
  // Drop reports for imports that have since been deleted.
  return (styleReports.get(doc.id) ?? []).filter((s) => !s.root || doc.nodes[s.root]);
}

/** Most frames worth rendering in one check; each one is a headless page load. */
const MAX_OVERFLOW_FRAMES = 24;

export async function gatherHealthFacts(
  doc: CanvasDocument,
  opts: { within?: NodeId; baseUrl?: string; measure?: boolean } = {},
): Promise<HealthFacts & { measuredFrames: number; skippedFrames: number }> {
  const fonts = await probeFonts(documentFontFamilies(doc)).catch(() => []);

  const boards = opts.within
    ? [artboardOf(doc, opts.within)].filter((a): a is NodeId => !!a)
    : doc.pages.flatMap((p) => p.artboards).filter((a) => doc.nodes[a]?.children.length);
  let overflow: OverflowFact[] | undefined;
  let measuredFrames = 0;
  if (opts.measure !== false) {
    overflow = [];
    for (const a of boards.slice(0, MAX_OVERFLOW_FRAMES)) {
      const found = await probeOverflow(doc, a, opts.baseUrl).catch(() => null);
      if (!found) { if (measuredFrames === 0) { overflow = undefined; break; } continue; }
      measuredFrames++;
      overflow.push(...found);
    }
  }

  return {
    fonts,
    overflow,
    styleRules: styleRulesFor(doc),
    measuredFrames,
    skippedFrames: Math.max(0, boards.length - measuredFrames),
  };
}
