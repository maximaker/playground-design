/**
 * The MCP surface: how agents read and write a Playground document.
 *
 * Most tools run against the server's copy of the document, so they work with
 * no browser tab open (headless agent sessions). Only the tools that need a
 * real layout engine — computed styles, measured geometry, rasterization —
 * reach into a connected tab, and they say so clearly when none is there.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import {
  type CanvasDocument, type CanvasNode, type NodeId, type Op, type OpEnvelope, type Page, type StyleMap,
  applyOp, artboardOf, basicInfo, cloneSubtree, descendants, emitHtml, emitJsx, getNode,
  makeComment, makeNode, makeNote, newId, parseHtml, treeSummary, describeNode, getArtboardPosition, getArtboardSize,
  batchId, tokenToCssVar, DEFAULT_ARTBOARD_STYLES, DEFINITIONS_PAGE,
  componentsOf, collectSlots, detachedNodes, expandInstance, instancesOf,
  resolvedProps, variantMatrix, lintDocument, summarise, RULES,
  breakpointsOf, breakpointSelector,
  parseTokensFromCss, parseTokensFromTailwind, serializeTokens, diffTokens, mergeTokens,
  type CodeComponent, type CodeProp, codeComponentsOf, codeComponentOf, resolvedCodeProps,
  codeElementJsx, explicitCodeProps, MOUNT_CONTRACT,
  type Comment, commentsOf, newId as newIdOf,
  NOTE_KINDS, NOTE_KIND_HINTS, specFor, changesWithin, diffDocuments,
} from '@playground/shared';
import { applyOps, getDocument, getSnapshot, listSnapshots, StoreError, createSnapshot } from './store.ts';
import { persistence } from './persistence.ts';
import { pageArtboard, slugify } from './publish.ts';
import { callTab, notifyTabs, selectionOf, hasLiveTab, NoTabError } from './realtime.ts';
import { renderNode, measureSubtree } from './render.ts';
import { storeAsset } from './assets.ts';
import { GUIDES, guideList } from './guides.ts';
import { importUrl, ImportError } from './import.ts';
import { importUrlLive, tokenise, tokensFromVars } from './import-live.ts';
import { getTemplate, templateSummaries } from './templates.ts';
import { touchConnection, type Connection } from './connections.ts';

// ---------------------------------------------------------------------------
// Helpers shared by the tool handlers
// ---------------------------------------------------------------------------

function text(s: string) {
  return { content: [{ type: 'text' as const, text: s }] };
}

/**
 * The tools, in groups.
 *
 * Seventy-seven of them is a lot of context to spend on every session, and a
 * long list of near-neighbours is also how a model ends up calling get_html
 * when it wanted get_tree_summary. A client can ask for a smaller surface with
 * `?tools=core,components` on the connection URL, and any agent can widen it
 * mid-session with use_toolset — the tools are all registered either way, so
 * this costs a disabled flag rather than a second code path.
 *
 * Everything not named here is in core, deliberately: a new tool that nobody
 * remembered to file should be visible and slightly untidy rather than
 * invisible and impossible to find.
 */
const TOOLSETS: Record<string, readonly string[]> = {
  pages: ['list_pages', 'create_page', 'set_current_page', 'rename_page', 'delete_page',
    'list_templates', 'apply_template', 'import_url', 'preview_at_width',
    'get_breakpoints', 'set_breakpoints'],
  components: ['list_components', 'create_component', 'find_repeated_shapes', 'auto_componentise',
    'name_layers', 'componentise', 'insert_instance', 'set_override', 'get_instance',
    'set_component_props', 'set_variant', 'set_instance_props', 'detach_instance'],
  code: ['get_jsx', 'sync_tokens_from_code', 'export_tokens', 'check_token_drift',
    'get_code_component_guide', 'register_code_component', 'list_code_components',
    'add_code_instance', 'set_code_props', 'remove_code_component', 'get_code_usage'],
  handover: ['export', 'get_spec', 'mark_checkpoint', 'changes_since', 'annotate',
    'publish_page', 'unpublish_page', 'get_publication'],
  collab: ['list_notes', 'claim_note', 'respond_to_note', 'create_note', 'list_comments',
    'reply_to_comment', 'resolve_comment', 'start_working_on_nodes', 'finish_working_on_nodes'],
};

const setOf = (tool: string): string =>
  Object.entries(TOOLSETS).find(([, names]) => names.includes(tool))?.[0] ?? 'core';

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

// ---------------------------------------------------------------------------
// Repeated shapes
// ---------------------------------------------------------------------------

/**
 * What makes two subtrees "the same thing": tag, styles, variants, attributes
 * and child shape. Never text — two buttons reading "Save" and "Cancel" are the
 * same button — and never ids or layer names, which come from whatever wrote
 * the HTML.
 *
 * `href` is excluded for the same reason as text: a link that goes somewhere
 * else is still the same component, and the destination travels as an override.
 */
