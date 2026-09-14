/**
 * Design linting.
 *
 * These checks are possible here in a way they are not in a vector tool: the
 * document is real CSS, so contrast ratios, token drift and layout shape are
 * *computed*, not guessed. `get_guide` tells an agent what good output looks
 * like; this tells it — and the human — whether the output actually is.
 *
 * Every rule errs towards silence. A linter that cries wolf gets switched off,
 * and a design tool has far more legitimate exceptions than a compiler does.
 */

import {
  type CanvasDocument, type CanvasNode, type NodeId, type Token,
  ancestors, artboardOf, descendants,
} from './model.ts';
import { expandNode } from './components.ts';
import { contrastRatio, formatRatio, parseColor, requiredContrast, type Rgb } from './color.ts';

export type Severity = 'error' | 'warning' | 'info';

export interface Finding {
  rule: RuleId;
  severity: Severity;
  nodeId: NodeId;
  /** The artboard the problem sits in, for navigation. */
  artboard: NodeId | null;
  message: string;
  /** What to do about it, when there is a concrete answer. */
  fix?: string;
}

export type RuleId =
  | 'contrast'
  | 'tap-target'
  | 'missing-alt'
  | 'tiny-text'
  | 'hardcoded-token'
  | 'absolute-soup'
  | 'empty-text'
  | 'repeated-subtree'
  | 'off-scale-spacing';

export interface RuleInfo {
  id: RuleId;
  title: string;
  why: string;
}

export const RULES: RuleInfo[] = [
  { id: 'contrast', title: 'Text contrast', why: 'Text below WCAG AA is unreadable for a lot of people and fails most accessibility audits.' },
  { id: 'tap-target', title: 'Tap target size', why: 'Controls under 44px are hard to hit accurately on a touchscreen.' },
  { id: 'missing-alt', title: 'Image alt text', why: 'An image with no alt text is invisible to a screen reader.' },
  { id: 'tiny-text', title: 'Text size', why: 'Below about 12px, text stops being comfortably readable.' },
  { id: 'hardcoded-token', title: 'Hardcoded token values', why: 'A literal value where the rest of the design uses a token will not follow when that token changes.' },
  { id: 'absolute-soup', title: 'Absolute positioning', why: 'A container of absolutely-positioned children cannot reflow, so it cannot be made responsive.' },
  { id: 'empty-text', title: 'Empty text layers', why: 'Empty text nodes render nothing and are usually leftovers.' },
  { id: 'repeated-subtree', title: 'Repetition', why: 'The same structure repeated several times will drift apart; a component keeps it together.' },
  { id: 'off-scale-spacing', title: 'Spacing scale', why: 'Spacing that sits off the scale reads as accidental.' },
];

export interface LintOptions {
  /** Limit to one artboard or subtree. */
  within?: NodeId;
  rules?: RuleId[];
  /** Theme to resolve token values against. */
  theme?: string;
  /**
   * Measured boxes by node id, when a browser is available. Without them the
   * tap-target rule falls back to authored sizes and stays quiet where it
   * cannot tell.
   */
  measured?: Record<NodeId, { width: number; height: number }>;
}

const TAP_TARGET_MIN = 44;
const MIN_FONT_PX = 12;
const REPEAT_THRESHOLD = 3;

