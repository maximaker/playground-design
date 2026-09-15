/**
 * The handover spec for a node.
 *
 * Every design tool grows a redlining feature: arrows and labels a person types
 * over a picture, saying what the padding is. That exists because in those
 * tools the design is a picture — the values are not readable, so a human
 * transcribes them.
 *
 * Here the document is HTML and CSS, so a transcription would be a second copy
 * of a truth that is already exact, going stale the first time someone nudges a
 * card. This module derives the spec instead: the same numbers the renderer
 * uses, colours resolved back to the token names they came from, the variants
 * that apply at other widths and states, and the notes people attached for the
 * things CSS genuinely cannot say.
 *
 * Nothing here is stored. It is computed on request, which is what makes it
 * impossible for it to be wrong.
 */

import type { CanvasDocument, CanvasNode, NodeId, StyleMap, Token } from './model.ts';
import { getNode } from './model.ts';
import { cssVarName } from './tokens.ts';

export interface SpecValue {
  /** The value as authored, e.g. `var(--space-6)` or `32px`. */
  value: string;
  /** The token it refers to, when it refers to one. */
  token?: string;
  /** What that token resolves to in the default theme. */
  resolved?: string;
}

export interface SpecGroup {
  label: string;
  entries: { label: string; value: SpecValue }[];
}

export interface SpecVariant {
  selector: string;
  /** Plain-language rendering of the selector, for people who do not read CSS. */
  when: string;
  changes: { label: string; value: SpecValue }[];
}

export interface SpecNote {
  id: string;
  kind: string;
  text: string;
  author: string;
  resolved: boolean;
  /** Set when the note is on a descendant rather than this node. */
  on?: { id: string; name: string };
}

export interface NodeSpec {
  id: NodeId;
  name: string;
  type: string;
  tag?: string;
  text?: string;
  /** Measured box, when a renderer or a live tab supplied one. */
  box?: { width: number; height: number };
  /** The component this is an instance of, or the component it defines. */
  component?: { id: string; name: string; role: 'instance' | 'definition' };
  groups: SpecGroup[];
  variants: SpecVariant[];
  notes: SpecNote[];
  assets: string[];
  children: { id: NodeId; name: string; type: string }[];
}