function shapeSignature(doc: CanvasDocument, id: NodeId): string {
  const n = doc.nodes[id];
  if (!n) return '';
  const styles = Object.entries(n.styles).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${v}`).join(';');
  const variants = (n.variants ?? []).map((v) =>
    `${v.selector}{${Object.entries(v.styles).sort(([a], [b]) => a.localeCompare(b))
      .map(([k, x]) => `${k}:${x}`).join(';')}}`).join('');
  const attrs = Object.entries(n.attrs ?? {})
    .filter(([k]) => k !== 'href' && k !== 'id' && !k.startsWith('data-x') && !k.startsWith('data-y'))
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join(',');
  return `${n.type}/${n.tag ?? ''}[${styles}][${variants}][${attrs}](${
    n.children.map((c) => shapeSignature(doc, c)).join('|')})`;
}

function subtreeIdsOf(doc: CanvasDocument, id: NodeId, out: NodeId[] = []): NodeId[] {
  out.push(id);
  for (const c of doc.nodes[id]?.children ?? []) subtreeIdsOf(doc, c, out);
  return out;
}

function depthOf(doc: CanvasDocument, id: NodeId): number {
  const kids = doc.nodes[id]?.children ?? [];
  return kids.length ? 1 + Math.max(...kids.map((c) => depthOf(doc, c))) : 1;
}

/** Every node inside an artboard — component definitions live elsewhere. */
function artboardNodes(doc: CanvasDocument): NodeId[] {
  const out: NodeId[] = [];
  for (const page of doc.pages) {
    for (const artboard of page.artboards) {
      for (const id of subtreeIdsOf(doc, artboard)) if (id !== artboard) out.push(id);
    }
  }
  return out;
}

interface ShapeGroup { sig: string; ids: NodeId[]; sample: NodeId; inComponent: boolean }

function repeatedShapes(
  doc: CanvasDocument, opts: { minCopies: number; minDepth: number },
): ShapeGroup[] {
  const inComponent = new Set(
    Object.values(doc.components ?? {}).flatMap((c) => subtreeIdsOf(doc, c.root)));
  const groups = new Map<string, ShapeGroup>();
  for (const id of artboardNodes(doc)) {
    const n = doc.nodes[id];
    if (!n || n.type === 'instance') continue;
    if (depthOf(doc, id) < opts.minDepth) continue;
    const sig = shapeSignature(doc, id);
    const g = groups.get(sig) ?? { sig, ids: [], sample: id, inComponent: false };
    g.ids.push(id);
    if (inComponent.has(id)) g.inComponent = true;
    groups.set(sig, g);
  }
  return [...groups.values()]
    .filter((g) => g.ids.length >= opts.minCopies)
    // Outermost first: a card is a better component than each of its rows.
    .sort((a, b) => subtreeIdsOf(doc, b.sample).length - subtreeIdsOf(doc, a.sample).length);
}

/** The first bit of text in a subtree, so a group is recognisable in a list. */
/**
 * Whether a layer is still called after its tag.
 *
 * `write_html` names a node from its element, so an imported page arrives as
 * two hundred layers called Div — which is a layer tree nobody can read.
 */
function isTagName(name: string, tag: string): boolean {
  const n = name.trim().toLowerCase();
  return n === tag.toLowerCase() || n === 'frame' || n === 'text' || n === 'group' || /^(div|span) \d+$/.test(n);
}

function previewText(doc: CanvasDocument, id: NodeId): string | undefined {
  for (const nodeId of subtreeIdsOf(doc, id)) {
    const t = doc.nodes[nodeId]?.text?.trim();
    if (t) return t.length > 60 ? `${t.slice(0, 57)}…` : t;
  }
  return undefined;
}

/**
 * Every artboard's HTML, with generated class names stripped.
 *
 * An instance's emitted class encodes its own id, so a swap that changes
 * nothing a reader can see still changes `class="c-n_abc"`. Comparing with
 * those removed keeps the check about the page rather than the ids in it.
 */
function renderAll(doc: CanvasDocument): Record<string, string> {
  const out: Record<string, string> = {};
  for (const page of doc.pages) {
    for (const artboard of page.artboards) {
      const name = doc.nodes[artboard]?.name ?? artboard;
      out[`${page.name} / ${name}`] = emitHtml(doc, artboard, { mode: 'inline' }).html
        .replace(/ class="c-[^"]*"/g, '');
    }
  }
  return out;
}

/**
 * The ops that turn one subtree into a component and every copy into an
 * instance of it.
 *
 * Pure: it plans, the caller decides whether to apply. Text *and* attributes
 * travel as overrides — carrying only the text is how the first version of this
 * pointed every button on a page at the definition's own href.
 */
function componentisePlan(
  doc: CanvasDocument, id: NodeId, name: string, copies: NodeId[], description?: string,
): { ops: Op[]; componentId: string; definitionRoot: NodeId } {
  const source = doc.nodes[id]!;
  const parent = source.parent!;
  const index = doc.nodes[parent]!.children.indexOf(id);

  const { nodes: definition } = cloneSubtree(doc, id);
  const root = definition[0]!;
  root.parent = null;
  root.name = name;

  const componentId = newId('cmp');
  const ops: Op[] = [
    { t: 'insert', nodes: definition, parent: null, index: 0, page: DEFINITIONS_PAGE },
    { t: 'component', action: 'add', component: { id: componentId, name, description, root: root.id } },
    { t: 'remove', ids: [id] },
    { t: 'insert', nodes: [makeNode({ type: 'instance', name, componentRef: componentId })], parent, index },
  ];

  // The definition's nodes in document order, to line copies up against.
  const defOrder = subtreeIdsOf({ ...doc, nodes: Object.fromEntries(definition.map((n) => [n.id, n])) } as CanvasDocument, root.id);

  for (const copy of copies) {
    const copyNode = doc.nodes[copy];
    if (!copyNode?.parent) continue;
    const copyParent = doc.nodes[copyNode.parent]!;
    const at = copyParent.children.indexOf(copy);
    const instance = makeNode({ type: 'instance', name, componentRef: componentId });
    const copyOrder = subtreeIdsOf(doc, copy);

    const overrides: Record<string, { text?: string; attrs?: Record<string, string> }> = {};
    for (const [i, defId] of defOrder.entries()) {
      const defNode = definition.find((n) => n.id === defId)!;
      const other = doc.nodes[copyOrder[i] ?? ''];
      if (!other) continue;
      const patch: { text?: string; attrs?: Record<string, string> } = {};
      if (typeof other.text === 'string' && other.text !== defNode.text) patch.text = other.text;
      const attrs: Record<string, string> = {};
      for (const [k, v] of Object.entries(other.attrs ?? {})) {
        if (defNode.attrs?.[k] !== v) attrs[k] = v;
      }
      if (Object.keys(attrs).length) patch.attrs = attrs;
      if (Object.keys(patch).length) overrides[defId] = patch;
    }
    if (Object.keys(overrides).length) instance.overrides = overrides;

    ops.push({ t: 'remove', ids: [copy] });
    ops.push({ t: 'insert', nodes: [instance], parent: copyParent.id, index: at });
  }

  return { ops, componentId, definitionRoot: root.id };
}

export interface McpContext {
  connection: Connection;
  baseUrl: string;
  /** Tool groups this session asked for, or undefined for all of them. */
  toolsets?: string[];
}

/**
 * The page each connection is working on.
 *
 * Every page-shaped tool used to fall back to `pages[0]`, so an agent that
 * created a second page went on being shown the first one — silently, which is
 * the worst way for a tool to be wrong.
 *
 * Kept here rather than on the context because the HTTP transport is stateless:
 * a fresh context is built per request, and the first version of this lost the
 * page between the call that set it and the next one.
 */
const workingPage = new Map<string, string>();

function setWorkingPage(ctx: McpContext, pageId: string | undefined): void {
  if (pageId) workingPage.set(ctx.connection.code, pageId);
  else workingPage.delete(ctx.connection.code);
}

/** The page a tool should act on: the one asked for, the session's, or the first. */
function pageOf(ctx: McpContext, doc: CanvasDocument, pageId?: string): Page {
  return doc.pages.find((p) => p.id === pageId)
    ?? doc.pages.find((p) => p.id === workingPage.get(ctx.connection.code))
    ?? doc.pages[0]!;
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
    { name: 'playground', version: '0.1.0' },
    {
      instructions:
        `You are connected to a Playground design document ("${ctx.connection.docName}"). ` +
        `Playground is a design tool whose documents are real HTML and CSS.\n\n` +
        `Start with get_basic_info, then get_tree_summary on the artboard you care about. ` +
        `Create with write_html. After any visual change, call get_screenshot to check your work — ` +
        `you cannot tell whether a layout is right without looking at it.\n\n` +
        `If anyone has commented, call list_comments first — that is the actual brief, and it is ` +
        `more specific than anything you will infer from the design alone.\n\n` +
        `Call get_guide("layout") before building anything substantial; it describes what makes ` +
        `output a designer will keep rather than discard.\n\n` +
        `Before you hand work back, call lint_design on what you changed — it checks contrast, tap ` +
        `targets, token consistency and layout shape, and catches the things that get agent output ` +
        `rejected.\n\n` +
        `Reuse rather than rebuild: call list_components first, and create_component the moment you ` +
        `would otherwise build the same thing twice.\n\n` +
        `The canvas also carries prompt cards — sticky notes the human writes next to the thing ` +
        `they are about. If get_basic_info reports queued notes, call list_notes and work through ` +
        `them: claim_note, do the work, then respond_to_note. That is usually why you were called.`,
    },
  );

  /*
   * Every tool is registered; the ones outside the active sets are then
   * disabled. Registering conditionally would mean a second code path and a
   * server whose tool list depends on how you got here — and the SDK's own
   * enable() is what emits `tools/list_changed`, so widening mid-session is a
   * flag rather than a reconnection.
   */
  type Handle = { enable(): void; disable(): void; enabled: boolean };
  const handles = new Map<string, Handle>();
  const register = server.registerTool.bind(server);
  (server as { registerTool: typeof server.registerTool }).registerTool = ((name: string, ...rest: unknown[]) => {
    const handle = (register as (...args: unknown[]) => Handle)(name, ...rest);
    handles.set(name, handle);
    return handle;
  }) as typeof server.registerTool;

  registerReadTools(server, ctx);
  registerWriteTools(server, ctx);
  registerNoteTools(server, ctx);
  registerComponentTools(server, ctx);
  registerCodeComponentTools(server, ctx);
  registerCommentTools(server, ctx);
  registerSessionTools(server, ctx);

  const active = new Set(ctx.toolsets ?? ['all']);
  /*
   * Only tools whose state actually changes are touched. Each enable() emits
   * `tools/list_changed`, so re-enabling everything sent seventy-seven
   * notifications for one group being switched on.
   */
  const apply = () => {
    for (const [name, handle] of handles) {
      const wanted = active.has('all') || active.has(setOf(name));
      if (wanted === handle.enabled) continue;
      if (wanted) handle.enable();
      else handle.disable();
    }
  };

  server.registerTool('list_toolsets', {
    title: 'List the tool groups',
    description:
      'Which groups of tools exist, which are switched on for this session, and what is in each. '
      + 'A smaller surface is cheaper context; use_toolset switches one on when you need it.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => guard(() => json({
    active: active.has('all') ? 'all' : [...active],
    sets: {
      core: { on: true, note: 'Always available: reading, writing, screenshots, linting.' },
      ...Object.fromEntries(Object.entries(TOOLSETS).map(([name, tools]) => [name, {
        on: active.has('all') || active.has(name),
        tools: tools.length,
        examples: tools.slice(0, 3),
      }])),
    },
  })));

  server.registerTool('use_toolset', {
    title: 'Switch on a group of tools',
    description:
      'Enables a group for the rest of this session — "components", "code", "handover", "collab", '
      + '"pages", or "all". The tool list changes as soon as this returns.',
    inputSchema: {
      name: z.string().describe('A group from list_toolsets, or "all".'),
    },
  }, async ({ name }) => guard(() => {
    if (name !== 'all' && !TOOLSETS[name]) {
      return fail(`No toolset "${name}". Call list_toolsets to see them.`);
    }
    active.add(name);
    apply();
    return json({
      active: active.has('all') ? 'all' : [...active],
      added: name === 'all' ? Object.values(TOOLSETS).flat().length : TOOLSETS[name]!.length,
    });
  }));

  // Core is not in the table, so these two are already in it — and they must
  // survive the pass that turns everything else off.
  handles.delete('list_toolsets');
  handles.delete('use_toolset');
  apply();

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
    inputSchema: { pageId: z.string().optional().describe('Page to describe. Defaults to the page this session is working on.') },
    annotations: { readOnlyHint: true },
  }, async ({ pageId }) => guard(() => {
    const doc = requireDoc(ctx);
    const page = pageOf(ctx, doc, pageId);
    const notes = page?.notes ?? [];
    const queued = notes.filter((n) => n.status === 'queued');
    return json({
      ...basicInfo(doc, page.id),
      liveTabConnected: hasLiveTab(doc.id),
      rev: doc.rev,
      notes: {
        total: notes.length,
        queued: queued.length,
        ...(queued.length
          ? { hint: `${queued.length} prompt card${queued.length === 1 ? '' : 's'} waiting for an agent — call list_notes.` }
          : {}),
      },
    });
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
    const page = pageOf(ctx, doc);
    if (page.artboards.length === 0) {
      return text(`(page "${page.name}" has no artboards yet — create one with create_artboard)`);
    }
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

  server.registerTool('lint_design', {
    title: 'Check a design',
    description:
      'Runs the design checks and reports what is wrong: text contrast below WCAG AA, tap targets ' +
      'under 44px, missing alt text, literals where the design uses a token, containers that cannot ' +
      'reflow, and structures repeated enough to deserve a component.\n\n' +
      'Run this on your own work before handing it back. get_guide describes what good output looks ' +
      'like; this tells you whether yours is.',
    inputSchema: {
      within: z.string().optional().describe('Limit to one artboard or subtree. Defaults to the whole document.'),
      rules: z.array(z.string()).optional().describe(`Limit to specific rules: ${RULES.map((r) => r.id).join(', ')}`),
      severity: z.enum(['error', 'warning', 'info']).optional()
        .describe('Minimum severity to report. Defaults to reporting everything.'),
      theme: z.string().optional(),
    },
    annotations: { readOnlyHint: true },
  }, async ({ within, rules, severity, theme }) => guard(async () => {
    const doc = requireDoc(ctx);
    if (within) node(doc, within);

    // Rendered boxes make the tap-target check exact rather than a guess from
    // authored styles; without a tab it stays conservative.
    let measured: Record<string, { width: number; height: number }> | undefined;
    if (hasLiveTab(doc.id)) {
      const ids = Object.values(doc.nodes)
        .filter((n) => n.tag === 'button' || n.tag === 'a' || n.attrs.role === 'button')
        .map((n) => n.id)
        .slice(0, 200);
      if (ids.length) {
        measured = await callTab<Record<string, { width: number; height: number }>>(doc.id, 'measure', { ids })
          .catch(() => undefined);
      }
    }

    const findings = lintDocument(doc, {
      within,
      rules: rules as never,
      theme,
      measured,
    }).filter((f) => !severity || rank(f.severity) <= rank(severity));

    if (!findings.length) {
      return text(
        within
          ? 'No problems found in that subtree.'
          : 'No problems found. Run this again after any substantial change.',
      );
    }

    return json({
      total: findings.length,
      bySeverity: {
        error: findings.filter((f) => f.severity === 'error').length,
        warning: findings.filter((f) => f.severity === 'warning').length,
        info: findings.filter((f) => f.severity === 'info').length,
      },
      summary: summarise(findings).map((s) => ({
        ...s,
        why: RULES.find((r) => r.id === s.rule)?.why,
      })),
      findings: findings.slice(0, 100).map((f) => ({
        rule: f.rule,
        severity: f.severity,
        node: f.nodeId,
        name: getNode(doc, f.nodeId)?.name ?? null,
        artboard: f.artboard,
        message: f.message,
        fix: f.fix ?? null,
      })),
      ...(findings.length > 100 ? { note: `${findings.length - 100} more not listed; narrow with "within" or "rules".` } : {}),
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
  // --- Pages ----------------------------------------------------------------
  //
  // A document can hold several pages — a landing page, a deck, a set of
  // explorations — and until now an agent could not make one, see the list, or
  // work on any but the first. Both scripts in this repo that needed a second
  // page had to reach past MCP to the ops endpoint the editor uses.

  server.registerTool('list_pages', {
    title: 'List pages',
    description:
      'Pages in this document, with how many artboards each holds and which one this session is working on.',
    annotations: { readOnlyHint: true },
  }, async () => guard(() => {
    const doc = requireDoc(ctx);
    const current = pageOf(ctx, doc);
    return json({
      pages: doc.pages.map((p) => ({
        id: p.id,
        name: p.name,
        artboards: p.artboards.length,
        current: p.id === current.id,
      })),
      currentPage: current.id,
    });
  }));

  server.registerTool('create_page', {
    title: 'Create a page',
    description:
      'Adds a page and makes it the one this session works on. Use a page to separate whole ' +
      'deliverables — a site and a deck about it — rather than to organise screens, which is what ' +
      'artboards on one page are for.',
    inputSchema: {
      name: z.string().min(1).max(80),
      switchTo: z.boolean().optional().default(true),
    },
    annotations: { destructiveHint: false },
  }, async ({ name, switchTo }) => guard(() => {
    const doc = requireDoc(ctx);
    if (doc.pages.some((p) => p.name === name)) {
      return fail(`This document already has a page called "${name}".`);
    }
    const page = { id: newId('p'), name, artboards: [] as NodeId[] };
    commit(ctx, [{ t: 'page', action: 'add', page }]);
    if (switchTo) setWorkingPage(ctx, page.id);
    return json({
      pageId: page.id,
      name,
      current: switchTo,
      next: 'create_artboard puts a screen on it. Artboards are placed on the current page unless you pass pageId.',
    });
  }));

  server.registerTool('set_current_page', {
    title: 'Work on a page',
    description:
      'Chooses the page this session reads and writes by default. Other sessions are unaffected.',
    inputSchema: { pageId: z.string() },
    annotations: { destructiveHint: false, readOnlyHint: true },
  }, async ({ pageId }) => guard(() => {
    const doc = requireDoc(ctx);
    const page = doc.pages.find((p) => p.id === pageId);
    if (!page) {
      return fail(`No page "${pageId}". Call list_pages — pages are ${doc.pages.map((p) => `${p.name} (${p.id})`).join(', ')}.`);
    }
    setWorkingPage(ctx, page.id);
    return json({ currentPage: page.id, name: page.name, artboards: page.artboards.length });
  }));

  server.registerTool('rename_page', {
    title: 'Rename a page',
    description: 'Changes a page\'s name. Ids do not change, so nothing else has to be updated.',
    inputSchema: { pageId: z.string(), name: z.string().min(1).max(80) },
    annotations: { destructiveHint: false },
  }, async ({ pageId, name }) => guard(() => {
    const doc = requireDoc(ctx);
    const page = doc.pages.find((p) => p.id === pageId);
    if (!page) return fail(`No page "${pageId}". Call list_pages.`);
    commit(ctx, [{ t: 'page', action: 'rename', page: { ...page, name } }]);
    return json({ pageId, name });
  }));

  server.registerTool('delete_page', {
    title: 'Delete a page',
    description: 'Removes a page and everything on it. A document must keep at least one page.',
    inputSchema: {
      pageId: z.string(),
      confirm: z.boolean().describe('Must be true. The artboards on the page go with it.'),
    },
  }, async ({ pageId, confirm }) => guard(() => {
    const doc = requireDoc(ctx);
    const page = doc.pages.find((p) => p.id === pageId);
    if (!page) return fail(`No page "${pageId}". Call list_pages.`);
    if (doc.pages.length === 1) return fail('This is the only page; a document must have one.');
    if (!confirm) {
      return fail(`"${page.name}" holds ${page.artboards.length} artboard(s). Pass confirm: true to delete it and them.`);
    }
    // The artboards first: removing the page alone would leave their nodes in
    // the document with nothing pointing at them. The count is taken before the
    // commit, which empties the live page object as it applies.
    const artboards = [...page.artboards];
    const ops: Op[] = [];
    if (artboards.length) ops.push({ t: 'remove', ids: artboards });
    ops.push({ t: 'page', action: 'remove', page: { ...page, artboards } });
    commit(ctx, ops);
    if (workingPage.get(ctx.connection.code) === pageId) setWorkingPage(ctx, undefined);
    return json({ deleted: pageId, artboardsRemoved: artboards.length });
  }));

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
    const page = pageOf(ctx, doc, pageId);

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

  server.registerTool('list_templates', {
    title: 'List starter design systems',
    description:
      'Built-in kits, each a token set plus a foundations artboard. Applying one before building gives ' +
      'you tokens to reference instead of inventing hex codes.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => guard(() => json({ templates: templateSummaries() })));

  server.registerTool('apply_template', {
    title: 'Apply a starter design system',
    description:
      'Merges a kit’s tokens into the document and adds its foundations artboard. Tokens that already ' +
      'exist are left alone, so this never overwrites work.',
    inputSchema: {
      template: z.string().describe('Template id from list_templates.'),
      replaceTokens: z.boolean().optional().default(false)
        .describe('Overwrite tokens whose names already exist. Off by default so a kit never clobbers existing work.'),
    },
  }, async ({ template, replaceTokens }) => guard(() => {
    const doc = requireDoc(ctx);
    const kit = getTemplate(template);
    if (!kit) return fail(`No template "${template}". Available: ${templateSummaries().map((t) => t.id).join(', ')}`);

    const page = pageOf(ctx, doc);
    const existing = new Map(doc.tokens.map((t) => [t.name, t]));
    const added: typeof kit.tokens = [];
    const skipped: string[] = [];

    for (const token of kit.tokens) {
      if (existing.has(token.name) && !replaceTokens) { skipped.push(token.name); continue; }
      existing.set(token.name, token);
      added.push(token);
    }

    const ops: Op[] = [{ t: 'tokens', tokens: [...existing.values()] }];
    const created: string[] = [];

    for (const spec of kit.artboards) {
      const artboard = makeNode({
        type: 'artboard',
        name: `${kit.name} — ${spec.name}`,
        styles: { ...DEFAULT_ARTBOARD_STYLES, ...spec.styles, width: `${spec.width}px`, height: `${spec.height}px` },
        attrs: { 'data-x': String(rightmostEdge(doc, page.artboards) + 120), 'data-y': '0' },
      });
      const parsed = parseHtml(spec.html);
      ops.push({ t: 'insert', nodes: [artboard], parent: null, index: page.artboards.length, page: page.id });
      ops.push({ t: 'insert', nodes: parsed.nodes, parent: artboard.id, index: 0 });
      created.push(artboard.id);
    }

    commit(ctx, ops);
    return json({
      applied: kit.id,
      tokensAdded: added.map((t) => `var(${tokenToCssVar(t.name)})`),
      ...(skipped.length
        ? {
            tokensSkipped: skipped,
            note: `${skipped.length} token${skipped.length === 1 ? '' : 's'} already existed and were kept. ` +
              `Pass replaceTokens:true to take the kit's values instead — otherwise this kit will render in the document's existing palette.`,
          }
        : {}),
      artboards: created,
      next: 'Call get_tokens, then use those variables instead of literal colours.',
    });
  }));

  server.registerTool('import_url', {
    title: 'Import a webpage onto the canvas',
    description:
      'Loads a public webpage in a real browser at a real width and turns it into editable layers: '
      + 'the computed styles, so a page built with utility classes arrives looking like itself, and '
      + 'the site\'s own CSS variables as document tokens. Pass several routes to bring in a whole '
      + 'site, one page each. Images become placeholders at the size they occupied. Falls back to a '
      + 'static fetch where no browser is available, which cannot resolve utility classes.',
    inputSchema: {
      url: z.string().describe('Absolute http(s) URL.'),
      width: z.number().min(320).max(3840).optional().default(1440)
        .describe('The width to read the page at. The design you get is the one that width produces.'),
      routes: z.array(z.string()).max(24).optional()
        .describe('Paths on the same site, e.g. ["/", "/pricing"]. Each becomes its own page of the document.'),
      tokens: z.boolean().optional().default(true)
        .describe("Register the site's :root custom properties as tokens and reference them in the styles."),
      artboardId: z.string().optional().describe('Import a single page into this artboard instead of creating one.'),
    },
  }, async ({ url, width, routes, tokens, artboardId }) => guard(async () => {
    const doc = requireDoc(ctx);
    const live = await importUrlLive(url, { width, routes }).catch((err: unknown) => {
      if (err instanceof ImportError) throw err;
      return null;
    });

    // No browser on this host: the old path is worse but it is not nothing.
    if (!live) return staticImport(ctx, url, artboardId);

    const varTokens = tokens ? tokensFromVars(live.vars) : [];
    if (varTokens.length) commit(ctx, [{ t: 'tokens', tokens: [...doc.tokens, ...varTokens] }]);

    const made: { page: string; artboard: string; route: string; sections: number }[] = [];
    const many = live.pages.length > 1;

    for (const shot of live.pages) {
      const label = shot.route === '/' ? 'Home' : shot.route.replace(/^\//, '').replace(/\/$/, '');
      const title = label.charAt(0).toUpperCase() + label.slice(1);

      // One route, one page: a site imported onto a single canvas is a wall.
      let pageId = pageOf(ctx, doc).id;
      if (many) {
        const page = { id: newId('pg'), name: title || 'Home', artboards: [] };
        commit(ctx, [{ t: 'page', action: 'add', page }]);
        pageId = page.id;
      }
      const target = doc.pages.find((p) => p.id === pageId)!;

      let boardId = !many ? artboardId : undefined;
      if (boardId) node(doc, boardId);
      else {
        const artboard = makeNode({
          type: 'artboard',
          name: `${title || shot.title.slice(0, 30)} — ${width}`,
          styles: {
            ...DEFAULT_ARTBOARD_STYLES,
            width: `${width}px`,
            height: `${Math.min(20000, shot.height)}px`,
          },
          attrs: { 'data-x': String(many ? 0 : rightmostEdge(doc, target.artboards) + 120), 'data-y': '0' },
        });
        commit(ctx, [{ t: 'insert', nodes: [artboard], parent: null, index: target.artboards.length, page: target.id }]);
        boardId = artboard.id;
      }

      // The wrapper first, then a section at a time: a page is tens of
      // kilobytes of HTML, and a failure inside one giant write says nothing
      // about where it happened.
      const wrapper = parseHtml(`<div style="${shot.wrapper}"></div>`);
      commit(ctx, [{ t: 'insert', nodes: wrapper.nodes, parent: boardId, index: 0 }]);
      const root = wrapper.roots[0]!;
      for (const section of shot.sections) {
        const parsed = parseHtml(tokens ? tokenise(section, live.vars) : section);
        if (!parsed.nodes.length) continue;
        commit(ctx, [{ t: 'insert', nodes: parsed.nodes, parent: root, index: doc.nodes[root]!.children.length }]);
      }
      made.push({ page: target.name, artboard: boardId, route: shot.route, sections: shot.sections.length });
    }

    return json({
      imported: made,
      tokens: varTokens.length,
      warnings: live.warnings,
      next: 'find_repeated_shapes, then componentise the ones worth a name — an imported page is all copies.',
    });
  }));

  /** The pre-browser path, kept for hosts that cannot run one. */
  async function staticImport(context: McpContext, url: string, artboardId?: string) {
    const doc = requireDoc(context);
    const result = await importUrl(url);
    const page = pageOf(context, doc);

    let target = artboardId;
    if (target) node(doc, target);
    else {
      const artboard = makeNode({
        type: 'artboard',
        name: result.title.slice(0, 40),
        styles: { ...DEFAULT_ARTBOARD_STYLES, width: '1440px', height: '1200px' },
        attrs: { 'data-x': String(rightmostEdge(doc, page.artboards) + 120), 'data-y': '0' },
      });
      commit(context, [{ t: 'insert', nodes: [artboard], parent: null, index: page.artboards.length, page: page.id }]);
      target = artboard.id;
    }

    commit(context, [{ t: 'insert', nodes: result.nodes, parent: target, index: 0 }]);
    return json({
      artboardId: target,
      nodeCount: result.nodes.length,
      title: result.title,
      warnings: [...result.warnings,
        'No browser on this host, so this is a static fetch: utility classes and anything a script draws are missing.'],
    });
  }

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
        selector: z.string().optional()
        .describe('":hover", ":focus", or a breakpoint selector from get_breakpoints. Omit for base styles.'),
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
        const siblings = parent ? doc.nodes[parent]!.children : pageOf(ctx, doc).artboards;
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
        const page = doc.pages.find((p) => p.artboards.includes(id)) ?? pageOf(ctx, doc);
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

  server.registerTool('sync_tokens_from_code', {
    title: 'Bring the codebase’s tokens in',
    description:
      'Reads design tokens out of the project and merges them into the document, so the design uses ' +
      'the same values the code does. Playground cannot read the repository — you can. Pass the ' +
      'contents of the stylesheet that declares the custom properties, or the theme object from ' +
      'tailwind.config.\n\n' +
      'Use dryRun first to see what would change.',
    inputSchema: {
      css: z.string().optional().describe('A stylesheet containing :root custom properties.'),
      tailwindTheme: z.record(z.string(), z.unknown()).optional()
        .describe('A Tailwind theme object, e.g. the value of theme.extend.'),
      dryRun: z.boolean().optional().default(false).describe('Report the differences without applying them.'),
      removeMissing: z.boolean().optional().default(false)
        .describe('Also delete tokens the source does not mention. Off by default: a stylesheet is usually only part of a system.'),
    },
  }, async ({ css, tailwindTheme, dryRun, removeMissing }) => guard(() => {
    const doc = requireDoc(ctx);
    if (!css && !tailwindTheme) return fail('Pass either `css` or `tailwindTheme`.');

    const parsed = css
      ? parseTokensFromCss(css, doc.tokens.map((t) => t.name))
      : parseTokensFromTailwind(tailwindTheme!);

    if (!parsed.tokens.length) {
      return fail(parsed.warnings[0] ?? 'No tokens found in that source.');
    }

    const diff = diffTokens(doc.tokens, parsed.tokens);

    if (dryRun) {
      return json({
        dryRun: true,
        wouldAdd: diff.added.map((t) => ({ name: t.name, value: t.values.default })),
        wouldChange: diff.changed,
        onlyInDesign: diff.removed.map((t) => t.name),
        unchanged: diff.unchanged,
        warnings: parsed.warnings,
      });
    }

    const merged = mergeTokens(doc.tokens, parsed.tokens, { removeMissing });
    commit(ctx, [{ t: 'tokens', tokens: merged }]);

    return json({
      added: diff.added.length,
      changed: diff.changed.length,
      removed: removeMissing ? diff.removed.length : 0,
      unchanged: diff.unchanged,
      ...(diff.removed.length && !removeMissing
        ? { keptOnlyInDesign: diff.removed.map((t) => t.name) }
        : {}),
      warnings: parsed.warnings,
      next: 'Call lint_design — literals that now duplicate a token will be reported.',
    });
  }));

  server.registerTool('export_tokens', {
    title: 'Write the design’s tokens out',
    description:
      'Returns the document’s tokens in the format the project uses, for you to write into the repo. ' +
      'CSS emits custom properties with a block per theme; Tailwind emits a theme that references ' +
      'those variables, so switching theme at runtime switches the utility classes too.',
    inputSchema: {
      format: z.enum(['css', 'tailwind', 'json']).optional().default('css'),
    },
    annotations: { readOnlyHint: true },
  }, async ({ format }) => guard(() => {
    const doc = requireDoc(ctx);
    if (!doc.tokens.length) return fail('This document has no tokens yet.');
    return text(serializeTokens(doc, format));
  }));

  server.registerTool('check_token_drift', {
    title: 'Compare tokens with the codebase',
    description:
      'Reports where the design and the code disagree, without changing either. Run it when picking ' +
      'a design back up: tokens drift the moment either side is edited alone.',
    inputSchema: {
      css: z.string().optional(),
      tailwindTheme: z.record(z.string(), z.unknown()).optional(),
    },
    annotations: { readOnlyHint: true },
  }, async ({ css, tailwindTheme }) => guard(() => {
    const doc = requireDoc(ctx);
    if (!css && !tailwindTheme) return fail('Pass either `css` or `tailwindTheme`.');

    const parsed = css
      ? parseTokensFromCss(css, doc.tokens.map((t) => t.name))
      : parseTokensFromTailwind(tailwindTheme!);
    const diff = diffTokens(doc.tokens, parsed.tokens);

    // A design holding tokens the stylesheet does not mention is a superset,
    // not drift — reporting it as out of sync makes a successful sync look
    // like a failure. Drift is a value that differs, or a token only code has.
    const drifted = diff.changed.length > 0 || diff.added.length > 0;

    if (!drifted) {
      return text(
        `In sync: ${diff.unchanged} tokens match.` +
        (diff.removed.length
          ? ` ${diff.removed.length} more exist only in the design, which is fine — export_tokens writes them out if the code should have them.`
          : ''),
      );
    }

    return json({
      inSync: false,
      changed: diff.changed,
      onlyInCode: diff.added.map((t) => ({ name: t.name, value: t.values.default })),
      onlyInDesign: diff.removed.map((t) => t.name),
      unchanged: diff.unchanged,
      next: 'sync_tokens_from_code takes the code’s values; export_tokens writes the design’s values out.',
    });
  }));

  server.registerTool('get_breakpoints', {
    title: 'Get the document’s breakpoints',
    description:
      'The named widths this design responds at. Author responsive overrides against these rather ' +
      'than inventing widths — artboards are real viewports, so setting one to a breakpoint width ' +
      'shows exactly what that breakpoint does.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => guard(() => {
    const doc = requireDoc(ctx);
    return json({
      breakpoints: breakpointsOf(doc).map((bp) => ({
        ...bp,
        selector: breakpointSelector(bp),
        usage: `Pass selector "${breakpointSelector(bp)}" to update_styles.`,
      })),
    });
  }));

  server.registerTool('set_breakpoints', {
    title: 'Set the document’s breakpoints',
    description:
      'Replaces the breakpoint list. Use it to match the widths the codebase already uses, so design ' +
      'and code respond at the same places.',
    inputSchema: {
      breakpoints: z.array(z.object({
        name: z.string().min(1).max(24),
        maxWidth: z.number().int().min(160).max(4000),
      })).min(1).max(12),
    },
  }, async ({ breakpoints }) => guard(() => {
    const doc = requireDoc(ctx);
    const seen = new Set<number>();
    for (const bp of breakpoints) {
      if (seen.has(bp.maxWidth)) return fail(`Two breakpoints share the width ${bp.maxWidth}px.`);
      seen.add(bp.maxWidth);
    }

    const existing = breakpointsOf(doc);
    commit(ctx, [{
      t: 'breakpoints',
      breakpoints: breakpoints.map((bp) => ({
        // Keep ids stable for widths that already exist, so existing variants
        // and any UI state stay attached to the same breakpoint.
        id: existing.find((e) => e.maxWidth === bp.maxWidth)?.id ?? newId('bp'),
        name: bp.name,
        maxWidth: bp.maxWidth,
      })),
    }]);
    return json({ breakpoints: breakpoints.length });
  }));

  server.registerTool('preview_at_width', {
    title: 'See an artboard at a width',
    description:
      'Sets an artboard’s width so the browser re-resolves its media queries, and returns a ' +
      'screenshot. This is how to check a responsive design actually works rather than assuming it ' +
      'does — the reflow you see is the reflow that will ship.',
    inputSchema: {
      id: z.string().describe('Artboard id.'),
      width: z.number().int().min(160).max(4000).optional()
        .describe('Width to set. Omit to use each of the document’s breakpoints in turn.'),
      restore: z.boolean().optional().default(true).describe('Put the width back afterwards.'),
    },
  }, async ({ id, width, restore }) => guard(async () => {
    const doc = requireDoc(ctx);
    const artboard = node(doc, id);
    if (artboard.type !== 'artboard') return fail(`${id} is not an artboard.`);

    const original = artboard.styles.width;
    const widths = width ? [width] : breakpointsOf(doc).map((bp) => bp.maxWidth);
    const shots: { width: number; breakpoint: string | null; image: string; mime: string }[] = [];

    try {
      for (const w of widths) {
        commit(ctx, [{ t: 'styles', updates: [{ id, styles: { width: `${w}px` } }] }]);
        const { data, mime } = await renderNode(requireDoc(ctx), id, { format: 'png', scale: 1, baseUrl: ctx.baseUrl });
        shots.push({
          width: w,
          breakpoint: breakpointsOf(doc).find((bp) => bp.maxWidth === w)?.name ?? null,
          image: data.toString('base64'),
          mime,
        });
      }
    } finally {
      if (restore && original) {
        commit(ctx, [{ t: 'styles', updates: [{ id, styles: { width: original } }] }]);
      }
    }

    return {
      content: [
        { type: 'text' as const, text: `${artboard.name} at ${shots.map((s) => `${s.width}px${s.breakpoint ? ` (${s.breakpoint})` : ''}`).join(', ')}.` },
        ...shots.map((s) => ({ type: 'image' as const, data: s.image, mimeType: s.mime })),
      ],
    };
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
      const assetId = await storeAsset(doc.id, mime, `${slug(n.name)}.${format}`, data);
      out.push({
        id, name: n.name, format, bytes: data.length,
        url: `${ctx.baseUrl}/assets/${assetId}`,
        ...(includeBase64 ? { base64: data.toString('base64') } : {}),
      });
    }
    return json({ exported: out });
  }));
}

function rightmostEdge(doc: CanvasDocument, artboards: NodeId[]): number {
  let max = 0;
  for (const id of artboards) {
    const n = getNode(doc, id);
    if (!n) continue;
    max = Math.max(max, getArtboardPosition(n).x + getArtboardSize(n).width);
  }
  return max;
}

const SEVERITY_RANK = { error: 0, warning: 1, info: 2 } as const;
function rank(severity: 'error' | 'warning' | 'info'): number {
  return SEVERITY_RANK[severity];
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'export';
}


// ---------------------------------------------------------------------------
// Prompt cards
// ---------------------------------------------------------------------------

function registerNoteTools(server: McpServer, ctx: McpContext): void {
  server.registerTool('list_notes', {
    title: 'List prompt cards',
    description:
      'Prompt cards on the canvas — sticky notes the human placed next to the thing they are about. ' +
      'A card with status "queued" is a request for an agent. Each carries the node ids it refers to; ' +
      'read those before acting.',
    inputSchema: {
      status: z.enum(['idle', 'queued', 'running', 'done', 'all']).optional().default('queued'),
      pageId: z.string().optional(),
    },
    annotations: { readOnlyHint: true },
  }, async ({ status, pageId }) => guard(() => {
    const doc = requireDoc(ctx);
    const page = pageOf(ctx, doc, pageId);
    const notes = (page.notes ?? []).filter((n) => status === 'all' || n.status === status);

    if (!notes.length) {
      return text(
        status === 'queued'
          ? 'No prompt cards are waiting for an agent. Use status:"all" to see every card.'
          : `No prompt cards with status "${status}".`,
      );
    }

    return json({
      pageId: page.id,
      notes: notes.map((n) => ({
        id: n.id,
        text: n.text,
        status: n.status,
        claimedBy: n.claimedBy ?? null,
        position: { x: n.x, y: n.y },
        targets: n.targets.map((id) => {
          const node = getNode(doc, id);
          return node
            ? { id, name: node.name, type: node.type, artboard: artboardOf(doc, id) }
            : { id, missing: true };
        }),
        // A card with no explicit targets is about whatever it sits next to.
        nearestArtboard: n.targets.length ? undefined : nearestArtboard(doc, page, n.x, n.y),
        response: n.response ?? null,
      })),
    });
  }));

  server.registerTool('claim_note', {
    title: 'Claim a prompt card',
    description:
      'Marks a card as being worked on by you, so a second agent does not duplicate the work and the ' +
      'human can see it was picked up. Claim before you start.',
    inputSchema: { id: z.string(), pageId: z.string().optional() },
  }, async ({ id, pageId }) => guard(() => {
    const doc = requireDoc(ctx);
    const page = pageOf(ctx, doc, pageId);
    const note = (page.notes ?? []).find((n) => n.id === id);
    if (!note) return fail(`No prompt card with id "${id}". Call list_notes for current ids.`);
    if (note.status === 'running' && note.claimedBy && note.claimedBy !== (ctx.connection.label ?? 'Agent')) {
      return fail(`"${note.claimedBy}" is already working on this card. Pick another, or ask the human.`);
    }

    commit(ctx, [{
      t: 'note', action: 'update', pageId: page.id,
      note: { id, status: 'running', claimedBy: ctx.connection.label ?? 'Agent' },
    }]);

    return json({
      claimed: id,
      text: note.text,
      targets: note.targets,
      next: note.targets.length
        ? 'Read the target nodes with get_tree_summary, then do the work and call respond_to_note.'
        : 'This card has no explicit targets; use nearestArtboard from list_notes, or ask the human.',
    });
  }));

  server.registerTool('respond_to_note', {
    title: 'Answer a prompt card',
    description:
      'Records what you did and closes the card. Keep the response short and concrete — it is shown ' +
      'on the card on the canvas, not in a chat log.',
    inputSchema: {
      id: z.string(),
      response: z.string().max(2000).describe('One or two sentences on what you changed.'),
      status: z.enum(['done', 'queued']).optional().default('done')
        .describe('Use "queued" to hand the card back if you could not complete it.'),
      pageId: z.string().optional(),
    },
  }, async ({ id, response, status, pageId }) => guard(() => {
    const doc = requireDoc(ctx);
    const page = pageOf(ctx, doc, pageId);
    const note = (page.notes ?? []).find((n) => n.id === id);
    if (!note) return fail(`No prompt card with id "${id}".`);

    commit(ctx, [{
      t: 'note', action: 'update', pageId: page.id,
      note: { id, status, response, claimedBy: status === 'done' ? ctx.connection.label ?? 'Agent' : undefined },
    }]);
    notifyTabs(doc.id, {
      kind: 'note-answered',
      agent: ctx.connection.label ?? 'Agent',
      noteId: id,
      response,
    });
    return json({ id, status });
  }));

  server.registerTool('create_note', {
    title: 'Leave a note on the canvas',
    description:
      'Places a sticky note on the canvas. Use it to flag something for the human, ask a question you ' +
      'cannot resolve, or leave a decision you made where they will see it next to the design.',
    inputSchema: {
      text: z.string().min(1).max(2000),
      targets: z.array(z.string()).optional().describe('Node ids the note is about; it is placed beside them.'),
      x: z.number().optional(),
      y: z.number().optional(),
      color: z.enum(['yellow', 'blue', 'green', 'pink', 'purple']).optional().default('blue'),
      pageId: z.string().optional(),
    },
  }, async ({ text: body, targets, x, y, color, pageId }) => guard(() => {
    const doc = requireDoc(ctx);
    const page = pageOf(ctx, doc, pageId);

    let px = x;
    let py = y;
    if (px === undefined || py === undefined) {
      // Place it just right of the artboard the targets live in, so it reads as
      // a margin note rather than landing on top of the design.
      const anchorId = targets?.[0] ? artboardOf(doc, targets[0]) : page.artboards[0];
      const anchor = anchorId ? getNode(doc, anchorId) : undefined;
      if (anchor) {
        const pos = getArtboardPosition(anchor);
        const size = getArtboardSize(anchor);
        px = px ?? pos.x + size.width + 40;
        py = py ?? pos.y + (page.notes?.length ?? 0) * 180;
      }
    }

    const note = makeNote({
      text: body,
      targets: targets ?? [],
      color,
      x: px ?? 0,
      y: py ?? 0,
      author: ctx.connection.label ?? 'Agent',
    });

    commit(ctx, [{ t: 'note', action: 'add', pageId: page.id, note }]);
    return json({ id: note.id, x: note.x, y: note.y });
  }));
}

function nearestArtboard(
  doc: CanvasDocument,
  page: { artboards: NodeId[] },
  x: number,
  y: number,
): { id: NodeId; name: string; distance: number } | null {
  let best: { id: NodeId; name: string; distance: number } | null = null;
  for (const id of page.artboards) {
    const node = getNode(doc, id);
    if (!node) continue;
    const pos = getArtboardPosition(node);
    const size = getArtboardSize(node);
    // Distance to the artboard's box, zero when the point is inside it.
    const dx = Math.max(pos.x - x, 0, x - (pos.x + size.width));
    const dy = Math.max(pos.y - y, 0, y - (pos.y + size.height));
    const distance = Math.round(Math.hypot(dx, dy));
    if (!best || distance < best.distance) best = { id, name: node.name, distance };
  }
  return best;
}


// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function registerComponentTools(server: McpServer, ctx: McpContext): void {
  server.registerTool('list_components', {
    title: 'List components',
    description:
      'Reusable components in this document, with their instance counts and slots. Before building ' +
      'something that already exists here, use the component instead — it is what keeps repeated ' +
      'elements from drifting apart.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => guard(() => {
    const doc = requireDoc(ctx);
    const components = componentsOf(doc);
    if (!components.length) {
      return text('This document has no components yet. create_component turns a subtree into one.');
    }
    return json({
      components: components.map((c) => {
        const root = getNode(doc, c.root);
        return {
          id: c.id,
          name: c.name,
          description: c.description ?? null,
          root: c.root,
          instances: instancesOf(doc, c.id).length,
          slots: root ? collectSlots(doc, root) : [],
          props: c.props ?? [],
          variants: (c.variants ?? []).map((v) => ({ match: v.match, overrides: Object.keys(v.overrides).length })),
          structure: root ? treeSummary(doc, c.root, { depth: 3 }) : null,
        };
      }),
    });
  }));

  server.registerTool('create_component', {
    title: 'Create a component',
    description:
      'Turns an existing subtree into a reusable component and replaces it with an instance. Use this ' +
      'as soon as you find yourself about to build the same thing twice.',
    inputSchema: {
      id: z.string().describe('Node to turn into a component.'),
      name: z.string().min(1).max(60),
      description: z.string().max(280).optional(),
    },
  }, async ({ id, name, description }) => guard(() => {
    const doc = requireDoc(ctx);
    const source = node(doc, id);
    if (source.type === 'artboard') return fail('Artboards cannot be components. Pick a layer inside one.');
    if (source.type === 'instance') return fail(`${id} is already a component instance.`);
    if (!source.parent) return fail(`${id} has no parent, so there is nothing to replace with an instance.`);

    const parent = source.parent;
    const index = doc.nodes[parent]!.children.indexOf(id);

    const { nodes: definition } = cloneSubtree(doc, id);
    const root = definition[0]!;
    root.parent = null;
    root.name = name;

    const componentId = newId('cmp');
    const instance = makeNode({ type: 'instance', name, componentRef: componentId });

    commit(ctx, [
      { t: 'insert', nodes: definition, parent: null, index: 0, page: DEFINITIONS_PAGE },
      { t: 'component', action: 'add', component: { id: componentId, name, description, root: root.id } },
      { t: 'remove', ids: [id] },
      { t: 'insert', nodes: [instance], parent, index },
    ]);

    return json({
      componentId,
      definitionRoot: root.id,
      instanceId: instance.id,
      next: 'Insert more with insert_instance. Mark a layer in the definition with data-slot to let instances supply their own content.',
    });
  }));

  // --- Publishing -------------------------------------------------------------

  server.registerTool('publish_page', {
    title: 'Publish an artboard as a web page',
    description:
      'Puts one artboard on the public web at /p/<slug> — no editor, no account, no share token. ' +
      'The page re-renders from the document, so edits appear without republishing. Call it again ' +
      'to change which artboard or what address.',
    inputSchema: {
      artboardId: z.string().optional().describe('Defaults to the first artboard on the first page.'),
      slug: z.string().max(60).optional().describe('The address. Defaults to the document name.'),
      description: z.string().max(280).optional().describe('For link previews and search results.'),
    },
    annotations: { destructiveHint: false },
  }, async ({ artboardId, slug, description }) => guard(async () => {
    const doc = requireDoc(ctx);
    if (artboardId) {
      const n = node(doc, artboardId);
      if (n.type !== 'artboard') return fail(`${artboardId} is a ${n.type}; publish an artboard.`);
    }
    const chosen = pageArtboard(doc, artboardId ?? null);
    if (!chosen) return fail('This document has no artboards yet.');

    const store = await persistence();
    const existing = await store.loadPublicationFor(doc.id);
    const wanted = slugify(slug || existing?.slug || doc.name);
    const clash = await store.loadPublication(wanted);
    if (clash && clash.docId !== doc.id) {
      return fail(`The address /p/${wanted} is taken. Pass a different slug.`);
    }
    if (existing && existing.slug !== wanted) await store.deletePublication(existing.slug);

    const publication = {
      slug: wanted,
      docId: doc.id,
      artboardId: artboardId ?? existing?.artboardId ?? null,
      title: doc.name,
      description: description ?? existing?.description ?? null,
      publishedBy: `agent:${ctx.connection.code}`,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    await store.savePublication(publication);
    return json({
      url: `${ctx.baseUrl}/p/${publication.slug}`,
      artboard: doc.nodes[chosen]?.name,
      live: true,
      next: 'The page follows the document. unpublish_page takes it down.',
    });
  }));

  server.registerTool('unpublish_page', {
    title: 'Take a published page down',
    description: 'Removes the public page. The address stops working immediately, for everyone.',
  }, async () => guard(async () => {
    const doc = requireDoc(ctx);
    const store = await persistence();
    const existing = await store.loadPublicationFor(doc.id);
    if (!existing) return json({ published: false, note: 'This document was not published.' });
    await store.deletePublication(existing.slug);
    return json({ published: false, wasAt: `${ctx.baseUrl}/p/${existing.slug}` });
  }));

  server.registerTool('get_publication', {
    title: 'Is this document published?',
    description: 'The public address of this document, if it has one, and which artboard it shows.',
    annotations: { readOnlyHint: true },
  }, async () => guard(async () => {
    const doc = requireDoc(ctx);
    const pub = await (await persistence()).loadPublicationFor(doc.id);
    if (!pub) return json({ published: false });
    return json({
      published: true,
      url: `${ctx.baseUrl}/p/${pub.slug}`,
      artboard: doc.nodes[pageArtboard(doc, pub.artboardId) ?? '']?.name,
      description: pub.description,
    });
  }));

  server.registerTool('find_repeated_shapes', {
    title: 'Find things built more than once',
    description:
      'Groups identical subtrees across the document: same tag, same styles, same structure, ' +
      'whatever their text. This is what "should be a component" looks like before anyone has ' +
      'named it. Pass a group id to componentise to turn one into a component.',
    inputSchema: {
      minCopies: z.number().int().min(2).max(50).optional().default(3),
      minDepth: z.number().int().min(1).max(10).optional().default(1)
        .describe('Ignore shapes with fewer than this many levels — 2 skips bare text and pills.'),
      limit: z.number().int().min(1).max(50).optional().default(12),
    },
    annotations: { readOnlyHint: true },
  }, async ({ minCopies, minDepth, limit }) => guard(() => {
    const doc = requireDoc(ctx);
    const groups = repeatedShapes(doc, { minCopies, minDepth });
    return json({
      groups: groups.slice(0, limit).map((g) => ({
        group: g.sig,
        copies: g.ids.length,
        sample: g.sample,
        name: doc.nodes[g.sample]?.name,
        text: previewText(doc, g.sample),
        alreadyComponent: g.inComponent,
      })),
      total: groups.length,
      next: 'componentise with one of these sample ids registers it and swaps every copy for an instance.',
    });
  }));

  /**
   * Register one shape as a component and swap every copy for an instance.
   *
   * Shared by `componentise` and `auto_componentise` so both rehearse the same
   * way: the plan is applied to a structuredClone and every artboard's HTML
   * compared before and after. Doing it for real and undoing it would leave a
   * half-rewritten document if anything threw in between.
   */
  function componentiseShape(context: McpContext, id: NodeId, name: string, description?: string) {
    const doc = requireDoc(context);
    const sig = shapeSignature(doc, id);
    const copies = artboardNodes(doc).filter((n) => n !== id && shapeSignature(doc, n) === sig);

    const plan = componentisePlan(doc, id, name, copies, description);
    const rehearsal = structuredClone(doc);
    for (const op of plan.ops) applyOp(rehearsal, op);

    const before = renderAll(doc);
    const after = renderAll(rehearsal);
    const moved = Object.keys(before).filter((k) => before[k] !== after[k]);
    if (moved.length) {
      throw new Error(
        `Refused: ${moved.join(', ')} would render differently, so these copies are not the same `
        + 'thing after all. Nothing was changed.',
      );
    }

    commit(context, plan.ops);
    return {
      componentId: plan.componentId,
      definitionRoot: plan.definitionRoot,
      instances: copies.length + 1,
    };
  }

  /**
   * Asking the client's model a question.
   *
   * MCP calls this sampling, and it closes the gap this server has had since
   * the day it could find repeated shapes: it can see that nine subtrees are
   * identical, and it cannot say that they are called "Reason card". The data
   * is here; the model is on the other end of the connection.
   *
   * Every caller must work without it — sampling is advertised per client, and
   * plenty do not offer it — so this returns null rather than throwing, and the
   * tools fall back to reporting what they found for the caller to name.
   */
  async function askModel(opts: { system: string; prompt: string; maxTokens?: number }): Promise<string | null> {
    if (!server.server.getClientCapabilities()?.sampling) return null;
    try {
      const result = await server.server.createMessage({
        messages: [{ role: 'user', content: { type: 'text', text: opts.prompt } }],
        systemPrompt: opts.system,
        maxTokens: opts.maxTokens ?? 900,
      });
      const content = result.content as { type?: string; text?: string } | undefined;
      return content?.type === 'text' ? (content.text ?? null) : null;
    } catch {
      // A client that advertises sampling can still refuse a particular call —
      // the user may simply have said no. That is not an error worth failing a
      // tool over; it is the fallback path.
      return null;
    }
  }

  /** Model answers arrive as JSON, sometimes wearing a code fence. */
  function parseList<T>(answer: string | null): T[] {
    if (!answer) return [];
    const body = answer.replace(/^[\s\S]*?```(?:json)?/, '').replace(/```[\s\S]*$/, '').trim() || answer.trim();
    try {
      const parsed = JSON.parse(body) as unknown;
      return Array.isArray(parsed) ? parsed as T[] : [];
    } catch {
      return [];
    }
  }

  server.registerTool('auto_componentise', {
    title: 'Name and register everything that repeats',
    description:
      'Finds the repeated shapes in the document, asks your model what each one is called, and '
      + 'registers them as components. This is the whole post-import chore in one call. Where the '
      + 'client does not offer sampling it reports the candidates instead, for you to name and pass '
      + 'to componentise yourself.',
    inputSchema: {
      minCopies: z.number().int().min(2).max(50).optional().default(3),
      limit: z.number().int().min(1).max(20).optional().default(8)
        .describe('How many to register. The most-repeated shapes come first.'),
      dryRun: z.boolean().optional().default(false).describe('Report the names it would use.'),
    },
  }, async ({ minCopies, limit, dryRun }) => guard(async () => {
    const doc = requireDoc(ctx);
    const groups = repeatedShapes(doc, { minCopies, minDepth: 2 }).slice(0, limit);
    if (!groups.length) return json({ made: [], note: 'Nothing repeats often enough to be a component yet.' });

    const described = groups.map((g) => ({
      id: g.sample,
      copies: g.ids.length,
      tag: doc.nodes[g.sample]?.tag,
      text: previewText(doc, g.sample) ?? '',
      children: (doc.nodes[g.sample]?.children ?? [])
        .map((c) => `${doc.nodes[c]?.type}:${previewText(doc, c) ?? doc.nodes[c]?.tag}`)
        .slice(0, 6),
    }));

    const answer = await askModel({
      system:
        'You name user-interface components. Answer with JSON only: an array of '
        + '{"id": string, "name": string}. Names are two or three words, in the language of the '
        + 'interface the tool is in (English unless told otherwise), describing what the thing is '
        + 'rather than what it says — "Stat", "FAQ item", "Reason card". Omit a shape you cannot '
        + 'name confidently rather than guessing.',
      prompt: `Name these repeated shapes from a design document.\n\n${JSON.stringify(described, null, 1)}`,
    });
    const names = parseList<{ id: string; name: string }>(answer);

    if (!names.length) {
      return json({
        made: [],
        candidates: described,
        note: 'Your client did not answer a sampling request, so nothing was named. '
          + 'Pick names yourself and call componentise with each id.',
      });
    }
    if (dryRun) return json({ wouldMake: names });

    const made: { name: string; instances: number }[] = [];
    const skipped: { name: string; reason: string }[] = [];
    for (const { id, name } of names) {
      if (typeof id !== 'string' || typeof name !== 'string' || !name.trim()) continue;
      /*
       * Looked up again each time, not taken from the list above: registering a
       * component rewrites every copy of it, so ids from before go stale, and a
       * shape that was third largest becomes largest once the ones above it are
       * gone.
       */
      const fresh = repeatedShapes(requireDoc(ctx), { minCopies, minDepth: 2 })
        .find((g) => g.ids.includes(id) || g.sample === id);
      if (!fresh) { skipped.push({ name, reason: 'no longer repeats — already part of another component' }); continue; }
      try {
        const result = componentiseShape(ctx, fresh.sample, name.trim());
        made.push({ name: name.trim(), instances: result.instances });
      } catch (err) {
        skipped.push({ name, reason: err instanceof Error ? err.message.slice(0, 120) : 'refused' });
      }
    }
    return json({ made, skipped, next: 'list_components, then insert_instance where you need them.' });
  }));

  server.registerTool('name_layers', {
    title: 'Give the layers real names',
    description:
      'Renames layers that are still called after their tag — "Div", "Span", "Section" — using what '
      + 'they contain. An imported or generated page is full of them, and a layer tree of two hundred '
      + 'Divs is unusable for the person who inherits it. Needs a client that offers sampling.',
    inputSchema: {
      id: z.string().describe('Rename the layers inside this node.'),
      limit: z.number().int().min(1).max(200).optional().default(60),
      dryRun: z.boolean().optional().default(false),
    },
  }, async ({ id, limit, dryRun }) => guard(async () => {
    const doc = requireDoc(ctx);
    node(doc, id);

    const generic = subtreeIdsOf(doc, id)
      .map((nodeId) => doc.nodes[nodeId]!)
      .filter((n) => n.type !== 'artboard' && isTagName(n.name, n.tag))
      .slice(0, limit);
    if (!generic.length) return json({ renamed: 0, note: 'Every layer in there already has a name.' });

    const described = generic.map((n) => ({
      id: n.id,
      tag: n.tag,
      text: previewText(doc, n.id) ?? '',
      children: n.children.length,
    }));

    const answer = await askModel({
      system:
        'You name layers in a design file. Answer with JSON only: an array of '
        + '{"id": string, "name": string}. Two or three words, describing the role of the layer — '
        + '"Hero", "Price row", "Footer links" — never the tag and never the full sentence it '
        + 'contains. Omit any you cannot name confidently.',
      prompt: `Name these layers.\n\n${JSON.stringify(described, null, 1)}`,
      maxTokens: 1600,
    });
    const names = parseList<{ id: string; name: string }>(answer)
      .filter((n) => typeof n?.id === 'string' && typeof n?.name === 'string' && n.name.trim()
        && described.some((d) => d.id === n.id));

    if (!names.length) {
      return json({
        renamed: 0,
        candidates: described,
        note: 'Your client did not answer a sampling request. Rename them with rename_nodes.',
      });
    }
    if (dryRun) return json({ wouldRename: names });

    commit(ctx, [{ t: 'rename', updates: names.map((n) => ({ id: n.id, name: n.name.trim().slice(0, 60) })) }]);
    return json({ renamed: names.length, names: names.slice(0, 20) });
  }));

  server.registerTool('componentise', {
    title: 'Turn a repeated shape into a component',
    description:
      'Registers one subtree as a component and replaces every identical copy in the document with ' +
      'an instance, carrying each copy\'s own text and attributes across as overrides. Refuses and ' +
      'changes nothing if the rendered HTML of any artboard would differ — instances are supposed ' +
      'to be invisible in the output.',
    inputSchema: {
      id: z.string().describe('A node to build the component from; every copy of it is replaced.'),
      name: z.string().min(1).max(60),
      description: z.string().max(280).optional(),
      dryRun: z.boolean().optional().default(false)
        .describe('Report what would change without changing it.'),
    },
  }, async ({ id, name, description, dryRun }) => guard(() => {
    const doc = requireDoc(ctx);
    const source = node(doc, id);
    if (source.type === 'instance') return fail(`${id} is already an instance.`);
    if (source.type === 'artboard') return fail('Artboards cannot be components.');

    if (dryRun) {
      const sig = shapeSignature(doc, id);
      const copies = artboardNodes(doc).filter((n) => n !== id && shapeSignature(doc, n) === sig);
      return json({ wouldReplace: copies.length, copies: copies.slice(0, 20), name });
    }

    try {
      const made = componentiseShape(ctx, id, name, description);
      return json({
        ...made,
        next: 'set_component_props and set_variant give it variants; get_instance shows what an instance can override.',
      });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }));

  server.registerTool('insert_instance', {
    title: 'Insert a component instance',
    description: 'Places an instance of a component. Override its contents afterwards with set_override.',
    inputSchema: {
      componentId: z.string(),
      parentId: z.string().describe('Where to put it.'),
      index: z.number().int().optional(),
      count: z.number().int().min(1).max(50).optional().default(1),
    },
  }, async ({ componentId, parentId, index, count }) => guard(() => {
    const doc = requireDoc(ctx);
    const def = doc.components?.[componentId];
    if (!def) return fail(`No component "${componentId}". Call list_components.`);
    const parent = node(doc, parentId);

    const instances = Array.from({ length: count }, () =>
      makeNode({ type: 'instance', name: def.name, componentRef: componentId }));

    commit(ctx, [{
      t: 'insert', nodes: instances, parent: parentId,
      index: index ?? parent.children.length,
    }]);
    return json({ created: instances.map((i) => i.id) });
  }));

  server.registerTool('set_override', {
    title: 'Override part of an instance',
    description:
      'Changes one instance without touching the component or its other instances. Address the part ' +
      'you want by its id in the *definition* — get_instance shows the mapping. Pass null to reset.',
    inputSchema: {
      updates: z.array(z.object({
        instanceId: z.string(),
        defId: z.string().describe('Id of the node inside the component definition.'),
        text: z.string().optional(),
        styles: StyleRecord.optional(),
        attrs: z.record(z.string(), z.string()).optional(),
        hidden: z.boolean().optional(),
        reset: z.boolean().optional().describe('Clear every override on this part.'),
      })).min(1).max(100),
    },
  }, async ({ updates }) => guard(() => {
    const doc = requireDoc(ctx);
    for (const u of updates) {
      const instance = node(doc, u.instanceId);
      if (instance.type !== 'instance') return fail(`${u.instanceId} is not a component instance.`);
      if (!doc.nodes[u.defId]) {
        return fail(`No node "${u.defId}" in the definition. Call get_instance on ${u.instanceId} to see what can be overridden.`);
      }
    }

    commit(ctx, [{
      t: 'override',
      updates: updates.map((u) => ({
        id: u.instanceId,
        defId: u.defId,
        mode: u.reset ? ('set' as const) : ('merge' as const),
        override: u.reset ? null : {
          ...(u.text !== undefined ? { text: u.text } : {}),
          ...(u.styles ? { styles: u.styles } : {}),
          ...(u.attrs ? { attrs: u.attrs } : {}),
          ...(u.hidden !== undefined ? { hidden: u.hidden } : {}),
        },
      })),
    }]);
    return json({ updated: updates.length });
  }));

  server.registerTool('get_instance', {
    title: 'Inspect a component instance',
    description:
      'What an instance renders, and which definition ids can be overridden. Call this before ' +
      'set_override — the ids you need come from the definition, not from the canvas.',
    inputSchema: { id: z.string() },
    annotations: { readOnlyHint: true },
  }, async ({ id }) => guard(() => {
    const doc = requireDoc(ctx);
    const instance = node(doc, id);
    if (instance.type !== 'instance') return fail(`${id} is not a component instance.`);

    const def = doc.components?.[instance.componentRef ?? ''];
    const expanded = expandInstance(doc, instance);
    if (!def || !expanded) return fail(`Instance ${id} points at a component that no longer exists.`);

    const parts: { defId: string; name: string; type: string; text?: string; overridden: boolean }[] = [];
    const walk = (exp: NonNullable<typeof expanded>) => {
      if (exp.defId) {
        parts.push({
          defId: exp.defId,
          name: exp.node.name,
          type: exp.node.type,
          ...(exp.node.type === 'text' ? { text: exp.node.text ?? '' } : {}),
          overridden: !!instance.overrides?.[exp.defId],
        });
      }
      for (const child of exp.children) walk(child);
    };
    walk(expanded);

    return json({
      instanceId: id,
      component: { id: def.id, name: def.name },
      props: resolvedProps(def, instance),
      availableProps: def.props ?? [],
      overridableParts: parts,
    });
  }));

  server.registerTool('set_component_props', {
    title: 'Declare a component’s variant properties',
    description:
      'Defines the properties a component varies by, e.g. size: sm|md|lg. Declare properties first, ' +
      'then use set_variant to say what each combination looks like.',
    inputSchema: {
      componentId: z.string(),
      props: z.array(z.object({
        name: z.string().min(1).max(40),
        values: z.array(z.string().min(1)).min(1).max(20),
        default: z.string().describe('Must be one of `values`.'),
      })).max(8),
    },
  }, async ({ componentId, props }) => guard(() => {
    const doc = requireDoc(ctx);
    const def = doc.components?.[componentId];
    if (!def) return fail(`No component "${componentId}".`);

    for (const p of props) {
      if (!p.values.includes(p.default)) {
        return fail(`Property "${p.name}" has default "${p.default}", which is not one of its values.`);
      }
    }

    commit(ctx, [{ t: 'component', action: 'update', component: { id: componentId, props } }]);
    return json({
      componentId,
      props,
      combinations: variantMatrix({ ...def, props }).length,
      next: 'Use set_variant for each combination you want to look different. Undefined combinations render as the base component.',
    });
  }));

  server.registerTool('set_variant', {
    title: 'Define what a variant looks like',
    description:
      'Records style or text changes for a property combination. A partial match applies broadly — ' +
      '{tone: "danger"} applies at every size — and a more specific combination refines it rather ' +
      'than replacing it.',
    inputSchema: {
      componentId: z.string(),
      match: z.record(z.string(), z.string()).describe('e.g. {"size": "lg"} or {"size": "lg", "tone": "danger"}.'),
      overrides: z.array(z.object({
        defId: z.string().describe('Node id inside the component definition.'),
        text: z.string().optional(),
        styles: StyleRecord.optional(),
        hidden: z.boolean().optional(),
      })).min(1).max(100),
    },
  }, async ({ componentId, match, overrides }) => guard(() => {
    const doc = requireDoc(ctx);
    const def = doc.components?.[componentId];
    if (!def) return fail(`No component "${componentId}".`);

    for (const [key, value] of Object.entries(match)) {
      const prop = def.props?.find((p) => p.name === key);
      if (!prop) return fail(`Component "${def.name}" has no property "${key}". Declare it with set_component_props first.`);
      if (!prop.values.includes(value)) return fail(`Property "${key}" has no value "${value}". Values: ${prop.values.join(', ')}`);
    }
    for (const o of overrides) {
      if (!doc.nodes[o.defId]) return fail(`No node "${o.defId}" in the definition. Call list_components for its structure.`);
    }

    commit(ctx, [{
      t: 'variant', componentId, match,
      overrides: Object.fromEntries(overrides.map((o) => [o.defId, {
        ...(o.text !== undefined ? { text: o.text } : {}),
        ...(o.styles ? { styles: o.styles } : {}),
        ...(o.hidden !== undefined ? { hidden: o.hidden } : {}),
      }])),
    }]);
    return json({ componentId, match, overridden: overrides.length });
  }));

  server.registerTool('set_instance_props', {
    title: 'Set an instance’s variant properties',
    description: 'Switches instances between variants, e.g. making one button large and another danger-toned.',
    inputSchema: {
      updates: z.array(z.object({
        instanceId: z.string(),
        props: z.record(z.string(), z.string()),
      })).min(1).max(200),
    },
  }, async ({ updates }) => guard(() => {
    const doc = requireDoc(ctx);
    for (const u of updates) {
      const instance = node(doc, u.instanceId);
      if (instance.type !== 'instance') return fail(`${u.instanceId} is not a component instance.`);
      const def = doc.components?.[instance.componentRef ?? ''];
      for (const [key, value] of Object.entries(u.props)) {
        const prop = def?.props?.find((p) => p.name === key);
        if (!prop) return fail(`"${def?.name ?? 'That component'}" has no property "${key}".`);
        if (!prop.values.includes(value)) return fail(`Property "${key}" has no value "${value}". Values: ${prop.values.join(', ')}`);
      }
    }
    commit(ctx, [{ t: 'props', updates: updates.map((u) => ({ id: u.instanceId, props: u.props })) }]);
    return json({ updated: updates.length });
  }));

  server.registerTool('detach_instance', {
    title: 'Detach an instance',
    description:
      'Converts an instance into ordinary layers, baking in its overrides. Use it when one instance ' +
      'needs to diverge further than overrides allow.',
    inputSchema: { id: z.string() },
  }, async ({ id }) => guard(() => {
    const doc = requireDoc(ctx);
    const instance = node(doc, id);
    if (instance.type !== 'instance') return fail(`${id} is not a component instance.`);
    if (!instance.parent) return fail(`${id} has no parent.`);

    const nodes = detachedNodes(doc, instance, () => newId());
    if (!nodes.length) return fail(`Could not expand ${id}.`);
    const root = nodes.find((n) => n.parent === instance.parent)!;
    const index = doc.nodes[instance.parent]!.children.indexOf(id);

    commit(ctx, [
      { t: 'remove', ids: [id] },
      { t: 'insert', nodes, parent: instance.parent, index },
    ]);
    return json({ detached: id, newRoot: root.id, nodeCount: nodes.length });
  }));
}


// ---------------------------------------------------------------------------
// Code components
// ---------------------------------------------------------------------------

const CodePropSchema = z.object({
  name: z.string(),
  type: z.enum(['string', 'number', 'boolean', 'enum']).default('string'),
  values: z.array(z.string()).optional().describe('Allowed values, for type "enum".'),
  default: z.string().optional(),
  required: z.boolean().optional(),
  description: z.string().optional(),
});

function registerCodeComponentTools(server: McpServer, ctx: McpContext): void {
  server.registerTool('get_code_component_guide', {
    title: 'How to put a real component on the canvas',
    description:
      'Read this before register_code_component. Explains the bundle contract and how to build one.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => guard(() => text(
    `Code components render the project's real React components on the canvas, with their real ` +
    `props. What the designer sees is the component that ships.\n\n` +
    `Playground runs in a browser and cannot read or build a repository — you do that part.\n\n` +
    `1. Bundle the component to a single self-contained ES module, with React bundled in ` +
    `(esbuild: --bundle --format=esm --loader:.tsx=tsx). The module must export:\n\n` +
    MOUNT_CONTRACT + `\n\n` +
    `2. Call register_code_component with that JavaScript as "bundle", plus the import path the ` +
    `project really uses and the props the component accepts. Declare props honestly: they become ` +
    `the controls the designer gets, and anything undeclared is ignored.\n\n` +
    `3. Call add_code_instance to place it.\n\n` +
    `The bundle runs in a sandboxed iframe with an opaque origin: no access to the document, the ` +
    `page, cookies or storage. Network requests still work, so do not bundle anything you would ` +
    `not run in a preview. Styles must come with the bundle — the artboard's stylesheet and CSS ` +
    `variables do not cross into the sandbox, so inline the component's CSS or pass tokens as props.\n\n` +
    `On export, a code node emits "<Button variant=\"primary\" />" with a real import — not a ` +
    `copy of its markup.`,
  )));

  server.registerTool('register_code_component', {
    title: 'Register a real component',
    description:
      'Uploads a bundled component so it can be placed on the canvas. Call get_code_component_guide first for the bundle contract.',
    inputSchema: {
      name: z.string().describe('Component name as the code spells it, e.g. "Button".'),
      importPath: z.string().describe('How the project imports it, e.g. "@/components/Button".'),
      bundle: z.string().describe('The bundled ES module source, exporting mount(element, props).'),
      exportName: z.string().optional().describe('Named export, or "default" (the default).'),
      sourcePath: z.string().optional().describe('Source file, shown to the human.'),
      props: z.array(CodePropSchema).optional(),
      replace: z.boolean().optional().describe('Update the existing component with this name instead of failing.'),
    },
    annotations: { destructiveHint: false },
  }, async ({ name, importPath, bundle, exportName, sourcePath, props, replace }) => guard(async () => {
    const doc = requireDoc(ctx);
    const existing = codeComponentsOf(doc).find((c) => c.name === name);
    if (existing && !replace) {
      return fail(
        `A code component named "${name}" is already registered (${existing.id}). ` +
        `Pass replace: true to update it — every instance on the canvas picks up the new bundle.`,
      );
    }
    // Minified output exports as `export{a as mount}` — no space, aliased — so
    // the check has to look for the exported *name*, not the declaration.
    if (!/\bexport\s*(?:function\s+mount\b|\{[^}]*\bmount\b)/.test(bundle)) {
      return fail('The bundle must export a `mount(element, props)` function. See get_code_component_guide.');
    }

    const assetId = await storeAsset(doc.id, 'text/javascript', `${name}.mjs`, Buffer.from(bundle, 'utf8'));
    const declared = (props ?? []) as CodeProp[];

    if (existing) {
      commit(ctx, [{
        t: 'code-component', action: 'update',
        component: { id: existing.id, importPath, bundle: assetId, exportName: exportName ?? existing.exportName, sourcePath, props: declared },
      }]);
      return json({ id: existing.id, updated: true, instances: instancesOfCode(requireDoc(ctx), existing.id).length });
    }

    const id = newId('cc');
    commit(ctx, [{
      t: 'code-component', action: 'add',
      component: { id, name, importPath, bundle: assetId, exportName: exportName ?? 'default', sourcePath, props: declared },
    }]);
    return json({
      id, name,
      next: `Place it with add_code_instance({ componentId: "${id}", parentId: <a frame id> }).`,
    });
  }));

  server.registerTool('list_code_components', {
    title: 'List registered components',
    description: 'The project components available to place, with their props and how many instances exist.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => guard(() => {
    const doc = requireDoc(ctx);
    return json(codeComponentsOf(doc).map((c) => ({
      id: c.id, name: c.name, importPath: c.importPath, exportName: c.exportName,
      sourcePath: c.sourcePath,
      props: c.props,
      instances: instancesOfCode(doc, c.id).length,
    })));
  }));

  server.registerTool('add_code_instance', {
    title: 'Place a real component',
    description: 'Adds an instance of a registered code component to the canvas.',
    inputSchema: {
      componentId: z.string().describe('Id or name from list_code_components.'),
      parentId: z.string().describe('Frame or artboard to place it in.'),
      index: z.number().int().optional(),
      props: z.record(z.string(), z.string()).optional().describe('Prop values. Numbers and booleans as strings; they are coerced to the declared type.'),
      styles: StyleRecord.optional().describe('CSS for the wrapper box (margin, width, position).'),
    },
  }, async ({ componentId, parentId, index, props, styles }) => guard(() => {
    const doc = requireDoc(ctx);
    const component = resolveCodeComponent(doc, componentId);
    const parent = node(doc, parentId);

    const unknown = Object.keys(props ?? {}).filter((k) => !component.props.some((p) => p.name === k));
    if (unknown.length) {
      return fail(
        `${component.name} does not declare ${unknown.map((u) => `"${u}"`).join(', ')}. ` +
        `Declared props: ${component.props.map((p) => p.name).join(', ') || '(none)'}. ` +
        `Re-register the component if the code really takes these.`,
      );
    }

    const instance = makeNode({
      type: 'code',
      name: component.name,
      codeRef: component.id,
      props: props ?? {},
      // A code component brings its own size; the wrapper must not impose one.
      styles: { display: 'block', ...styles },
    });
    commit(ctx, [{
      t: 'insert', nodes: [{ ...instance, parent: parent.id }], parent: parent.id,
      index: index ?? parent.children.length,
    }]);
    return json({ id: instance.id, component: component.name, props: resolvedCodeProps(component, instance) });
  }));

  server.registerTool('set_code_props', {
    title: 'Change a component instance’s props',
    description: 'Sets prop values on a placed code component. Props not mentioned keep their value.',
    inputSchema: {
      id: z.string(),
      props: z.record(z.string(), z.string()),
    },
  }, async ({ id, props }) => guard(() => {
    const doc = requireDoc(ctx);
    const target = node(doc, id);
    if (target.type !== 'code') return fail(`Node ${id} is a ${target.type}, not a code component.`);
    const component = codeComponentOf(doc, target);

    const unknown = Object.keys(props).filter((k) => !component?.props.some((p) => p.name === k));
    if (unknown.length && component) {
      return fail(`${component.name} does not declare ${unknown.join(', ')}. Declared: ${component.props.map((p) => p.name).join(', ') || '(none)'}.`);
    }

    commit(ctx, [{ t: 'props', updates: [{ id, props: { ...target.props, ...props } }] }]);
    return json({ id, props: resolvedCodeProps(component, requireDoc(ctx).nodes[id]!) });
  }));

  server.registerTool('remove_code_component', {
    title: 'Unregister a component',
    description: 'Removes a code component. Refuses while instances still exist unless told otherwise.',
    inputSchema: {
      componentId: z.string(),
      removeInstances: z.boolean().optional(),
    },
  }, async ({ componentId, removeInstances }) => guard(() => {
    const doc = requireDoc(ctx);
    const component = resolveCodeComponent(doc, componentId);
    const instances = instancesOfCode(doc, component.id);
    if (instances.length && !removeInstances) {
      return fail(
        `${component.name} still has ${instances.length} instance${instances.length === 1 ? '' : 's'} on the canvas ` +
        `(${instances.slice(0, 5).map((n) => n.id).join(', ')}). Pass removeInstances: true to delete them too.`,
      );
    }
    const ops: Op[] = [];
    if (instances.length) ops.push({ t: 'remove', ids: instances.map((n) => n.id) });
    ops.push({ t: 'code-component', action: 'remove', component: { id: component.id } });
    commit(ctx, ops);
    return json({ removed: component.name, instancesRemoved: instances.length });
  }));

  server.registerTool('get_code_usage', {
    title: 'Where a component is used',
    description: 'Every instance of a code component, with its props and the artboard it sits on.',
    inputSchema: { componentId: z.string() },
    annotations: { readOnlyHint: true },
  }, async ({ componentId }) => guard(() => {
    const doc = requireDoc(ctx);
    const component = resolveCodeComponent(doc, componentId);
    return json({
      component: component.name,
      importPath: component.importPath,
      instances: instancesOfCode(doc, component.id).map((n) => ({
        id: n.id,
        artboard: doc.nodes[artboardOf(doc, n.id) ?? '']?.name,
        props: n.props ?? {},
        jsx: codeElementJsx(component, explicitCodeProps(component, n)),
      })),
    });
  }));
}

