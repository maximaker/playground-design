/**
 * The MCP surface: how agents read and write a Canvas document.
 *
 * Most tools run against the server's copy of the document, so they work with
 * no browser tab open (headless agent sessions). Only the tools that need a
 * real layout engine — computed styles, measured geometry, rasterization —
 * reach into a connected tab, and they say so clearly when none is there.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import {
  type CanvasDocument, type CanvasNode, type NodeId, type Op, type OpEnvelope, type StyleMap,
  applyOp, artboardOf, basicInfo, cloneSubtree, descendants, emitHtml, emitJsx, getNode,
  makeNode, newId, parseHtml, treeSummary, describeNode, getArtboardPosition, getArtboardSize,
  batchId, tokenToCssVar, DEFAULT_ARTBOARD_STYLES,
} from '@canvas/shared';
import { applyOps, getDocument, StoreError, createSnapshot } from './store.ts';
import { callTab, notifyTabs, selectionOf, hasLiveTab, NoTabError } from './realtime.ts';
import { renderNode } from './render.ts';
import { storeAsset } from './assets.ts';
import { GUIDES, guideList } from './guides.ts';
import { touchConnection, type Connection } from './connections.ts';

// ---------------------------------------------------------------------------
// Helpers shared by the tool handlers
// ---------------------------------------------------------------------------

function text(s: string) {
  return { content: [{ type: 'text' as const, text: s }] };
}

function json(value: unknown) {
  return text(JSON.stringify(value, null, 2));
}

function fail(s: string) {
  return { content: [{ type: 'text' as const, text: s }], isError: true };
}

/** Turns thrown errors into a tool error the agent can act on. */
async function guard<T>(fn: () => Promise<T> | T): Promise<T | ReturnType<typeof fail>> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof NoTabError) return fail(err.message);
    if (err instanceof StoreError) return fail(`Rejected: ${err.message}`);
    return fail(err instanceof Error ? err.message : String(err));
  }
}

const StyleRecord = z.record(z.string(), z.string());

export interface McpContext {
  connection: Connection;
  baseUrl: string;
}

function requireDoc(ctx: McpContext): CanvasDocument {
  const doc = getDocument(ctx.connection.docId);
  if (!doc) throw new Error(`Document ${ctx.connection.docId} no longer exists.`);
  return doc;
}

function agentOrigin(ctx: McpContext): OpEnvelope['origin'] {
  return { kind: 'agent', id: ctx.connection.code, label: ctx.connection.label ?? 'Agent' };
}

function commit(ctx: McpContext, ops: Op[], batch = batchId()): void {
  const origin = agentOrigin(ctx);
  applyOps(ctx.connection.docId, ops.map((op) => ({ op, origin, batch })));
}

/** Resolves a node id, with a message that tells the agent how to recover. */
function node(doc: CanvasDocument, id: NodeId): CanvasNode {
  const n = getNode(doc, id);
  if (!n) {
    throw new Error(
      `No node with id "${id}". It may have been deleted or the id may be stale — ` +
      `call get_tree_summary on the artboard to get current ids.`,
    );
  }
  return n;
}

// ---------------------------------------------------------------------------
// Server construction
// ---------------------------------------------------------------------------

export function buildMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer(
    { name: 'canvas', version: '0.1.0' },
    {
      instructions:
        `You are connected to a Canvas design document ("${ctx.connection.docName}"). ` +
        `Canvas is a design tool whose documents are real HTML and CSS.\n\n` +
        `Start with get_basic_info, then get_tree_summary on the artboard you care about. ` +
        `Create with write_html. After any visual change, call get_screenshot to check your work — ` +
        `you cannot tell whether a layout is right without looking at it.\n\n` +
        `Call get_guide("layout") before building anything substantial; it describes what makes ` +
        `output a designer will keep rather than discard.`,
    },
  );

  registerReadTools(server, ctx);
  registerWriteTools(server, ctx);
  registerSessionTools(server, ctx);
  return server;
}

// ---------------------------------------------------------------------------
// Read tools
// ---------------------------------------------------------------------------

