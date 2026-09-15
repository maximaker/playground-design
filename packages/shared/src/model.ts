/**
 * Canvas document model.
 *
 * The document is a tree of nodes that projects to HTML + CSS. Storage is JSON
 * rather than HTML because it must hold things HTML cannot carry: layer names,
 * lock/visibility state, component bindings, and token *references* (as opposed
 * to resolved values).
 */

import type { CodeComponent } from './code-components.ts';

export type NodeId = string;

export type NodeType =
  | 'artboard'
  | 'frame'
  | 'text'
  | 'image'
  | 'vector'
  | 'shape'
  | 'embed'
  | 'instance'
  /** An instance of one of the project's real components. */
  | 'code';

/** CSS declarations keyed by kebab-case property name. Values may be `var(--token)`. */
export type StyleMap = Record<string, string>;

/**
 * A conditional style block. `selector` is either a pseudo-selector applied to
 * the node itself (`:hover`) or an at-rule (`@media (max-width: 768px)`).
 */
export interface StyleVariant {
  selector: string;
  styles: StyleMap;
}

export interface CanvasNode {
  id: NodeId;
  type: NodeType;
  /** Layer name shown in the tree. Derived on create, renameable. */
  name: string;
  /** The real HTML tag this node renders as. */
  tag: string;
  attrs: Record<string, string>;
  styles: StyleMap;
  variants: StyleVariant[];
  /** Text content. Only meaningful for `text` nodes (which have no children). */
  text?: string;
  children: NodeId[];
  parent: NodeId | null;
  locked: boolean;
  visible: boolean;
  /** For `instance` nodes: the id of the component definition. */
  componentRef?: string;
  /** For `code` nodes: the id of the code component. */
  codeRef?: string;
  /**
   * For `instance` nodes: the variant properties this instance is set to,
   * e.g. `{ size: 'lg', tone: 'danger' }`. Unset properties fall back to the
   * component's declared defaults.
   */
  props?: Record<string, string>;
  /**
   * For `instance` nodes: per-definition-node changes.
   *
   * Keyed by the *definition's* node id rather than a positional path, so an
   * override survives the definition being reordered or having nodes inserted
   * above the one it targets.
   */
  overrides?: Record<NodeId, InstanceOverride>;
}

export interface InstanceOverride {
  text?: string;
  styles?: StyleMap;
  attrs?: Record<string, string>;
  hidden?: boolean;
}

/**
 * A reusable component.
 *
 * The definition's nodes live in `doc.nodes` like any others — they are simply
 * not attached to a page, so every existing op, style and selection mechanism
 * works on them unchanged.
 */
export interface ComponentDef {
  id: string;
  name: string;
  description?: string;
  /** Root node of the definition subtree. */
  root: NodeId;
  createdAt: number;
  /** Declared variant properties, e.g. size: sm | md | lg. */
  props?: ComponentProp[];
  /** Style and text changes that apply when an instance matches. */
  variants?: ComponentVariant[];
}

export interface ComponentProp {
  name: string;
  values: string[];
  /** Value used when an instance does not set this property. */
  default: string;
}

/**
 * One cell of the variant matrix.
 *
 * `match` need not name every property: a variant matching `{ tone: 'danger' }`
 * applies at every size. More specific variants are applied after less specific
 * ones, so `{ size: 'lg', tone: 'danger' }` refines rather than replaces.
 */
export interface ComponentVariant {
  id: string;
  match: Record<string, string>;
  overrides: Record<NodeId, InstanceOverride>;
}

/** A node in a definition marked `data-slot` renders the instance's children. */
export const SLOT_ATTR = 'data-slot';

/**
 * Properties some variant of this node overrides.
 *
 * These cannot stay in an inline style attribute: inline beats every stylesheet
 * rule, so a `:hover` or media-query variant could never override a property the
 * base also sets. They move into the stylesheet alongside the variant rules, and
 * the cascade resolves them the way CSS intends.
 */
export function contestedProperties(node: CanvasNode): Set<string> {
  const contested = new Set<string>();
  for (const variant of node.variants) {
    for (const prop of Object.keys(variant.styles)) contested.add(prop);
  }
  return contested;
}

export function slotNameOf(node: CanvasNode): string | null {
  const value = node.attrs[SLOT_ATTR];
  return value === undefined ? null : (value || 'default');
}