function instancesOfCode(doc: CanvasDocument, componentId: string): CanvasNode[] {
  return Object.values(doc.nodes).filter((n) => n.type === 'code' && n.codeRef === componentId);
}

function resolveCodeComponent(doc: CanvasDocument, ref: string): CodeComponent {
  const all = codeComponentsOf(doc);
  const found = doc.codeComponents?.[ref] ?? all.find((c) => c.name === ref);
  if (!found) {
    throw new Error(
      `No code component "${ref}". Registered: ${all.map((c) => c.name).join(', ') || '(none yet)'}. ` +
      `Register one with register_code_component.`,
    );
  }
  return found;
}


// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

function registerCommentTools(server: McpServer, ctx: McpContext): void {
  // --- Handover ---------------------------------------------------------------

  server.registerTool('get_spec', {
    title: 'Get the build spec for a layer',
    description:
      'Everything a developer needs to build one layer: its measured size, its styles grouped and ' +
      'with colours and spacing resolved back to the token names they came from, what changes on ' +
      'hover and at other widths, the notes people attached, and the HTML and JSX it emits. ' +
      'Derived from the document on request, so it cannot disagree with it.',
    inputSchema: {
      id: z.string().describe('The layer. An artboard gives the spec for the whole screen.'),
      theme: z.string().optional().describe('Resolve token values in this theme. Defaults to `default`.'),
      includeCode: z.boolean().optional().default(true),
      measure: z.boolean().optional().default(true)
        .describe('Render headlessly to get real sizes. Off is faster and reports authored values only.'),
    },
    annotations: { readOnlyHint: true },
  }, async ({ id, theme, includeCode, measure }) => guard(async () => {
    const doc = requireDoc(ctx);
    node(doc, id);

    // Authored styles say `width: fit-content`, which is not a width. Measuring
    // is what makes this a spec rather than a copy of the stylesheet.
    let boxes: Record<string, { width: number; height: number; x: number; y: number }> | null = null;
    if (measure) {
      const artboard = artboardOf(doc, id) ?? id;
      boxes = await measureSubtree(doc, artboard, ctx.baseUrl).catch(() => null);
    }

    const spec = specFor(doc, id, { box: boxes?.[id], theme });
    return json({
      ...spec,
      children: spec.children.map((c) => ({ ...c, box: boxes?.[c.id] })),
      ...(includeCode ? {
        html: emitHtml(doc, id, { mode: 'inline' }).html,
        jsx: emitJsx(doc, id, { format: 'inline' }),
      } : {}),
      ...(measure && !boxes
        ? { note: 'No renderer on this server, so sizes are the authored values only.' }
        : {}),
    });
  }));

  server.registerTool('mark_checkpoint', {
    title: 'Mark a checkpoint to compare against',
    description:
      'Saves a named version of the document. The point of it is changes_since: whoever builds from ' +
      'the design now can be told exactly what moved afterwards.',
    inputSchema: { label: z.string().min(1).max(80) },
    annotations: { destructiveHint: false },
  }, async ({ label }) => guard(async () => {
    const doc = requireDoc(ctx);
    const snap = await createSnapshot(doc.id, label);
    return json({
      checkpoint: snap.id, label, rev: snap.rev,
      next: 'changes_since with this id reports everything that moved after it.',
    });
  }));

  server.registerTool('changes_since', {
    title: 'What changed since a checkpoint',
    description:
      'Every node that was added, removed or altered since a checkpoint, with the old and new value ' +
      'of each property — plus token, component and page changes. This is the handover question: ' +
      'not what the design is, but what moved under the person building it.',
    inputSchema: {
      checkpoint: z.string().optional()
        .describe('A snapshot id. Defaults to the most recent checkpoint.'),
      within: z.string().optional().describe('Only changes inside this node.'),
      limit: z.number().int().min(1).max(200).optional().default(40),
    },
    annotations: { readOnlyHint: true },
  }, async ({ checkpoint, within, limit }) => guard(async () => {
    const doc = requireDoc(ctx);
    const snapshots = await listSnapshots(doc.id);
    if (!snapshots.length) {
      return fail('This document has no checkpoints yet. mark_checkpoint makes one.');
    }
    const chosen = checkpoint
      ? snapshots.find((s) => s.id === checkpoint)
      // Most recent first from the store, so the newest checkpoint is [0].
      : snapshots[0];
    if (!chosen) {
      return fail(`No checkpoint "${checkpoint}". Available: ${snapshots.slice(0, 5).map((s) => `${s.id} (${s.label ?? 'unlabelled'})`).join(', ')}`);
    }
    const snapshot = await getSnapshot(doc.id, chosen.id);
    if (!snapshot) return fail(`Checkpoint ${chosen.id} could not be read.`);

    const diff = diffDocuments(snapshot.data, doc);
    const nodes = within ? changesWithin(diff, doc, within) : diff.nodes;
    return json({
      since: { id: chosen.id, label: chosen.label, at: new Date(chosen.ts).toISOString() },
      same: diff.same && nodes.length === 0,
      counts: diff.counts,
      byArtboard: diff.byArtboard,
      tokens: diff.tokens,
      components: diff.components,
      pages: diff.pages,
      nodes: nodes.slice(0, limit),
      ...(nodes.length > limit ? { more: nodes.length - limit } : {}),
    });
  }));

  server.registerTool('annotate', {
    title: 'Note something the design cannot say',
    description:
      'Attaches a typed note to a layer, for the handover spec. Use it for what CSS cannot carry — ' +
      'what happens on click, where the data comes from, what must stay true — not for measurements, ' +
      'which get_spec already reports exactly. ' +
      Object.entries(NOTE_KIND_HINTS).map(([k, v]) => `${k}: ${v}`).join(' '),
    inputSchema: {
      id: z.string().describe('The layer the note is about.'),
      kind: z.enum(NOTE_KINDS),
      text: z.string().min(1).max(2000),
    },
    annotations: { destructiveHint: false },
  }, async ({ id, kind, text }) => guard(() => {
    const doc = requireDoc(ctx);
    const target = node(doc, id);
    const pageId = doc.pages.find((p) => p.artboards.includes(artboardOf(doc, id) ?? ''))?.id
      ?? pageOf(ctx, doc).id;
    const pos = getArtboardPosition(doc.nodes[artboardOf(doc, id) ?? ''] ?? target);

    const comment = makeComment({
      pageId,
      kind,
      nodeId: id,
      // Pinned at the artboard's corner: an agent has no pointer, and a pin at
      // 0,0 of the canvas would sit in empty space miles from the thing.
      x: pos.x, y: pos.y,
      author: ctx.connection.label ?? 'Agent',
      text,
    });
    commit(ctx, [{ t: 'comment', action: 'add', comment }]);
    return json({
      id: comment.id, kind, about: { id, name: target.name },
      next: 'get_spec on this layer, or on the artboard, now includes it.',
    });
  }));

  server.registerTool('list_comments', {
    title: 'Read the feedback on this design',
    description:
      'Comment threads people have left on the design, with the layers they are about. Read these before deciding what to change — they are the actual brief.',
    inputSchema: {
      includeResolved: z.boolean().optional().default(false),
      pageId: z.string().optional(),
    },
    annotations: { readOnlyHint: true },
  }, async ({ includeResolved, pageId }) => guard(() => {
    const doc = requireDoc(ctx);
    const all = commentsOf(doc, pageId).filter((c) => includeResolved || !c.resolved);
    return json({
      open: all.filter((c) => !c.resolved).length,
      comments: all.map((c) => describeComment(doc, c)),
      ...(all.length ? {} : { hint: 'No comments yet. get_basic_info also reports queued prompt cards.' }),
    });
  }));

  server.registerTool('reply_to_comment', {
    title: 'Reply to a comment',
    description:
      'Adds a reply to a comment thread, attributed to you. Say what you changed, or ask for the detail you are missing — the reply appears on the pin, next to the thing being discussed.',
    inputSchema: {
      id: z.string().describe('Comment id from list_comments.'),
      text: z.string().min(1),
    },
  }, async ({ id, text }) => guard(() => {
    const doc = requireDoc(ctx);
    const comment = (doc.comments ?? []).find((c) => c.id === id);
    if (!comment) return fail(`No comment "${id}". Call list_comments for current ids.`);

    commit(ctx, [{
      t: 'comment', action: 'reply', comment: { id },
      reply: {
        id: newIdOf('r'),
        author: ctx.connection.label ?? 'Agent',
        text, kind: 'agent', createdAt: Date.now(),
      },
    }]);
    return json({ id, replies: comment.replies.length + 1 });
  }));

  server.registerTool('resolve_comment', {
    title: 'Mark a comment settled',
    description:
      'Resolves a thread once you have acted on it. Reply first saying what you did — a thread that goes quiet and then closes tells the human nothing.',
    inputSchema: {
      id: z.string(),
      resolved: z.boolean().optional().default(true),
    },
  }, async ({ id, resolved }) => guard(() => {
    const doc = requireDoc(ctx);
    const comment = (doc.comments ?? []).find((c) => c.id === id);
    if (!comment) return fail(`No comment "${id}". Call list_comments for current ids.`);
    if (resolved && comment.replies.length === 0) {
      return fail(
        `Comment "${id}" has no replies. Call reply_to_comment first to say what you did — ` +
        `resolving silently leaves the person who raised it with no idea whether it was understood.`,
      );
    }
    commit(ctx, [{ t: 'comment', action: 'update', comment: { id, resolved } }]);
    return json({ id, resolved });
  }));
}