/** Style properties worth a spec, grouped the way a developer reads them. */
const GROUPS: { label: string; props: string[] }[] = [
  {
    label: 'Layout',
    props: ['display', 'flex-direction', 'flex-wrap', 'align-items', 'justify-content', 'gap',
      'row-gap', 'column-gap', 'grid-template-columns', 'flex', 'position', 'inset', 'top', 'left',
      'right', 'bottom', 'z-index', 'overflow'],
  },
  {
    label: 'Size',
    props: ['width', 'height', 'min-width', 'min-height', 'max-width', 'max-height', 'aspect-ratio'],
  },
  {
    label: 'Spacing',
    props: ['padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
      'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
  },
  {
    label: 'Type',
    props: ['font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing',
      'text-transform', 'text-align', 'text-decoration', 'white-space'],
  },
  {
    label: 'Colour',
    props: ['color', 'background', 'background-color', 'background-image', 'border', 'border-color',
      'border-top', 'border-bottom', 'border-left', 'border-right', 'opacity'],
  },
  {
    label: 'Shape',
    props: ['border-radius', 'border-width', 'border-style', 'box-shadow', 'outline', 'transform',
      'transition'],
  },
];

/**
 * The token a value refers to, if any.
 *
 * Matching on `var(--name)` first, because that is a reference and not a guess.
 * A raw value that happens to equal a token's value is reported too — it is
 * almost always a hex someone pasted instead of using the token, and saying so
 * is more useful than staying quiet.
 */
export function resolveValue(value: string, tokens: readonly Token[], theme = 'default'): SpecValue {
  const ref = /var\(\s*--([\w-]+)\s*\)/.exec(value);
  if (ref) {
    const token = tokens.find((t) => cssVarName(t.name) === `--${ref[1]}`);
    if (token) {
      return { value, token: token.name, resolved: token.values[theme] ?? token.values.default };
    }
    return { value };
  }
  const literal = tokens.find((t) =>
    (t.values[theme] ?? t.values.default)?.toLowerCase() === value.trim().toLowerCase());
  return literal ? { value, token: literal.name, resolved: value } : { value };
}

/** `:hover` → "on hover", `@media (max-width: 700px)` → "up to 700px wide". */
export function describeSelector(selector: string): string {
  const media = /^@media\s*\(\s*(max|min)-width:\s*([\d.]+)(px|rem|em)\s*\)$/.exec(selector.trim());
  if (media) {
    return media[1] === 'max'
      ? `up to ${media[2]}${media[3]} wide`
      : `from ${media[2]}${media[3]} wide`;
  }
  const states: Record<string, string> = {
    ':hover': 'on hover',
    ':focus': 'when focused',
    ':focus-visible': 'when focused by keyboard',
    ':active': 'while pressed',
    ':disabled': 'when disabled',
    ':checked': 'when checked',
  };
  return states[selector.trim()] ?? selector;
}

function assetsIn(styles: StyleMap, attrs: Record<string, string>): string[] {
  const found = new Set<string>();
  for (const v of [...Object.values(styles), ...Object.values(attrs)]) {
    if (typeof v !== 'string') continue;
    for (const m of v.matchAll(/\/assets\/([\w-]+)/g)) found.add(m[1]!);
  }
  return [...found];
}

function descendants(doc: CanvasDocument, id: NodeId, out: NodeId[] = []): NodeId[] {
  out.push(id);
  for (const child of doc.nodes[id]?.children ?? []) descendants(doc, child, out);
  return out;
}

/**
 * Notes attached to a node or anything inside it.
 *
 * Descendants are included because a spec is read per screen or per component,
 * and a note on the button inside a card is part of that card's story. Where it
 * actually sits is reported, so it is never ambiguous.
 */
export function notesFor(doc: CanvasDocument, id: NodeId): SpecNote[] {
  const inside = new Set(descendants(doc, id));
  const notes: SpecNote[] = [];
  for (const comment of doc.comments ?? []) {
    if (!comment.nodeId || !inside.has(comment.nodeId)) continue;
    notes.push({
      id: comment.id,
      kind: comment.kind ?? 'comment',
      text: comment.text,
      author: comment.author,
      resolved: comment.resolved,
      ...(comment.nodeId === id
        ? {}
        : { on: { id: comment.nodeId, name: doc.nodes[comment.nodeId]?.name ?? comment.nodeId } }),
    });
  }
  // Unresolved first: an open constraint matters more than a settled one.
  return notes.sort((a, b) => Number(a.resolved) - Number(b.resolved));
}

export function specFor(
  doc: CanvasDocument,
  id: NodeId,
  opts: { box?: { width: number; height: number }; theme?: string } = {},
): NodeSpec {
  const node: CanvasNode = getNode(doc, id) ?? (() => { throw new Error(`No node ${id}`); })();
  const theme = opts.theme ?? 'default';
  const tokens = doc.tokens ?? [];

  const groups: SpecGroup[] = [];
  const seen = new Set<string>();
  for (const group of GROUPS) {
    const entries = group.props
      .filter((p) => node.styles[p] !== undefined)
      .map((p) => {
        seen.add(p);
        return { label: p, value: resolveValue(node.styles[p]!, tokens, theme) };
      });
    if (entries.length) groups.push({ label: group.label, entries });
  }
  // Anything the groups did not claim, rather than dropping it silently — a
  // spec that quietly omits a declaration is worse than an untidy one.
  const rest = Object.keys(node.styles).filter((p) => !seen.has(p)).sort();
  if (rest.length) {
    groups.push({
      label: 'Other',
      entries: rest.map((p) => ({ label: p, value: resolveValue(node.styles[p]!, tokens, theme) })),
    });
  }

  const variants: SpecVariant[] = (node.variants ?? []).map((v) => ({
    selector: v.selector,
    when: describeSelector(v.selector),
    changes: Object.entries(v.styles).map(([k, value]) => ({
      label: k, value: resolveValue(value, tokens, theme),
    })),
  }));

  const definition = Object.values(doc.components ?? {}).find((c) => c.root === id);
  const instanceOf = node.componentRef ? doc.components?.[node.componentRef] : undefined;

  return {
    id,
    name: node.name,
    type: node.type,
    tag: node.tag,
    text: node.text,
    box: opts.box,
    component: definition
      ? { id: definition.id, name: definition.name, role: 'definition' }
      : instanceOf
        ? { id: instanceOf.id, name: instanceOf.name, role: 'instance' }
        : undefined,
    groups,
    variants,
    notes: notesFor(doc, id),
    assets: assetsIn(node.styles, node.attrs ?? {}),
    children: node.children
      .map((c) => doc.nodes[c])
      .filter((c): c is CanvasNode => !!c)
      .map((c) => ({ id: c.id, name: c.name, type: c.type })),
  };
}

/**
 * The CSS for one node, as a rule you can paste.
 *
 * Not the whole stylesheet the exporter emits — a developer copying a spec
 * wants this layer's declarations and the states and widths that change them,
 * with the token references intact rather than flattened to hex. The class name
 * comes from the layer name, because that is what the person reading it calls
 * the thing.
 */
export function cssFor(doc: CanvasDocument, id: NodeId): string {
  const node = getNode(doc, id);
  if (!node) return '';
  const selector = `.${slugForClass(node.name)}`;
  const block = (styles: StyleMap, indent = '  ') => Object.entries(styles)
    .map(([k, v]) => `${indent}${k}: ${v};`)
    .join('\n');

  const parts = [`${selector} {\n${block(node.styles)}\n}`];
  for (const variant of node.variants ?? []) {
    const media = variant.selector.trim().startsWith('@media');
    parts.push(media
      ? `${variant.selector} {\n  ${selector} {\n${block(variant.styles, '    ')}\n  }\n}`
      : `${selector}${variant.selector} {\n${block(variant.styles)}\n}`);
  }
  return parts.join('\n\n');
}

function slugForClass(name: string): string {
  const slug = name.toLowerCase().replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '');
  // A class cannot start with a digit, and an empty one is not a class at all.
  return /^[a-z_-]/.test(slug) ? slug : `layer-${slug || 'unnamed'}`;
}