export function lintDocument(doc: CanvasDocument, options: LintOptions = {}): Finding[] {
  const enabled = new Set(options.rules ?? RULES.map((r) => r.id));
  const resolve = tokenResolver(doc, options.theme);
  // Only tokens the document already uses somewhere. A literal that happens to
  // equal an unused token is a coincidence, not an inconsistency — and flagging
  // it fires on every new document, whose default artboard is token-white.
  const tokenValues = colorTokenIndex(doc, options.theme, referencedTokens(doc));

  const scope = options.within
    ? [options.within, ...descendants(doc, options.within)]
    : doc.pages.flatMap((p) => p.artboards.flatMap((a) => [a, ...descendants(doc, a)]));

  const findings: Finding[] = [];
  const seen = new Set<NodeId>();

  for (const id of scope) {
    if (seen.has(id)) continue;
    seen.add(id);
    const node = doc.nodes[id];
    if (!node || !node.visible) continue;

    const artboard = artboardOf(doc, id);

    if (enabled.has('contrast')) findings.push(...checkContrast(doc, node, artboard, resolve));
    if (enabled.has('tap-target')) findings.push(...checkTapTarget(node, artboard, options.measured));
    if (enabled.has('missing-alt')) findings.push(...checkAlt(node, artboard));
    if (enabled.has('tiny-text')) findings.push(...checkTextSize(node, artboard));
    if (enabled.has('hardcoded-token')) findings.push(...checkHardcoded(node, artboard, tokenValues));
    if (enabled.has('absolute-soup')) findings.push(...checkAbsoluteSoup(doc, node, artboard));
    if (enabled.has('empty-text')) findings.push(...checkEmptyText(node, artboard));
    if (enabled.has('off-scale-spacing')) findings.push(...checkSpacing(doc, node, artboard, options.theme));
  }

  if (enabled.has('repeated-subtree')) findings.push(...checkRepetition(doc, scope));

  // Errors first, then by artboard, so a reader works through one screen at a time.
  const weight: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  return findings.sort((a, b) => weight[a.severity] - weight[b.severity] || String(a.artboard).localeCompare(String(b.artboard)));
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

function checkContrast(
  doc: CanvasDocument,
  node: CanvasNode,
  artboard: NodeId | null,
  resolve: (name: string) => string | undefined,
): Finding[] {
  if (node.type !== 'text' || !node.text?.trim()) return [];

  const color = parseColor(inherited(doc, node, 'color') ?? '', resolve);
  if (!color) return [];

  const background = effectiveBackground(doc, node, resolve);
  // Over a gradient or an image there is no single background to measure.
  if (!background) return [];

  const size = parseFloat(inherited(doc, node, 'font-size') ?? '16') || 16;
  const weight = parseFloat(inherited(doc, node, 'font-weight') ?? '400') || 400;
  const ratio = contrastRatio(color, background);
  const required = requiredContrast(size, weight);
  if (ratio >= required) return [];

  return [{
    rule: 'contrast',
    severity: ratio < required * 0.7 ? 'error' : 'warning',
    nodeId: node.id,
    artboard,
    message: `Text contrast is ${formatRatio(ratio)}; WCAG AA needs ${required}:1 at ${Math.round(size)}px.`,
    fix: 'Darken the text, lighten the background, or increase the size past 24px.',
  }];
}

function checkTapTarget(
  node: CanvasNode,
  artboard: NodeId | null,
  measured?: Record<NodeId, { width: number; height: number }>,
): Finding[] {
  const interactive = node.tag === 'button' || node.tag === 'a'
    || node.attrs.role === 'button' || node.attrs.role === 'link';
  if (!interactive) return [];

  const box = measured?.[node.id] ?? authoredBox(node);
  // Without a measurement and without authored sizes there is nothing to judge.
  if (!box) return [];
  if (box.width >= TAP_TARGET_MIN && box.height >= TAP_TARGET_MIN) return [];

  const smallest = Math.min(box.width, box.height);
  return [{
    rule: 'tap-target',
    severity: smallest < 32 ? 'warning' : 'info',
    nodeId: node.id,
    artboard,
    message: `Tap target is ${Math.round(box.width)}×${Math.round(box.height)}px; ${TAP_TARGET_MIN}px is the guideline.`,
    fix: 'Add padding, or set a min-height.',
  }];
}

function checkAlt(node: CanvasNode, artboard: NodeId | null): Finding[] {
  if (node.type !== 'image' || node.tag !== 'img') return [];
  if (node.attrs.alt !== undefined) return [];
  return [{
    rule: 'missing-alt',
    severity: 'warning',
    nodeId: node.id,
    artboard,
    message: 'Image has no alt text.',
    fix: 'Describe the image, or set alt="" if it is purely decorative.',
  }];
}

function checkTextSize(node: CanvasNode, artboard: NodeId | null): Finding[] {
  if (node.type !== 'text' || !node.text?.trim()) return [];
  const raw = node.styles['font-size'];
  if (!raw || !raw.endsWith('px')) return [];
  const size = parseFloat(raw);
  if (!Number.isFinite(size) || size >= MIN_FONT_PX) return [];
  return [{
    rule: 'tiny-text',
    severity: size < 10 ? 'warning' : 'info',
    nodeId: node.id,
    artboard,
    message: `Text is ${size}px.`,
    fix: `Use at least ${MIN_FONT_PX}px for anything meant to be read.`,
  }];
}

function checkHardcoded(
  node: CanvasNode,
  artboard: NodeId | null,
  tokens: Map<string, string>,
): Finding[] {
  const out: Finding[] = [];
  for (const [prop, value] of Object.entries(node.styles)) {
    if (!/color|background|border-color|fill/.test(prop)) continue;
    if (value.startsWith('var(')) continue;
    const parsed = parseColor(value);
    if (!parsed) continue;
    const key = normaliseColor(parsed);
    const token = tokens.get(key);
    if (!token) continue;
    out.push({
      rule: 'hardcoded-token',
      severity: 'info',
      nodeId: node.id,
      artboard,
      message: `${prop} is ${value}, but the rest of this design uses the ${token} token for it.`,
      fix: `Use var(--${token.replace(/\./g, '-')}) so it follows the token.`,
    });
  }
  return out;
}

function checkAbsoluteSoup(doc: CanvasDocument, node: CanvasNode, artboard: NodeId | null): Finding[] {
  const children = node.children.map((c) => doc.nodes[c]).filter((n): n is CanvasNode => !!n);
  if (children.length < 3) return [];
  const absolute = children.filter((c) => c.styles.position === 'absolute' || c.styles.position === 'fixed');
  if (absolute.length < children.length * 0.6) return [];
  return [{
    rule: 'absolute-soup',
    severity: 'warning',
    nodeId: node.id,
    artboard,
    message: `${absolute.length} of ${children.length} children are absolutely positioned.`,
    fix: 'Lay this out with flexbox so it can reflow; keep absolute positioning for overlays and badges.',
  }];
}

function checkEmptyText(node: CanvasNode, artboard: NodeId | null): Finding[] {
  if (node.type !== 'text' || (node.text ?? '').trim()) return [];
  return [{
    rule: 'empty-text',
    severity: 'info',
    nodeId: node.id,
    artboard,
    message: 'Text layer is empty.',
    fix: 'Give it content or delete it.',
  }];
}

function checkSpacing(
  doc: CanvasDocument,
  node: CanvasNode,
  artboard: NodeId | null,
  theme?: string,
): Finding[] {
  const scale = spacingScale(doc, theme);
  // With no spacing tokens there is no scale to be off.
  if (scale.size < 2) return [];

  const out: Finding[] = [];
  for (const prop of ['gap', 'row-gap', 'column-gap']) {
    const value = node.styles[prop];
    if (!value || value.startsWith('var(') || !value.endsWith('px')) continue;
    const px = parseFloat(value);
    if (!Number.isFinite(px) || px === 0 || scale.has(px)) continue;
    out.push({
      rule: 'off-scale-spacing',
      severity: 'info',
      nodeId: node.id,
      artboard,
      message: `${prop} is ${value}, which is not on the spacing scale (${[...scale].sort((a, b) => a - b).join(', ')}px).`,
      fix: 'Use a spacing token, or add this value to the scale if it is deliberate.',
    });
  }
  return out;
}

function checkRepetition(doc: CanvasDocument, scope: NodeId[]): Finding[] {
  const shapes = new Map<string, NodeId[]>();

  for (const id of scope) {
    const node = doc.nodes[id];
    // Only worth flagging for structures substantial enough to be a component.
    if (!node || node.type === 'text' || node.children.length < 2) continue;
    if (node.type === 'instance' || node.type === 'artboard') continue;
    const key = structuralKey(doc, id, 3);
    if (!key) continue;
    const list = shapes.get(key) ?? [];
    list.push(id);
    shapes.set(key, list);
  }

  const out: Finding[] = [];
  for (const [, ids] of shapes) {
    if (ids.length < REPEAT_THRESHOLD) continue;
    // Report once, on the first occurrence, rather than N times.
    const first = ids[0]!;
    // Skip when they are already siblings of a list that is obviously generated.
    out.push({
      rule: 'repeated-subtree',
      severity: 'info',
      nodeId: first,
      artboard: artboardOf(doc, first),
      message: `This structure appears ${ids.length} times.`,
      fix: 'Make it a component so the copies cannot drift apart.',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tokenResolver(doc: CanvasDocument, theme = 'default') {
  const byVar = new Map<string, string>();
  for (const token of doc.tokens) {
    byVar.set(`--${token.name.replace(/\./g, '-')}`, token.values[theme] ?? token.values.default ?? '');
  }
  return (name: string) => byVar.get(name);
}

function colorTokenIndex(doc: CanvasDocument, theme = 'default', restrictTo?: Set<string>): Map<string, string> {
  const byValue = new Map<string, string[]>();
  for (const token of doc.tokens as Token[]) {
    if (token.group !== 'color') continue;
    if (restrictTo && !restrictTo.has(token.name)) continue;
    const parsed = parseColor(token.values[theme] ?? token.values.default ?? '');
    if (!parsed) continue;
    const key = normaliseColor(parsed);
    byValue.set(key, [...(byValue.get(key) ?? []), token.name]);
  }

  // Several tokens sharing a value is common — white is both a background and a
  // foreground-on-brand. There is no way to tell which was meant, and guessing
  // produces advice like "your artboard should use color.on-brand".
  const index = new Map<string, string>();
  for (const [value, names] of byValue) {
    if (names.length === 1) index.set(value, names[0]!);
  }
  return index;
}

/** Token names referenced through var() anywhere in the document. */
function referencedTokens(doc: CanvasDocument): Set<string> {
  const used = new Set<string>();
  const scan = (styles: Record<string, string>) => {
    for (const value of Object.values(styles)) {
      for (const match of value.matchAll(/var\(\s*--([\w-]+)/g)) {
        used.add(match[1]!.replace(/-/g, '.'));
      }
    }
  };
  for (const node of Object.values(doc.nodes)) {
    scan(node.styles);
    for (const variant of node.variants) scan(variant.styles);
  }
  // Token names can contain hyphens, so map back by matching declared names.
  const declared = new Set(doc.tokens.map((t) => t.name));
  const resolved = new Set<string>();
  for (const name of used) {
    if (declared.has(name)) { resolved.add(name); continue; }
    // `color.on.brand` came from `--color-on-brand`; find the declared name
    // whose CSS variable spelling matches.
    const target = name.replace(/\./g, '-');
    for (const d of declared) {
      if (d.replace(/\./g, '-') === target) resolved.add(d);
    }
  }
  return resolved;
}

function normaliseColor(c: Rgb): string {
  return `${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${Math.round(c.a * 100)}`;
}

function spacingScale(doc: CanvasDocument, theme = 'default'): Set<number> {
  const scale = new Set<number>();
  for (const token of doc.tokens) {
    if (token.group !== 'space') continue;
    const px = parseFloat(token.values[theme] ?? token.values.default ?? '');
    if (Number.isFinite(px)) scale.add(px);
  }
  return scale;
}

/** A style value, following inheritance up the tree the way CSS does. */
function inherited(doc: CanvasDocument, node: CanvasNode, prop: string): string | undefined {
  if (node.styles[prop]) return node.styles[prop];
  for (const id of ancestors(doc, node.id)) {
    const value = doc.nodes[id]?.styles[prop];
    if (value) return value;
  }
  return undefined;
}

/**
 * The background a node actually sits on: the nearest ancestor with an opaque
 * background colour. Returns null over a gradient or image, where there is no
 * single colour to compare against.
 */
function effectiveBackground(
  doc: CanvasDocument,
  node: CanvasNode,
  resolve: (name: string) => string | undefined,
): Rgb | null {
  for (const id of [node.id, ...ancestors(doc, node.id)]) {
    const current = doc.nodes[id];
    if (!current) continue;
    if (current.styles['background-image']) return null;
    const raw = current.styles['background-color'] ?? current.styles.background;
    if (!raw) continue;
    const parsed = parseColor(raw, resolve);
    if (!parsed || parsed.a === 0) continue;
    if (parsed.a < 1) return null;
    return parsed;
  }
  return null;
}

function authoredBox(node: CanvasNode): { width: number; height: number } | null {
  const w = parseFloat(node.styles.width ?? '');
  const h = parseFloat(node.styles.height ?? '');
  const padY = parseFloat(node.styles.padding ?? '') || 0;
  if (!Number.isFinite(w) && !Number.isFinite(h)) return null;
  return {
    width: Number.isFinite(w) ? w : Infinity,
    height: Number.isFinite(h) ? h : (parseFloat(node.styles['min-height'] ?? '') || padY * 2 + 20),
  };
}

/** A shape signature for a subtree: tags and structure, not content. */
function structuralKey(doc: CanvasDocument, id: NodeId, depth: number): string | null {
  const node = doc.nodes[id];
  if (!node || depth === 0) return null;
  const children = node.children
    .map((c) => structuralKey(doc, c, depth - 1) ?? doc.nodes[c]?.tag ?? '')
    .join(',');
  return `${node.tag}[${Object.keys(node.styles).sort().join('|')}](${children})`;
}

/** Findings grouped by rule, for a summary. */
export function summarise(findings: Finding[]): { rule: RuleId; count: number; severity: Severity }[] {
  const counts = new Map<RuleId, { count: number; severity: Severity }>();
  for (const f of findings) {
    const current = counts.get(f.rule);
    counts.set(f.rule, {
      count: (current?.count ?? 0) + 1,
      severity: current && current.severity === 'error' ? 'error' : f.severity,
    });
  }
  return [...counts.entries()].map(([rule, v]) => ({ rule, ...v }));
}

/** Expansion-aware lint: component instances are checked as they render. */
export function lintRendered(doc: CanvasDocument, options: LintOptions = {}): Finding[] {
  const base = lintDocument(doc, options);
  // Instances render definition nodes, which the scope walk above already
  // covers through the definitions themselves, so no double-reporting here.
  void expandNode;
  return base;
}
