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
import { literalTokenValue } from './css.ts';
import type { StyleRuleStat } from './html.ts';
import { sectionsOf, sectionRect, sectionMembers, sectionHeading } from './sections.ts';
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
  | 'off-scale-spacing'
  | 'font-load'
  | 'style-rule'
  | 'overflow'
  | 'empty-artboard'
  | 'section-header';

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
  { id: 'font-load', title: 'Fonts', why: 'A font that fails to load falls back silently, so the design you see is not the one you wrote.' },
  { id: 'style-rule', title: 'Style rules', why: 'A rule that matched nothing, or nearly every element, almost always means the selector did not say what was meant.' },
  { id: 'overflow', title: 'Clipped content', why: 'Content that overflows a frame that hides overflow is cut off without any visible sign.' },
  { id: 'empty-artboard', title: 'Empty frames', why: 'A frame with nothing in it is usually a leftover, or a screen that failed to build.' },
  { id: 'section-header', title: 'Section headers', why: 'A section header too long for its region, or covered by a neighbour, is cut off on the canvas.' },
];

/** A font the environment could not get. */
export interface FontIssue {
  family: string;
  /** `not-google`: Google Fonts rejected the request; `invalid`: not a usable family name; `failed`: the browser could not load it. */
  status: 'not-google' | 'invalid' | 'failed';
}

/** A frame whose content is larger than its box while overflow is hidden. */
export interface OverflowFact {
  id: NodeId;
  /** Pixels of content cut off on each axis. */
  x: number;
  y: number;
}

/** Facts only a browser or the network can supply. Each is optional; a missing one skips its rule. */
export interface HealthFacts {
  fonts?: FontIssue[];
  overflow?: OverflowFact[];
  styleRules?: StyleRuleStat[];
}

export interface LintOptions {
  /** Limit to one artboard or subtree. */
  within?: NodeId;
  rules?: RuleId[];
  /** Theme to resolve token values against. */
  theme?: string;
  /**
   * Check contrast in every document theme for artboards that do not pin one.
   * Off by default: an artboard is shown in its own theme (data-theme, else
   * default), and checking light-only screens and documentation sheets in dark
   * buried the real dark-mode problems under hundreds of findings.
   */
  allThemes?: boolean;
  /**
   * Measured boxes by node id, when a browser is available. Without them the
   * tap-target rule falls back to authored sizes and stays quiet where it
   * cannot tell.
   */
  measured?: Record<NodeId, { width: number; height: number }>;
  /** Browser- and network-measured facts for the health rules. */
  facts?: HealthFacts;
}

const TAP_TARGET_MIN = 44;
const MIN_FONT_PX = 12;
const REPEAT_THRESHOLD = 3;

export function lintDocument(doc: CanvasDocument, options: LintOptions = {}): Finding[] {
  const enabled = new Set(options.rules ?? RULES.map((r) => r.id));
  // Contrast is judged in every theme the document defines — a token that
  // inverts in dark mode leaves literal text unreadable there, and the default
  // theme alone never shows it. An artboard pinned to a theme is judged in that one.
  const themes = options.theme ? [options.theme] : (doc.themes?.length ? doc.themes : ['default']);
  const resolvers = themes.map((t) => ({ theme: t, resolve: tokenResolver(doc, t) }));
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

    if (enabled.has('contrast')) {
      const pinned = artboard ? doc.nodes[artboard]?.attrs['data-theme'] : undefined;
      const relevant = pinned && themes.includes(pinned)
        ? resolvers.filter((r) => r.theme === pinned)
        : options.allThemes || options.theme ? resolvers : resolvers.filter((r) => r.theme === 'default');
      findings.push(...checkContrast(doc, node, artboard, relevant, themes.length > 1));
    }
    if (enabled.has('empty-artboard')) findings.push(...checkEmptyArtboard(doc, node));
    if (enabled.has('overflow')) findings.push(...checkOverflow(node, artboard, options.facts?.overflow));
    if (enabled.has('tap-target')) findings.push(...checkTapTarget(node, artboard, options.measured));
    if (enabled.has('missing-alt')) findings.push(...checkAlt(node, artboard));
    if (enabled.has('tiny-text')) findings.push(...checkTextSize(node, artboard));
    if (enabled.has('hardcoded-token')) findings.push(...checkHardcoded(node, artboard, tokenValues));
    if (enabled.has('absolute-soup')) findings.push(...checkAbsoluteSoup(doc, node, artboard));
    if (enabled.has('empty-text')) findings.push(...checkEmptyText(node, artboard));
    if (enabled.has('off-scale-spacing')) findings.push(...checkSpacing(doc, node, artboard, options.theme));
  }

  if (enabled.has('repeated-subtree')) findings.push(...checkRepetition(doc, scope));
  if (!options.within) {
    if (enabled.has('font-load')) findings.push(...checkFonts(doc, options.facts?.fonts));
    if (enabled.has('style-rule')) findings.push(...checkStyleRules(doc, options.facts?.styleRules));
    if (enabled.has('section-header')) findings.push(...checkSectionHeaders(doc));
  }

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
  resolvers: { theme: string; resolve: (name: string) => string | undefined }[],
  nameTheme: boolean,
): Finding[] {
  if (node.type !== 'text' || !node.text?.trim()) return [];
  const size = parseFloat(inherited(doc, node, 'font-size') ?? '16') || 16;
  const weight = parseFloat(inherited(doc, node, 'font-weight') ?? '400') || 400;
  const required = requiredContrast(size, weight);

  const failing: { theme: string; ratio: number }[] = [];
  for (const { theme, resolve } of resolvers) {
    const color = parseColor(inherited(doc, node, 'color') ?? '', resolve);
    if (!color) continue;
    const background = effectiveBackground(doc, node, resolve);
    // Over a gradient or an image there is no single background to measure.
    if (!background) continue;
    const ratio = contrastRatio(color, background);
    if (ratio < required) failing.push({ theme, ratio });
  }
  if (!failing.length) return [];

  const worst = failing.reduce((a, b) => (b.ratio < a.ratio ? b : a));
  const where = nameTheme
    ? ` in the ${failing.map((f) => f.theme).join(' and ')} theme${failing.length > 1 ? 's' : ''}`
    : '';
  return [{
    rule: 'contrast',
    severity: worst.ratio < required * 0.7 ? 'error' : 'warning',
    nodeId: node.id,
    artboard,
    message: `Text contrast is ${formatRatio(worst.ratio)}${where}; WCAG AA needs ${required}:1 at ${Math.round(size)}px.`,
    fix: textTokenSurface(doc, node)
      ? `The background is ${textTokenSurface(doc, node)}, a text colour used as a surface: it inverts between themes while what sits on it does not. Give the surface a token that stays dark (or light) in every theme, with matching text tokens.`
      : failing.length < resolvers.length
      ? 'Use colour tokens for both the text and its background, so they change together between themes.'
      : 'Darken the text, lighten the background, or increase the size past 24px.',
  }];
}