/** The note kinds a spec understands. `comment` is an ordinary conversation. */
export const NOTE_KINDS = ['comment', 'behaviour', 'data', 'constraint', 'accessibility', 'todo'] as const;
export type NoteKind = typeof NOTE_KINDS[number];

export const NOTE_KIND_LABELS: Record<NoteKind, string> = {
  comment: 'Comment',
  behaviour: 'Behaviour',
  data: 'Data',
  constraint: 'Constraint',
  accessibility: 'Accessibility',
  todo: 'To do',
};

/**
 * What each kind is for, shown in the picker and in the MCP tool description.
 *
 * Worth being explicit about: the whole point of typing a note is that it
 * carries what the document cannot say, and a picker with six unexplained
 * words invites people to file everything under the first one.
 */
export const NOTE_KIND_HINTS: Record<NoteKind, string> = {
  comment: 'A question or a remark. Part of a conversation, not part of the spec.',
  behaviour: 'What it does: on click, while loading, when empty, what is disabled when.',
  data: 'Where the content comes from — endpoint, field, how many, how it is sorted.',
  constraint: 'Something that must stay true, and why. "44px minimum", "must fit above the fold".',
  accessibility: 'Label, role, focus order, announcement — what a screen reader needs that the markup does not carry.',
  todo: 'Known to be unfinished. Says so before someone builds it.',
};