function describeComment(doc: CanvasDocument, c: Comment) {
  const node = c.nodeId ? doc.nodes[c.nodeId] : undefined;
  return {
    id: c.id,
    author: c.author,
    text: c.text,
    resolved: c.resolved,
    createdAt: new Date(c.createdAt).toISOString(),
    // The node it was placed on, when it still exists. A comment outlives the
    // layer it criticised on purpose, so this is reported as missing rather
    // than quietly dropped.
    about: c.nodeId
      ? node
        ? { id: c.nodeId, name: node.name, type: node.type, artboard: doc.nodes[artboardOf(doc, c.nodeId) ?? '']?.name }
        : { id: c.nodeId, deleted: true }
      : { canvas: { x: c.x, y: c.y } },
    replies: c.replies.map((r) => ({
      author: r.author, kind: r.kind, text: r.text, at: new Date(r.createdAt).toISOString(),
    })),
  };
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
    void createSnapshot(doc.id, `Before: ${summary ?? ctx.connection.label ?? 'agent edit'}`).catch(() => {});
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
/**
 * Live MCP sessions, by session id.
 *
 * The transport used to be stateless: a server per request, a JSON response,
 * nothing kept. That is the right shape for a serverless host and it quietly
 * rules out half of MCP — a server can only *answer* over it. Asking the
 * client's model to name a component, asking the person whether to replace
 * fourteen of them, reporting progress through a forty-second import, pushing
 * a notification when a human edits the document: every one of those is a
 * message the server starts, and a stateless request has no channel to start
 * it on.
 *
 * So a client that initializes gets a session, and with it a stream the server
 * can speak on. Anything arriving without one still works exactly as before,
 * which is what keeps a serverless deployment — where this map cannot be
 * shared between instances — a supported way to run this.
 */
interface McpSession {
  server: ReturnType<typeof buildMcpServer>;
  transport: WebStandardStreamableHTTPServerTransport;
  /** Sessions belong to one connection code; a code is a document credential. */
  code: string;
  lastSeen: number;
}

const sessions = new Map<string, McpSession>();
const SESSION_IDLE_MS = 30 * 60_000;
const MAX_SESSIONS = 200;

function sweepSessions(): void {
  const cutoff = Date.now() - SESSION_IDLE_MS;
  for (const [id, session] of sessions) {
    if (session.lastSeen > cutoff) continue;
    sessions.delete(id);
    setTimeout(() => { void session.server.close().catch(() => {}); }, 0);
  }
  // A cap as well as a clock: a client that initializes in a loop and never
  // closes should cost memory in proportion to nothing in particular.
  while (sessions.size > MAX_SESSIONS) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
    if (!oldest) break;
    sessions.delete(oldest[0]);
    setTimeout(() => { void oldest[1].server.close().catch(() => {}); }, 0);
  }
}