export interface Page {
  id: string;
  name: string;
  /** Root-level artboard node ids, in stacking order. */
  artboards: NodeId[];
  /** Canvas annotations. Not part of the design tree, so they never export. */
  notes?: Note[];
}

/**
 * A comment thread, pinned to the design.
 *
 * Distinct from a prompt card on purpose. A card is work you are handing to an
 * agent and it has a lifecycle — queued, running, done. A comment is something
 * a person said about the design, and what it needs is a reply and a way to
 * mark it settled.
 *
 * The pin carries its own coordinates as well as the node it is about, because
 * the node may be moved, restyled or deleted and the remark still has to be
 * findable. A comment that vanishes with the thing it criticised is worse than
 * no comment at all.
 */
export interface Comment {
  id: string;
  pageId: string;
  /** The node it concerns, when it was placed on one. */
  nodeId?: NodeId;
  /** Canvas-space pin position. */
  x: number;
  y: number;
  author: string;
  text: string;
  resolved: boolean;
  createdAt: number;
  replies: CommentReply[];
}

export interface CommentReply {
  id: string;
  author: string;
  text: string;
  /** Agents can reply too; the UI says which is which. */
  kind: 'human' | 'agent';
  createdAt: number;
}

export function makeComment(partial: Partial<Comment> & { pageId: string }): Comment {
  return {
    id: partial.id ?? newId('cm'),
    pageId: partial.pageId,
    nodeId: partial.nodeId,
    x: partial.x ?? 0,
    y: partial.y ?? 0,
    author: partial.author ?? 'Guest',
    text: partial.text ?? '',
    resolved: partial.resolved ?? false,
    createdAt: partial.createdAt ?? Date.now(),
    replies: partial.replies ?? [],
  };
}