function registerReadTools(server: McpServer, ctx: McpContext): void {
  server.registerTool('get_basic_info', {
    title: 'Get document info',
    description:
      'File name, pages, node count, and the artboards on the current page with their sizes and canvas positions. Call this first.',
    inputSchema: { pageId: z.string().optional().describe('Page to describe. Defaults to the first page.') },
    annotations: { readOnlyHint: true },
  }, async ({ pageId }) => guard(() => {
    const doc = requireDoc(ctx);
    return json({ ...basicInfo(doc, pageId), liveTabConnected: hasLiveTab(doc.id), rev: doc.rev });
  }));

  server.registerTool('get_selection', {
    title: 'Get current selection',
    description:
      "The nodes the human currently has selected in their browser. Empty if nobody has the document open, which is normal for headless sessions.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => guard(() => {
    const doc = requireDoc(ctx);
    const ids = selectionOf(doc.id);
    return json({
      liveTabConnected: hasLiveTab(doc.id),
      selection: ids.flatMap((id) => {
        const n = getNode(doc, id);
        if (!n) return [];
        return [{
          id, name: n.name, type: n.type, tag: n.tag,
          width: n.styles.width ?? null, height: n.styles.height ?? null,
          artboard: artboardOf(doc, id), parent: n.parent, childCount: n.children.length,
        }];
      }),
    });
  }));

  server.registerTool('get_node_info', {
    title: 'Get node details',
    description: 'Full details for one node: type, tag, styles, variants, attributes, text, parent and children.',
    inputSchema: {
      id: z.string().describe('Node id.'),
      includeStyles: z.boolean().optional().default(true),
    },
    annotations: { readOnlyHint: true },
  }, async ({ id, includeStyles }) => guard(() => {
    const doc = requireDoc(ctx);
    const n = node(doc, id);
    return json({
      id: n.id, type: n.type, tag: n.tag, name: n.name,
      text: n.text ?? null, visible: n.visible, locked: n.locked,
      parent: n.parent, artboard: artboardOf(doc, id),
      children: n.children.map((c) => {
        const cn = getNode(doc, c)!;
        return { id: c, name: cn.name, type: cn.type, tag: cn.tag };
      }),
      attrs: n.attrs,
      styles: includeStyles ? n.styles : undefined,
      variants: includeStyles ? n.variants : undefined,
      ...(n.type === 'artboard'
        ? { canvasPosition: getArtboardPosition(n), size: getArtboardSize(n) }
        : {}),
    });
  }));

  server.registerTool('get_children', {
    title: 'Get direct children',
    description: 'Direct children of a node — ids, names, types and child counts. Cheaper than get_tree_summary for drilling down one level.',
    inputSchema: { id: z.string() },
    annotations: { readOnlyHint: true },
  }, async ({ id }) => guard(() => {
    const doc = requireDoc(ctx);
    const n = node(doc, id);
    return json(n.children.map((c) => {
      const cn = getNode(doc, c)!;
      return { id: c, name: cn.name, type: cn.type, tag: cn.tag, childCount: cn.children.length };
    }));
  }));

  server.registerTool('get_tree_summary', {
    title: 'Summarize a subtree',
    description:
      'Compact indented outline of a subtree, one line per node. This is the cheap way to understand a design — prefer it over walking get_children repeatedly.',
    inputSchema: {
      id: z.string().optional().describe('Root node. Defaults to every artboard on the page.'),
      depth: z.number().int().min(1).max(20).optional().default(6),
      includeStyles: z.boolean().optional().default(false).describe('Append notable style declarations to each line.'),
    },
    annotations: { readOnlyHint: true },
  }, async ({ id, depth, includeStyles }) => guard(() => {
    const doc = requireDoc(ctx);
    if (id) {
      node(doc, id);
      return text(treeSummary(doc, id, { depth, includeStyles }));
    }
    const page = doc.pages[0]!;
    if (page.artboards.length === 0) return text('(document has no artboards yet — create one with create_artboard)');
    return text(page.artboards.map((a) => treeSummary(doc, a, { depth, includeStyles })).join('\n\n'));
  }));

  server.registerTool('find_nodes', {
    title: 'Find nodes',
    description:
      'Search the document by layer name, text content, tag or type. Use this instead of dumping the whole tree when you know what you are looking for.',
    inputSchema: {
      query: z.string().optional().describe('Case-insensitive substring matched against layer name and text content.'),
      type: z.string().optional().describe('Node type: frame, text, image, vector, shape, artboard, embed.'),
      tag: z.string().optional().describe('HTML tag, e.g. "h1".'),
      within: z.string().optional().describe('Restrict to the subtree of this node id.'),
      limit: z.number().int().min(1).max(200).optional().default(50),
    },
    annotations: { readOnlyHint: true },
  }, async ({ query, type, tag, within, limit }) => guard(() => {
    const doc = requireDoc(ctx);
    const scope = within ? [within, ...descendants(doc, within)] : Object.keys(doc.nodes);
    const q = query?.toLowerCase();
    const hits = scope.flatMap((id) => {
      const n = doc.nodes[id];
      if (!n) return [];
      if (type && n.type !== type) return [];
      if (tag && n.tag.toLowerCase() !== tag.toLowerCase()) return [];
      if (q && !n.name.toLowerCase().includes(q) && !(n.text ?? '').toLowerCase().includes(q)) return [];
      return [describeNode(n)];
    });
    if (!hits.length) return text('No matching nodes.');
    return text(hits.slice(0, limit).join('\n') + (hits.length > limit ? `\n… ${hits.length - limit} more` : ''));
  }));

  server.registerTool('get_html', {
    title: 'Get HTML',
    description: 'HTML + CSS for a node and its descendants. Use get_jsx if you want React.',
    inputSchema: {
      id: z.string(),
      mode: z.enum(['inline', 'stylesheet']).optional().default('inline'),
    },
    annotations: { readOnlyHint: true },
  }, async ({ id, mode }) => guard(() => {
    const doc = requireDoc(ctx);
    node(doc, id);
    const { html, css } = emitHtml(doc, id, { mode, includeTokens: false });
    return text(css ? `${html}\n\n<style>\n${css}\n</style>` : html);
  }));

  server.registerTool('get_jsx', {
    title: 'Get JSX',
    description:
      'JSX for a node and its descendants. "tailwind" emits utility classes (with arbitrary values where no utility exists); "inline" emits explicit style objects. Neither drops a declaration.',
    inputSchema: {
      id: z.string(),
      format: z.enum(['tailwind', 'inline']).optional().default('tailwind'),
      componentName: z.string().optional().describe('Wrap the output in an exported component with this name.'),
    },
    annotations: { readOnlyHint: true },
  }, async ({ id, format, componentName }) => guard(() => {
    const doc = requireDoc(ctx);
    node(doc, id);
    return text(emitJsx(doc, id, { format, componentName }));
  }));

  server.registerTool('get_computed_styles', {
    title: 'Get computed styles',
    description:
      'Authored styles for one or more nodes. If a browser tab is connected, also returns the browser-computed values and measured box, which is the only way to see what the layout engine actually resolved.',
    inputSchema: {
      ids: z.array(z.string()).min(1).max(50),
      properties: z.array(z.string()).optional().describe('Restrict to these CSS properties.'),
    },
    annotations: { readOnlyHint: true },
  }, async ({ ids, properties }) => guard(async () => {
    const doc = requireDoc(ctx);
    const authored = ids.map((id) => {
      const n = node(doc, id);
      const styles: StyleMap = properties
        ? Object.fromEntries(properties.flatMap((p) => (n.styles[p] ? [[p, n.styles[p]!]] : [])))
        : n.styles;
      return { id, authored: styles, variants: n.variants };
    });

    if (!hasLiveTab(doc.id)) {
      return json({ note: 'No browser tab connected; returning authored styles only.', nodes: authored });
    }
    try {
      const measured = await callTab<Record<string, unknown>>(doc.id, 'computedStyles', { ids, properties });
      return json({ nodes: authored.map((a) => ({ ...a, computed: measured[a.id] ?? null })) });
    } catch (err) {
      return json({
        note: `Browser measurement failed (${err instanceof Error ? err.message : err}); returning authored styles.`,
        nodes: authored,
      });
    }
  }));

  server.registerTool('get_screenshot', {
    title: 'Screenshot a node',
    description:
      'Renders a node to a PNG so you can see it. Call this after every visual change — it is the only way to verify layout, spacing and overflow.',
    inputSchema: {
      id: z.string(),
      scale: z.number().min(1).max(3).optional().default(1),
    },
    annotations: { readOnlyHint: true },
  }, async ({ id, scale }) => guard(async () => {
    const doc = requireDoc(ctx);
    node(doc, id);
    const { data, mime } = await renderNode(doc, id, { format: 'png', scale, baseUrl: ctx.baseUrl });
    return {
      content: [
        { type: 'image' as const, data: data.toString('base64'), mimeType: mime },
      ],
    };
  }));

  server.registerTool('get_fill_image', {
    title: 'Get an image node’s source',
    description: 'The image data behind an image node or a background-image fill, as base64.',
    inputSchema: { id: z.string() },
    annotations: { readOnlyHint: true },
  }, async ({ id }) => guard(async () => {
    const doc = requireDoc(ctx);
    const n = node(doc, id);
    const src = n.attrs.src ?? extractUrl(n.styles['background-image'] ?? '');
    if (!src) return fail(`Node ${id} has no image source (no src attribute and no background-image).`);

    const url = src.startsWith('http') ? src : new URL(src, ctx.baseUrl).toString();
    const res = await fetch(url);
    if (!res.ok) return fail(`Could not fetch ${url}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      content: [{
        type: 'image' as const,
        data: buf.toString('base64'),
        mimeType: res.headers.get('content-type') ?? 'image/jpeg',
      }],
    };
  }));

  server.registerTool('get_font_family_info', {
    title: 'Check a font family',
    description:
      'Whether a font family is available and which weights and styles it has. Check before setting font-family — an unavailable family silently renders in a fallback.',
    inputSchema: { family: z.string() },
    annotations: { readOnlyHint: true },
  }, async ({ family }) => guard(async () => {
    const doc = requireDoc(ctx);
    const local = LOCAL_FONTS[family.toLowerCase()];
    if (local) return json({ family, available: true, source: 'system', ...local });

    const google = await lookupGoogleFont(family);
    if (google) return json({ available: true, source: 'google-fonts', ...google });

    return json({
      family, available: false,
      note: `"${family}" is not a system font and was not found in Google Fonts. Text will fall back. Suggested alternatives: ${Object.keys(LOCAL_FONTS).slice(0, 5).join(', ')}.`,
    });
  }));

  server.registerTool('get_tokens', {
    title: 'Get design tokens',
    description:
      'The document’s design tokens and themes. Use var(--token-name) in styles rather than hardcoding values that already exist as tokens.',
    inputSchema: { theme: z.string().optional() },
    annotations: { readOnlyHint: true },
  }, async ({ theme }) => guard(() => {
    const doc = requireDoc(ctx);
    return json({
      themes: doc.themes,
      tokens: doc.tokens.map((t) => ({
        name: t.name, group: t.group, cssVar: tokenToCssVar(t.name),
        usage: `var(${tokenToCssVar(t.name)})`,
        value: theme ? (t.values[theme] ?? t.values.default) : undefined,
        values: theme ? undefined : t.values,
      })),
    });
  }));

  server.registerTool('get_guide', {
    title: 'Get a workflow guide',
    description: `Guidance for a topic. Available: ${guideList()}. Read "layout" before building anything substantial.`,
    inputSchema: { topic: z.string().describe(`One of: ${guideList()}`) },
    annotations: { readOnlyHint: true },
  }, async ({ topic }) => guard(() => {
    const g = GUIDES[topic.toLowerCase().trim()];
    if (!g) return fail(`No guide "${topic}". Available: ${guideList()}`);
    return text(g);
  }));
}

function extractUrl(bg: string): string | null {
  const m = /url\(\s*['"]?([^'")]+)['"]?\s*\)/.exec(bg);
  return m ? m[1]! : null;
}

const LOCAL_FONTS: Record<string, { weights: string[]; styles: string[] }> = {
  inter: { weights: ['100', '200', '300', '400', '500', '600', '700', '800', '900'], styles: ['normal', 'italic'] },
  'system-ui': { weights: ['400', '500', '600', '700'], styles: ['normal', 'italic'] },
  georgia: { weights: ['400', '700'], styles: ['normal', 'italic'] },
  'times new roman': { weights: ['400', '700'], styles: ['normal', 'italic'] },
  arial: { weights: ['400', '700'], styles: ['normal', 'italic'] },
  helvetica: { weights: ['400', '700'], styles: ['normal', 'italic'] },
  'courier new': { weights: ['400', '700'], styles: ['normal', 'italic'] },
  monospace: { weights: ['400', '700'], styles: ['normal'] },
};

interface GoogleFontInfo { family: string; weights: string[]; styles: string[]; category?: string }
const googleFontCache = new Map<string, GoogleFontInfo | null>();

async function lookupGoogleFont(family: string): Promise<GoogleFontInfo | null> {
  const key = family.toLowerCase();
  if (googleFontCache.has(key)) return googleFontCache.get(key)!;
  try {
    // The CSS2 endpoint 400s for unknown families, which is all we need to know.
    const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:ital,wght@0,100..900;1,100..900&display=swap`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) { googleFontCache.set(key, null); return null; }
    const css = await res.text();
    const weights = [...new Set([...css.matchAll(/font-weight:\s*([\d\s]+);/g)].flatMap((m) => m[1]!.trim().split(/\s+/)))];
    const styles = [...new Set([...css.matchAll(/font-style:\s*(\w+);/g)].map((m) => m[1]!))];
    const info: GoogleFontInfo = {
      family,
      weights: weights.length ? weights : ['400'],
      styles: styles.length ? styles : ['normal'],
    };
    googleFontCache.set(key, info);
    return info;
  } catch {
    googleFontCache.set(key, null);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Write tools
// ---------------------------------------------------------------------------

function registerWriteTools(server: McpServer, ctx: McpContext): void {
  server.registerTool('create_artboard', {
    title: 'Create an artboard',
    description:
      'Creates a new artboard (a screen). Artboards are viewports: media queries inside one resolve against its own width, so use a real device width.',
    inputSchema: {
      name: z.string().optional(),
      width: z.number().min(16).max(10000).optional().default(1440),
      height: z.number().min(16).max(20000).optional().default(900),
      x: z.number().optional().describe('Canvas position. Defaults to the right of the last artboard.'),
      y: z.number().optional(),
      styles: StyleRecord.optional().describe('CSS for the artboard itself, e.g. background-color.'),
      pageId: z.string().optional(),
    },
    annotations: { destructiveHint: false },
  }, async ({ name, width, height, x, y, styles, pageId }) => guard(() => {
    const doc = requireDoc(ctx);
    const page = doc.pages.find((p) => p.id === pageId) ?? doc.pages[0]!;

    // Place to the right of the rightmost artboard so new work never lands on
    // top of existing work.
    let px = x, py = y;
    if (px === undefined || py === undefined) {
      let maxRight = 0, topY = 0;
      for (const id of page.artboards) {
        const n = doc.nodes[id];
        if (!n) continue;
        const pos = getArtboardPosition(n);
        const size = getArtboardSize(n);
        if (pos.x + size.width > maxRight) maxRight = pos.x + size.width;
        topY = Math.min(topY, pos.y);
      }
      px = px ?? (page.artboards.length ? maxRight + 120 : 0);
      py = py ?? topY;
    }

    const artboard = makeNode({
      type: 'artboard',
      name: name ?? `Artboard ${page.artboards.length + 1}`,
      styles: { ...DEFAULT_ARTBOARD_STYLES, ...styles, width: `${width}px`, height: `${height}px` },
      attrs: { 'data-x': String(px), 'data-y': String(py) },
    });

    commit(ctx, [{ t: 'insert', nodes: [artboard], parent: null, index: page.artboards.length, page: page.id }]);
    return json({ id: artboard.id, name: artboard.name, width, height, x: px, y: py });
  }));

  server.registerTool('write_html', {
    title: 'Write HTML into the document',
    description:
      'The main creation tool. Parses an HTML fragment into editable layers: elements become nodes, inline styles and <style> rules become node styles, :hover and @media rules become variants. Write ordinary, well-structured HTML with flexbox — read get_guide("layout") first.',
    inputSchema: {
      html: z.string().describe('HTML fragment. May include a <style> block. <script> is stripped.'),
      targetId: z.string().describe('Node to write into or replace.'),
      mode: z.enum(['insert-children', 'replace', 'insert-before', 'insert-after', 'replace-children'])
        .optional().default('insert-children')
        .describe('insert-children appends inside target; replace-children clears it first; replace swaps the target itself.'),
      index: z.number().int().optional().describe('Insert position among siblings/children. Defaults to the end.'),
    },
  }, async ({ html, targetId, mode, index }) => guard(() => {
    const doc = requireDoc(ctx);
    const target = node(doc, targetId);

    const parsed = parseHtml(html);
    if (parsed.nodes.length === 0) return fail('The HTML produced no nodes. Check that it contains elements.');

    const ops: Op[] = [];
    let parent: NodeId | null;
    let at: number;

    if (mode === 'replace') {
      if (target.type === 'artboard') {
        return fail('Cannot replace an artboard with write_html. Use mode "replace-children", or delete_nodes then create_artboard.');
      }
      parent = target.parent;
      const siblings = parent ? doc.nodes[parent]!.children : doc.pages.find((p) => p.artboards.includes(targetId))!.artboards;
      at = siblings.indexOf(targetId);
      ops.push({ t: 'remove', ids: [targetId] });
    } else if (mode === 'replace-children') {
      parent = targetId;
      at = 0;
      if (target.children.length) ops.push({ t: 'remove', ids: [...target.children] });
    } else if (mode === 'insert-before' || mode === 'insert-after') {
      parent = target.parent;
      const siblings = parent ? doc.nodes[parent]!.children : doc.pages.find((p) => p.artboards.includes(targetId))!.artboards;
      at = siblings.indexOf(targetId) + (mode === 'insert-after' ? 1 : 0);
    } else {
      parent = targetId;
      at = index ?? target.children.length;
    }

    ops.push({ t: 'insert', nodes: parsed.nodes, parent, index: index ?? at });
    commit(ctx, ops);

    return json({
      created: parsed.roots.length,
      totalNodes: parsed.nodes.length,
      roots: parsed.roots.map((id) => {
        const n = parsed.nodes.find((x) => x.id === id)!;
        return { id, name: n.name, type: n.type, tag: n.tag };
      }),
      warnings: parsed.warnings,
      next: 'Call get_screenshot on the artboard to check the result.',
    });
  }));

  server.registerTool('update_styles', {
    title: 'Update styles',
    description:
      'Sets CSS on one or more nodes. Batch every change in a single call. An empty string removes a declaration. Use `selector` to target a state or breakpoint instead of the base styles.',
    inputSchema: {
      updates: z.array(z.object({
        id: z.string(),
        styles: StyleRecord.describe('Kebab-case CSS properties, e.g. {"background-color": "var(--color-brand)"}.'),
        selector: z.string().optional().describe('":hover", ":focus", or "@media (max-width: 768px)". Omit for base styles.'),
      })).min(1).max(200),
    },
  }, async ({ updates }) => guard(() => {
    const doc = requireDoc(ctx);
    for (const u of updates) node(doc, u.id);
    commit(ctx, [{ t: 'styles', updates }]);
    return json({ updated: updates.length });
  }));

  server.registerTool('set_text_content', {
    title: 'Set text',
    description: 'Sets the text of one or more text nodes. Batch every change in a single call.',
    inputSchema: {
      updates: z.array(z.object({ id: z.string(), text: z.string() })).min(1).max(500),
    },
  }, async ({ updates }) => guard(() => {
    const doc = requireDoc(ctx);
    const wrong = updates.filter((u) => node(doc, u.id).type !== 'text');
    if (wrong.length) {
      return fail(
        `These are not text nodes: ${wrong.map((w) => w.id).join(', ')}. ` +
        `Text lives in child text nodes — call get_children to find them.`,
      );
    }
    commit(ctx, [{ t: 'text', updates }]);
    return json({ updated: updates.length });
  }));

  server.registerTool('rename_nodes', {
    title: 'Rename layers',
    description: 'Renames layers. Good names are what make a design readable later — do this for anything you create.',
    inputSchema: {
      updates: z.array(z.object({ id: z.string(), name: z.string().min(1).max(120) })).min(1).max(200),
    },
  }, async ({ updates }) => guard(() => {
    const doc = requireDoc(ctx);
    for (const u of updates) node(doc, u.id);
    commit(ctx, [{ t: 'rename', updates }]);
    return json({ renamed: updates.length });
  }));

  server.registerTool('set_attributes', {
    title: 'Set element attributes',
    description: 'Sets HTML attributes (src, href, alt, id, aria-*). Pass null to remove one.',
    inputSchema: {
      updates: z.array(z.object({
        id: z.string(),
        attrs: z.record(z.string(), z.string().nullable()),
      })).min(1).max(200),
    },
  }, async ({ updates }) => guard(() => {
    const doc = requireDoc(ctx);
    for (const u of updates) node(doc, u.id);
    commit(ctx, [{ t: 'attrs', updates }]);
    return json({ updated: updates.length });
  }));

  server.registerTool('move_nodes', {
    title: 'Move or reparent nodes',
    description:
      'Repositions nodes in the tree, preserving their ids so your existing references stay valid. For artboards, pass x/y to move them on the canvas instead.',
    inputSchema: {
      moves: z.array(z.object({
        id: z.string(),
        parentId: z.string().nullable().optional().describe('New parent. null moves an artboard to page root.'),
        index: z.number().int().optional().describe('Position among siblings. Defaults to the end.'),
        x: z.number().optional().describe('Artboards only: canvas x.'),
        y: z.number().optional().describe('Artboards only: canvas y.'),
      })).min(1).max(100),
    },
  }, async ({ moves }) => guard(() => {
    const doc = requireDoc(ctx);
    const ops: Op[] = [];
    const attrUpdates: { id: NodeId; attrs: Record<string, string | null> }[] = [];
    const treeMoves: { id: NodeId; parent: NodeId | null; index: number }[] = [];

    for (const m of moves) {
      const n = node(doc, m.id);
      if (m.x !== undefined || m.y !== undefined) {
        if (n.type !== 'artboard') {
          return fail(`x/y only apply to artboards; ${m.id} is a ${n.type}. Position it with CSS via update_styles.`);
        }
        const attrs: Record<string, string | null> = {};
        if (m.x !== undefined) attrs['data-x'] = String(m.x);
        if (m.y !== undefined) attrs['data-y'] = String(m.y);
        attrUpdates.push({ id: m.id, attrs });
      }
      if (m.parentId !== undefined) {
        const parent = m.parentId;
        if (parent) {
          const p = node(doc, parent);
          if (p.type === 'text') return fail(`Cannot move into text node ${parent}; text nodes have no children.`);
        }
        const siblings = parent ? doc.nodes[parent]!.children : doc.pages[0]!.artboards;
        treeMoves.push({ id: m.id, parent: parent ?? null, index: m.index ?? siblings.length });
      } else if (m.index !== undefined) {
        treeMoves.push({ id: m.id, parent: n.parent, index: m.index });
      }
    }

    if (treeMoves.length) ops.push({ t: 'move', moves: treeMoves });
    if (attrUpdates.length) ops.push({ t: 'attrs', updates: attrUpdates });
    if (!ops.length) return fail('Nothing to do: each move needs parentId, index, or x/y.');
    commit(ctx, ops);
    return json({ moved: moves.length });
  }));

  server.registerTool('duplicate_nodes', {
    title: 'Duplicate nodes',
    description:
      'Deep-clones nodes. Returns the new root ids and a full old→new id map for every descendant, so you can restyle the copy precisely without re-reading the tree.',
    inputSchema: {
      ids: z.array(z.string()).min(1).max(50),
      parentId: z.string().optional().describe('Where to put the copies. Defaults to the original’s parent.'),
      offset: z.object({ x: z.number(), y: z.number() }).optional().describe('Artboards only: canvas offset for the copy.'),
    },
  }, async ({ ids, parentId, offset }) => guard(() => {
    const doc = requireDoc(ctx);
    const ops: Op[] = [];
    const results: { source: string; newId: string; idMap: Record<string, string> }[] = [];

    for (const id of ids) {
      const src = node(doc, id);
      const { nodes, idMap } = cloneSubtree(doc, id);
      const root = nodes[0]!;

      if (src.type === 'artboard' && !parentId) {
        const pos = getArtboardPosition(src);
        const size = getArtboardSize(src);
        root.attrs = {
          ...root.attrs,
          'data-x': String(pos.x + (offset?.x ?? size.width + 120)),
          'data-y': String(pos.y + (offset?.y ?? 0)),
        };
        root.name = `${src.name} copy`;
        const page = doc.pages.find((p) => p.artboards.includes(id)) ?? doc.pages[0]!;
        ops.push({ t: 'insert', nodes, parent: null, index: page.artboards.length, page: page.id });
      } else {
        const target = parentId ?? src.parent;
        if (!target) return fail(`Node ${id} has no parent; pass parentId to say where the copy should go.`);
        node(doc, target);
        ops.push({ t: 'insert', nodes, parent: target, index: doc.nodes[target]!.children.length });
      }
      results.push({ source: id, newId: root.id, idMap });
    }

    commit(ctx, ops);
    return json({ duplicated: results });
  }));

  server.registerTool('delete_nodes', {
    title: 'Delete nodes',
    description: 'Deletes nodes and everything inside them. This is undoable by the human, but check get_tree_summary first.',
    inputSchema: { ids: z.array(z.string()).min(1).max(200) },
    annotations: { destructiveHint: true },
  }, async ({ ids }) => guard(() => {
    const doc = requireDoc(ctx);
    let total = 0;
    for (const id of ids) { node(doc, id); total += 1 + descendants(doc, id).length; }
    commit(ctx, [{ t: 'remove', ids }]);
    return json({ deleted: ids.length, totalNodesRemoved: total });
  }));

  server.registerTool('set_tokens', {
    title: 'Set design tokens',
    description:
      'Adds or updates design tokens. Existing tokens with the same name are replaced; others are left alone. Changing a token restyles everything referencing it.',
    inputSchema: {
      tokens: z.array(z.object({
        name: z.string().describe('Dot path, e.g. "color.brand.500".'),
        group: z.enum(['color', 'space', 'radius', 'font', 'shadow', 'duration']),
        values: z.record(z.string(), z.string()).describe('Value per theme. Must include "default".'),
      })).min(1).max(200),
    },
  }, async ({ tokens }) => guard(() => {
    const doc = requireDoc(ctx);
    const missing = tokens.filter((t) => !t.values.default);
    if (missing.length) return fail(`These tokens have no "default" value: ${missing.map((t) => t.name).join(', ')}`);

    const merged = [...doc.tokens];
    for (const t of tokens) {
      const i = merged.findIndex((x) => x.name === t.name);
      if (i >= 0) merged[i] = t;
      else merged.push(t);
    }
    commit(ctx, [{ t: 'tokens', tokens: merged }]);
    return json({ tokenCount: merged.length, updated: tokens.map((t) => `var(${tokenToCssVar(t.name)})`) });
  }));

  server.registerTool('set_selection', {
    title: 'Set the human’s selection',
    description:
      'Selects nodes in the human’s browser and scrolls them into view. Use it to show someone what you just built or what you are asking about.',
    inputSchema: { ids: z.array(z.string()).max(100) },
  }, async ({ ids }) => guard(async () => {
    const doc = requireDoc(ctx);
    for (const id of ids) node(doc, id);
    if (!hasLiveTab(doc.id)) return text('No browser tab is connected, so there is no selection to set.');
    await callTab(doc.id, 'setSelection', { ids });
    return json({ selected: ids.length });
  }));

  server.registerTool('export', {
    title: 'Export nodes to files',
    description:
      'Renders nodes to PNG, JPG, SVG or standalone HTML and returns download URLs (plus base64 for images). SVG requires a vector node.',
    inputSchema: {
      ids: z.array(z.string()).min(1).max(20),
      format: z.enum(['png', 'jpg', 'webp', 'svg', 'html']).optional().default('png'),
      scale: z.number().min(1).max(3).optional().default(2),
      includeBase64: z.boolean().optional().default(false).describe('Also inline the bytes in the response. Off by default because it is large.'),
    },
  }, async ({ ids, format, scale, includeBase64 }) => guard(async () => {
    const doc = requireDoc(ctx);
    const out: unknown[] = [];
    for (const id of ids) {
      const n = node(doc, id);
      const { data, mime } = await renderNode(doc, id, { format, scale, baseUrl: ctx.baseUrl });
      const assetId = storeAsset(doc.id, mime, `${slug(n.name)}.${format}`, data);
      out.push({
        id, name: n.name, format, bytes: data.length,
        url: `${ctx.baseUrl}/assets/${assetId}`,
        ...(includeBase64 ? { base64: data.toString('base64') } : {}),
      });
    }
    return json({ exported: out });
  }));
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'export';
}

// ---------------------------------------------------------------------------
// Session tools
// ---------------------------------------------------------------------------

function registerSessionTools(server: McpServer, ctx: McpContext): void {
  server.registerTool('start_working_on_nodes', {
    title: 'Mark artboards as being worked on',
    description:
      'Shows the human a live indicator on the artboards you are about to change, and a note saying what you are doing. Call this before multi-step work.',
    inputSchema: {
      ids: z.array(z.string()).min(1).max(20).describe('Nodes you are about to change; their artboards get the indicator.'),
      summary: z.string().optional().describe('One line describing what you are doing, shown to the human.'),
    },
  }, async ({ ids, summary }) => guard(() => {
    const doc = requireDoc(ctx);
    const artboards = [...new Set(ids.map((id) => { node(doc, id); return artboardOf(doc, id); }).filter(Boolean))];
    notifyTabs(doc.id, {
      kind: 'agent-working', active: true, artboards,
      agent: ctx.connection.label ?? 'Agent', summary: summary ?? null,
    });
    createSnapshot(doc.id, `Before: ${summary ?? ctx.connection.label ?? 'agent edit'}`);
    return json({ marked: artboards, note: 'A restore point was saved before this work.' });
  }));

  server.registerTool('finish_working_on_nodes', {
    title: 'Clear the working indicator',
    description: 'Clears the indicator set by start_working_on_nodes. Call this when you are done.',
    inputSchema: { summary: z.string().optional().describe('One line describing what you changed.') },
  }, async ({ summary }) => guard(() => {
    const doc = requireDoc(ctx);
    notifyTabs(doc.id, {
      kind: 'agent-working', active: false,
      agent: ctx.connection.label ?? 'Agent', summary: summary ?? null,
    });
    return text('Cleared.');
  }));
}

// ---------------------------------------------------------------------------
// HTTP entry point
// ---------------------------------------------------------------------------

/**
 * Handles one MCP request. Stateless: a fresh server and transport per request,
 * bound to the document the connection code resolves to. Stateless mode means
 * an agent can reconnect freely and the server can restart without breaking it.
 */
export async function handleMcpRequest(req: Request, connection: Connection, baseUrl: string): Promise<Response> {
  touchConnection(connection.code);

  const server = buildMcpServer({ connection, baseUrl });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    // Close on the next tick so the response stream finishes flushing first.
    setTimeout(() => { void server.close().catch(() => {}); }, 0);
  }
}