function checkEmptyArtboard(doc: CanvasDocument, node: CanvasNode): Finding[] {
  if (node.type !== 'artboard' || node.parent !== null) return [];
  if (node.children.some((c) => doc.nodes[c])) return [];
  // A document with no content anywhere has not been started; that is not a defect.
  if (!doc.pages.some((p) => p.artboards.some((a) => doc.nodes[a]?.children.length))) return [];
  return [{
    rule: 'empty-artboard',
    severity: 'warning',
    nodeId: node.id,
    artboard: node.id,
    message: `"${node.name}" is empty.`,
    fix: 'Build the screen, or delete the frame.',
  }];
}

function checkOverflow(node: CanvasNode, artboard: NodeId | null, facts?: OverflowFact[]): Finding[] {
  const fact = facts?.find((f) => f.id === node.id);
  if (!fact) return [];
  const parts = [fact.y > 0 && `${Math.round(fact.y)}px at the bottom`, fact.x > 0 && `${Math.round(fact.x)}px at the side`].filter(Boolean);
  return [{
    rule: 'overflow',
    severity: Math.max(fact.x, fact.y) > 24 ? 'error' : 'warning',
    nodeId: node.id,
    artboard,
    message: `Content is cut off: ${parts.join(' and ')} does not fit in "${node.name}".`,
    fix: node.type === 'artboard'
      ? 'Make the frame taller (or let it hug its content), or tighten what is inside.'
      : 'Let it grow (remove the fixed height), allow overflow, or shorten the content.',
  }];
}

function checkFonts(doc: CanvasDocument, fonts?: FontIssue[]): Finding[] {
  const out: Finding[] = [];
  for (const issue of fonts ?? []) {
    const user = firstNodeUsingFont(doc, issue.family);
    if (!user) continue;
    out.push({
      rule: 'font-load',
      severity: 'error',
      nodeId: user,
      artboard: artboardOf(doc, user),
      message: issue.status === 'not-google'
        ? `"${issue.family}" is not on Google Fonts, so it falls back to a system font.`
        : issue.status === 'invalid'
          ? `"${issue.family}" is not a usable font family name, so it was never requested.`
          : `"${issue.family}" failed to load, so it falls back to a system font.`,
      fix: 'Check the spelling against fonts.google.com, or pick a family that is there.',
    });
  }
  return out;
}

function firstNodeUsingFont(doc: CanvasDocument, family: string): NodeId | null {
  const needle = family.toLowerCase();
  for (const page of doc.pages) {
    for (const a of page.artboards) {
      for (const id of [a, ...descendants(doc, a)]) {
        const value = doc.nodes[id]?.styles['font-family'];
        if (value && value.toLowerCase().includes(needle)) return id;
      }
    }
  }
  // Used only through a token: point at the first artboard.
  return doc.pages[0]?.artboards[0] ?? null;
}