/** Peeked from a clone, so the body is still there for the transport to read. */
async function isInitialize(req: Request): Promise<boolean> {
  if (req.method !== 'POST') return false;
  try {
    const body = await req.clone().json() as unknown;
    const messages = Array.isArray(body) ? body : [body];
    return messages.some((m) => (m as { method?: string })?.method === 'initialize');
  } catch {
    return false;
  }
}

export async function handleMcpRequest(req: Request, connection: Connection, baseUrl: string): Promise<Response> {
  void touchConnection(connection.code);
  sweepSessions();

  // `?tools=core,components` on the connection URL. Absent means all of them,
  // because a client that has not heard of toolsets must not lose tools.
  const asked = new URL(req.url).searchParams.get('tools');
  const toolsets = asked ? asked.split(',').map((t) => t.trim()).filter(Boolean) : undefined;

  const sessionId = req.headers.get('mcp-session-id') ?? undefined;
  const held = sessionId ? sessions.get(sessionId) : undefined;
  if (held && held.code === connection.code) {
    held.lastSeen = Date.now();
    if (req.method === 'DELETE') sessions.delete(sessionId!);
    return held.transport.handleRequest(req);
  }

  if (await isInitialize(req)) {
    const server = buildMcpServer({ connection, baseUrl, toolsets });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // Not enableJsonResponse: the stream is the point. A single JSON body
      // can carry the answer to a call and nothing else, and the server needs
      // to be able to ask something in the middle of one.
      onsessioninitialized: (id: string) => {
        sessions.set(id, { server, transport, code: connection.code, lastSeen: Date.now() });
      },
      onsessionclosed: (id: string) => { sessions.delete(id); },
    });
    await server.connect(transport);
    return transport.handleRequest(req);
  }

  /*
   * No session, and not asking for one: the original stateless path.
   *
   * A client that never initializes, one whose session has expired, and every
   * request on a host that runs each one in a different process all land here
   * and work — minus the things that need the server to speak first.
   */
  const server = buildMcpServer({ connection, baseUrl, toolsets });
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
