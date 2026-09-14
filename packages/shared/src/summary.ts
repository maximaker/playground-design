/**
 * Token-efficient document summaries for agents.
 *
 * PRD requirement R3: an agent must be able to orient in a 2000-node document
 * without ingesting 2000 nodes. These helpers are what `get_tree_summary` and
 * `get_basic_info` return.
 */

import {
  type CanvasDocument, type CanvasNode, type NodeId,
  getArtboardPosition, getArtboardSize,
} from './model.ts';

export interface TreeSummaryOptions {
  depth?: number;
  /** Stop expanding once this many lines have been emitted. */
  maxNodes?: number;
  includeStyles?: boolean;
}

/**
 * A compact indented outline of a subtree. One line per node:
 * `frame#n_abc "Header" [1200x64] (3 children)`
 */
export function treeSummary(
  doc: CanvasDocument,
  rootId: NodeId,
  opts: TreeSummaryOptions = {},
): string {
  const maxDepth = opts.depth ?? 6;
  const maxNodes = opts.maxNodes ?? 400;
  const lines: string[] = [];
  let count = 0;
  let truncated = false;

  const walk = (id: NodeId, depth: number) => {
    const node = doc.nodes[id];
    if (!node) return;
    if (count >= maxNodes) { truncated = true; return; }
    count++;
    lines.push('  '.repeat(depth) + describeNode(node, opts.includeStyles));
    if (depth >= maxDepth) {
      if (node.children.length) lines.push('  '.repeat(depth + 1) + `… ${node.children.length} more, use get_children`);
      return;
    }
    for (const c of node.children) walk(c, depth + 1);
  };

  walk(rootId, 0);
  if (truncated) lines.push(`… truncated at ${maxNodes} nodes; narrow with a node id or lower depth`);
  return lines.join('\n');
}

export function describeNode(node: CanvasNode, includeStyles = false): string {
  const parts = [`${node.type}#${node.id}`, JSON.stringify(node.name)];

  const w = node.styles.width;
  const h = node.styles.height;
  if (w || h) parts.push(`[${w ?? 'auto'}×${h ?? 'auto'}]`);

  if (node.type === 'text' && node.text) {
    parts.push(`text=${JSON.stringify(node.text.length > 60 ? node.text.slice(0, 59) + '…' : node.text)}`);
  }
  if (node.children.length) parts.push(`(${node.children.length} children)`);
  if (!node.visible) parts.push('hidden');
  if (node.locked) parts.push('locked');

  if (includeStyles) {
    const notable = ['display', 'flex-direction', 'gap', 'padding', 'background-color', 'color', 'font-size'];
    const s = notable.filter((k) => node.styles[k]).map((k) => `${k}:${node.styles[k]}`);
    if (s.length) parts.push(`{${s.join('; ')}}`);
  }

  return parts.join(' ');
}

export interface BasicInfo {
  documentId: string;
  documentName: string;
  pages: { id: string; name: string; artboardCount: number }[];
  currentPage: string;
  nodeCount: number;
  artboards: { id: string; name: string; width: number; height: number; x: number; y: number; childCount: number }[];
  themes: string[];
  tokenCount: number;
}

export function basicInfo(doc: CanvasDocument, pageId?: string): BasicInfo {
  const page = doc.pages.find((p) => p.id === pageId) ?? doc.pages[0]!;
  return {
    documentId: doc.id,
    documentName: doc.name,
    pages: doc.pages.map((p) => ({ id: p.id, name: p.name, artboardCount: p.artboards.length })),
    currentPage: page.id,
    nodeCount: Object.keys(doc.nodes).length,
    artboards: page.artboards.flatMap((id) => {
      const n = doc.nodes[id];
      if (!n) return [];
      const { width, height } = getArtboardSize(n);
      const { x, y } = getArtboardPosition(n);
      return [{ id, name: n.name, width, height, x, y, childCount: n.children.length }];
    }),
    themes: doc.themes,
    tokenCount: doc.tokens.length,
  };
}