export function commentsOf(doc: CanvasDocument, pageId?: string): Comment[] {
  return (doc.comments ?? [])
    .filter((c) => !pageId || c.pageId === pageId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * A prompt card: a sticky note on the canvas that can be handed to an agent.
 *
 * This is what turns the canvas into a workspace rather than a design file with
 * a chat box bolted on. A note sits next to the thing it is about, carries the
 * nodes it refers to, and has a lifecycle an agent can pick up and answer.
 */
export interface Note {
  id: string;
  /** Canvas-space position and size. */
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  color: NoteColor;
  /**
   * `idle` is a plain note. `queued` means a human asked for an agent to act on
   * it; an agent claims it (`running`) and finishes it (`done`).
   */
  status: NoteStatus;
  /** Nodes the note is about — an agent should read these first. */
  targets: NodeId[];
  author?: string;
  /** Set by the agent when it finishes. */
  response?: string;
  /** Label of the agent that claimed it, for the UI. */
  claimedBy?: string;
  createdAt: number;
  updatedAt: number;
}

export type NoteStatus = 'idle' | 'queued' | 'running' | 'done';
export type NoteColor = 'yellow' | 'blue' | 'green' | 'pink' | 'purple';

export const NOTE_COLORS: Record<NoteColor, { bg: string; border: string; fg: string }> = {
  yellow: { bg: '#fef3c7', border: '#fcd34d', fg: '#78350f' },
  blue: { bg: '#dbeafe', border: '#93c5fd', fg: '#1e3a8a' },
  green: { bg: '#dcfce7', border: '#86efac', fg: '#14532d' },
  pink: { bg: '#fce7f3', border: '#f9a8d4', fg: '#831843' },
  purple: { bg: '#ede9fe', border: '#c4b5fd', fg: '#4c1d95' },
};

export const DEFAULT_NOTE_SIZE = { width: 260, height: 160 };

export function makeNote(partial: Partial<Note> = {}): Note {
  const now = Date.now();
  return {
    id: partial.id ?? newId('note'),
    x: partial.x ?? 0,
    y: partial.y ?? 0,
    width: partial.width ?? DEFAULT_NOTE_SIZE.width,
    height: partial.height ?? DEFAULT_NOTE_SIZE.height,
    text: partial.text ?? '',
    color: partial.color ?? 'yellow',
    status: partial.status ?? 'idle',
    targets: partial.targets ?? [],
    author: partial.author,
    response: partial.response,
    claimedBy: partial.claimedBy,
    createdAt: partial.createdAt ?? now,
    updatedAt: partial.updatedAt ?? now,
  };
}

export function notesOf(page: Page | undefined): Note[] {
  return page?.notes ?? [];
}

/**
 * A named width the design responds at.
 *
 * Artboards are real viewports, so a breakpoint is not a metaphor here: setting
 * an artboard to a breakpoint's width makes the browser resolve that media
 * query, and what you see is what will ship.
 */
export interface Breakpoint {
  id: string;
  name: string;
  /** Applies at this width and below. */
  maxWidth: number;
}

/** Tailwind's widths, which most codebases already share. */
export const DEFAULT_BREAKPOINTS: Breakpoint[] = [
  { id: 'bp_sm', name: 'sm', maxWidth: 640 },
  { id: 'bp_md', name: 'md', maxWidth: 768 },
  { id: 'bp_lg', name: 'lg', maxWidth: 1024 },
  { id: 'bp_xl', name: 'xl', maxWidth: 1280 },
];

export function breakpointsOf(doc: CanvasDocument): Breakpoint[] {
  return [...(doc.breakpoints ?? DEFAULT_BREAKPOINTS)].sort((a, b) => a.maxWidth - b.maxWidth);
}

/** The CSS selector a breakpoint's variant is stored under. */
export function breakpointSelector(bp: Breakpoint): string {
  return `@media (max-width: ${bp.maxWidth}px)`;
}

/** Reads a max-width back out of a variant selector. */
export function maxWidthOf(selector: string): number | null {
  const m = /@media[^(]*\(\s*max-width:\s*(\d+(?:\.\d+)?)px/.exec(selector);
  return m ? parseFloat(m[1]!) : null;
}

/** The breakpoints that apply at a given artboard width, widest last. */
export function activeBreakpoints(doc: CanvasDocument, width: number): Breakpoint[] {
  return breakpointsOf(doc).filter((bp) => width <= bp.maxWidth);
}

export type TokenGroup = 'color' | 'space' | 'radius' | 'font' | 'shadow' | 'duration';

export interface Token {
  /** Dot path, e.g. `color.brand.500`. Emits as `--color-brand-500`. */
  name: string;
  group: TokenGroup;
  /** Value per theme name. Every token must define the `default` theme. */
  values: Record<string, string>;
}

export interface CanvasDocument {
  id: string;
  name: string;
  pages: Page[];
  nodes: Record<NodeId, CanvasNode>;
  tokens: Token[];
  themes: string[];
  /** Component definitions, keyed by id. */
  components?: Record<string, ComponentDef>;
  /** The project's real components, keyed by id. */
  codeComponents?: Record<string, CodeComponent>;
  /** Comment threads, across all pages. */
  comments?: Comment[];
  /**
   * The project this document is filed under, or undefined for unfiled.
   *
   * Library metadata, not design content: it is set through the REST API rather
   * than through an op, so moving a document between projects is not something
   * the canvas can undo or that gets replayed to everyone editing it.
   */
  projectId?: string;
  /** Named widths this design is authored against. */
  breakpoints?: Breakpoint[];
  /** Monotonic, bumped on every applied op. Used for reconnect/catch-up. */
  rev: number;
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function newId(prefix = 'n'): string {
  let s = '';
  for (let i = 0; i < 10; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return `${prefix}_${s}`;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_ARTBOARD_STYLES: StyleMap = {
  display: 'flex',
  'flex-direction': 'column',
  'align-items': 'stretch',
  'justify-content': 'flex-start',
  gap: '0px',
  padding: '0px',
  'background-color': '#ffffff',
  overflow: 'hidden',
};

export const DEFAULT_FRAME_STYLES: StyleMap = {
  display: 'flex',
  'flex-direction': 'column',
  'align-items': 'flex-start',
  'justify-content': 'flex-start',
  gap: '0px',
  padding: '0px',
  width: '200px',
  height: '200px',
  'background-color': 'rgba(0,0,0,0.05)',
};

export const DEFAULT_TEXT_STYLES: StyleMap = {
  'font-family': 'Inter, system-ui, sans-serif',
  'font-size': '16px',
  'font-weight': '400',
  'line-height': '1.5',
  color: '#111111',
  margin: '0px',
};

export const DEFAULT_SHAPE_STYLES: StyleMap = {
  width: '100px',
  height: '100px',
  'background-color': '#3b82f6',
  'border-radius': '0px',
};

export const DEFAULT_IMAGE_STYLES: StyleMap = {
  width: '200px',
  height: '200px',
  'object-fit': 'cover',
};

export function defaultStylesFor(type: NodeType): StyleMap {
  switch (type) {
    case 'artboard': return { ...DEFAULT_ARTBOARD_STYLES };
    case 'frame': return { ...DEFAULT_FRAME_STYLES };
    case 'text': return { ...DEFAULT_TEXT_STYLES };
    case 'shape': return { ...DEFAULT_SHAPE_STYLES };
    case 'image': return { ...DEFAULT_IMAGE_STYLES };
    default: return {};
  }
}

export function defaultTagFor(type: NodeType): string {
  switch (type) {
    case 'text': return 'p';
    case 'image': return 'img';
    case 'vector': return 'svg';
    case 'embed': return 'iframe';
    case 'code': return 'div';
    default: return 'div';
  }
}

export function makeNode(partial: Partial<CanvasNode> & { type: NodeType }): CanvasNode {
  const type = partial.type;
  return {
    id: partial.id ?? newId(),
    type,
    name: partial.name ?? defaultNameFor(type),
    tag: partial.tag ?? defaultTagFor(type),
    attrs: partial.attrs ?? {},
    styles: partial.styles ?? defaultStylesFor(type),
    variants: partial.variants ?? [],
    text: partial.text,
    children: partial.children ?? [],
    parent: partial.parent ?? null,
    locked: partial.locked ?? false,
    visible: partial.visible ?? true,
    componentRef: partial.componentRef,
    codeRef: partial.codeRef,
    ...(partial.props ? { props: partial.props } : {}),
    ...(partial.overrides ? { overrides: partial.overrides } : {}),
  };
}

function defaultNameFor(type: NodeType): string {
  const names: Record<NodeType, string> = {
    artboard: 'Artboard', frame: 'Frame', text: 'Text', image: 'Image',
    vector: 'Vector', shape: 'Rectangle', embed: 'Embed', instance: 'Instance',
    code: 'Component',
  };
  return names[type];
}

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

export function getNode(doc: CanvasDocument, id: NodeId): CanvasNode | undefined {
  return doc.nodes[id];
}

/** All descendant ids of `id`, excluding `id` itself, in depth-first order. */
export function descendants(doc: CanvasDocument, id: NodeId): NodeId[] {
  const out: NodeId[] = [];
  const walk = (nid: NodeId) => {
    const n = doc.nodes[nid];
    if (!n) return;
    for (const c of n.children) { out.push(c); walk(c); }
  };
  walk(id);
  return out;
}

/** Chain of ancestor ids from the immediate parent up to the root. */
export function ancestors(doc: CanvasDocument, id: NodeId): NodeId[] {
  const out: NodeId[] = [];
  let cur = doc.nodes[id]?.parent ?? null;
  while (cur) { out.push(cur); cur = doc.nodes[cur]?.parent ?? null; }
  return out;
}

/** The artboard a node lives in, or the node itself if it is one. */
export function artboardOf(doc: CanvasDocument, id: NodeId): NodeId | null {
  const n = doc.nodes[id];
  if (!n) return null;
  if (n.type === 'artboard') return id;
  for (const a of ancestors(doc, id)) {
    if (doc.nodes[a]?.type === 'artboard') return a;
  }
  return null;
}

export function componentsOf(doc: CanvasDocument): ComponentDef[] {
  return Object.values(doc.components ?? {}).sort((a, b) => a.name.localeCompare(b.name));
}

export function componentOfInstance(doc: CanvasDocument, node: CanvasNode): ComponentDef | undefined {
  return node.componentRef ? doc.components?.[node.componentRef] : undefined;
}

/** An instance's properties, with the component's defaults filled in. */
export function resolvedProps(def: ComponentDef | undefined, instance: CanvasNode): Record<string, string> {
  const out: Record<string, string> = {};
  for (const prop of def?.props ?? []) out[prop.name] = prop.default;
  for (const [key, value] of Object.entries(instance.props ?? {})) {
    // Ignore a property the component no longer declares, or a value it no
    // longer offers — otherwise deleting a value silently breaks instances.
    const declared = def?.props?.find((p) => p.name === key);
    if (declared && declared.values.includes(value)) out[key] = value;
  }
  return out;
}

/** Every combination of the component's declared properties. */
export function variantMatrix(def: ComponentDef): Record<string, string>[] {
  const props = def.props ?? [];
  if (!props.length) return [];
  return props.reduce<Record<string, string>[]>(
    (acc, prop) => acc.flatMap((combo) => prop.values.map((v) => ({ ...combo, [prop.name]: v }))),
    [{}],
  );
}

export function variantKey(match: Record<string, string>): string {
  return Object.keys(match).sort().map((k) => `${k}=${match[k]}`).join(',');
}

/** True when `id` belongs to a component definition rather than a page. */
export function isDefinitionNode(doc: CanvasDocument, id: NodeId): boolean {
  const roots = new Set(componentsOf(doc).map((c) => c.root));
  if (roots.has(id)) return true;
  for (const ancestor of ancestors(doc, id)) if (roots.has(ancestor)) return true;
  return false;
}

export function pageOfArtboard(doc: CanvasDocument, artboardId: NodeId): Page | undefined {
  return doc.pages.find((p) => p.artboards.includes(artboardId));
}

export function isAncestorOf(doc: CanvasDocument, maybeAncestor: NodeId, id: NodeId): boolean {
  return ancestors(doc, id).includes(maybeAncestor);
}

export function nodeCount(doc: CanvasDocument): number {
  return Object.keys(doc.nodes).length;
}

// ---------------------------------------------------------------------------
// Document construction
// ---------------------------------------------------------------------------

export const DEFAULT_TOKENS: Token[] = [
  { name: 'color.bg', group: 'color', values: { default: '#ffffff', dark: '#0b0b0f' } },
  { name: 'color.fg', group: 'color', values: { default: '#111111', dark: '#f5f5f7' } },
  { name: 'color.muted', group: 'color', values: { default: '#6b7280', dark: '#9ca3af' } },
  { name: 'color.brand', group: 'color', values: { default: '#3b82f6', dark: '#60a5fa' } },
  { name: 'color.border', group: 'color', values: { default: '#e5e7eb', dark: '#27272a' } },
  { name: 'radius.sm', group: 'radius', values: { default: '6px' } },
  { name: 'radius.md', group: 'radius', values: { default: '12px' } },
  { name: 'space.sm', group: 'space', values: { default: '8px' } },
  { name: 'space.md', group: 'space', values: { default: '16px' } },
  { name: 'space.lg', group: 'space', values: { default: '32px' } },
];

export function createEmptyDocument(name = 'Untitled'): CanvasDocument {
  const artboard = makeNode({
    type: 'artboard',
    name: 'Desktop',
    styles: { ...DEFAULT_ARTBOARD_STYLES, width: '1440px', height: '900px' },
    attrs: { 'data-x': '0', 'data-y': '0' },
  });
  const page: Page = { id: newId('p'), name: 'Page 1', artboards: [artboard.id] };
  return {
    id: newId('doc'),
    name,
    pages: [page],
    nodes: { [artboard.id]: artboard },
    tokens: [...DEFAULT_TOKENS],
    themes: ['default', 'dark'],
    components: {},
    breakpoints: [...DEFAULT_BREAKPOINTS],
    rev: 0,
  };
}

// ---------------------------------------------------------------------------
// Canvas placement
//
// Artboards are positioned on the infinite canvas via `data-x`/`data-y` attrs
// rather than CSS, because their CSS box is the page viewport and must not
// carry canvas-space coordinates.
// ---------------------------------------------------------------------------

export function getArtboardPosition(node: CanvasNode): { x: number; y: number } {
  return {
    x: Number(node.attrs['data-x'] ?? 0) || 0,
    y: Number(node.attrs['data-y'] ?? 0) || 0,
  };
}

export function getArtboardSize(node: CanvasNode): { width: number; height: number } {
  return {
    width: parseFloat(node.styles.width ?? '1440') || 1440,
    height: parseFloat(node.styles.height ?? '900') || 900,
  };
}