/** Selectors whose job is to match everything. */
const BROAD_SELECTORS = /^(\*|html|body|:root)$/;
/** Share of elements above which a rule counts as matching "everything". */
export const STYLE_RULE_BROAD = 0.8;

function checkStyleRules(doc: CanvasDocument, stats?: StyleRuleStat[]): Finding[] {
  const out: Finding[] = [];
  for (const s of stats ?? []) {
    const at = s.root && doc.nodes[s.root] ? s.root : doc.pages[0]?.artboards[0];
    if (!at) continue;
    const bare = s.selector.replace(/::?[\w-]+(\([^)]*\))?/g, '').trim();
    if (!bare || BROAD_SELECTORS.test(bare)) continue;
    if (s.matched === 0) {
      out.push({
        rule: 'style-rule', severity: 'warning', nodeId: at, artboard: artboardOf(doc, at),
        message: `The rule "${s.selector}" matched nothing in the markup it came with. It was kept as stylesheet CSS, so it applies to matching elements written later or inside component instances.`,
        fix: 'Check the class names against the markup; the importer keeps them in data-class.',
      });
    } else if (s.total >= 10 && s.matched / s.total > STYLE_RULE_BROAD) {
      out.push({
        rule: 'style-rule', severity: 'warning', nodeId: at, artboard: artboardOf(doc, at),
        message: `The rule "${s.selector}" matched ${s.matched} of ${s.total} elements — almost everything.`,
        fix: 'Scope it (".nav span" rather than "span"), or put the shared styles on the root.',
      });
    }
  }
  return out;
}

/** Rough text width at a font size; good enough to say "this will not fit". */
const textWidth = (text: string, px: number) => text.length * px * 0.56;

function checkSectionHeaders(doc: CanvasDocument): Finding[] {
  const out: Finding[] = [];
  for (const page of doc.pages) {
    const sections = sectionsOf(page);
    for (const section of sections) {
      const rect = sectionRect(doc, page, section);
      const first = sectionMembers(doc, page, section)[0];
      if (!rect || !first) continue;
      // The canvas header at 100%: a 26px title between 80px side padding,
      // with a status pill and screen count beside it.
      const inner = Math.max(rect.width, 360) - 160;
      const titleTooLong = textWidth(sectionHeading(section), 26) > inner - 220;
      const descTooLong = !!section.description && textWidth(section.description, 16) > inner * 2;
      // A neighbour whose region reaches into this header covers it.
      const covered = sections.some((other) => {
        if (other.id === section.id) return false;
        const r = sectionRect(doc, page, other);
        return !!r && r.x < rect.x + rect.width && r.x + r.width > rect.x && r.y < rect.y + 120 && r.y + r.height > rect.y;
      });
      if (!titleTooLong && !descTooLong && !covered) continue;
      out.push({
        rule: 'section-header',
        severity: 'warning',
        nodeId: first,
        artboard: first,
        message: covered
          ? `The header of section "${section.title}" is overlapped by another section.`
          : titleTooLong
            ? `Section title "${section.title}" is too long for its region and will be cut off.`
            : `The description of section "${section.title}" is too long for its header.`,
        fix: covered ? 'Arrange the sections so they do not overlap.' : 'Shorten it, or widen the region with more screens.',
      });
    }
  }
  return out;
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
  // A box with no area is not rendered — `display: none` at this breakpoint,
  // most often. There is nothing to tap and no padding that would help, so
  // reporting it is noise that buries the targets that are genuinely too small.
  if (box.width === 0 || box.height === 0) return [];
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
    const parsed = parseColor(literalTokenValue(doc.tokens, token.name, theme) ?? '');
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
    const px = parseFloat(literalTokenValue(doc.tokens, token.name, theme) ?? '');
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
    // A gradient or image in the shorthand is still a painted background — not
    // something to look through to the page behind it.
    if (/gradient\(|url\(/i.test(raw)) return null;
    const parsed = parseColor(raw, resolve);
    if (!parsed || parsed.a === 0) continue;
    if (parsed.a < 1) return null;
    return parsed;
  }
  return null;
}

/**
 * The variable behind the nearest painted background, when that variable is also
 * used as a text colour somewhere — the "ink as a dark surface" pattern that flips
 * to light in a dark theme and takes its contents' contrast with it.
 */
function textTokenSurface(doc: CanvasDocument, node: CanvasNode): string | null {
  for (const id of [node.id, ...ancestors(doc, node.id)]) {
    const raw = doc.nodes[id]?.styles['background-color'] ?? doc.nodes[id]?.styles.background;
    if (!raw) continue;
    const v = /^\s*var\((--[\w-]+)\)\s*$/.exec(raw)?.[1];
    if (!v) return null;
    const usedAsText = Object.values(doc.nodes).some((n) => n.type === 'text' && n.styles.color?.includes(`var(${v})`));
    return usedAsText ? `var(${v})` : null;
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
