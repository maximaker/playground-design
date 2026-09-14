/**
 * HTML projection: document tree -> HTML/CSS, and HTML/CSS -> document tree.
 *
 * The parse direction is the primary agent write path (`write_html`), so it is
 * deliberately tolerant: anything it cannot represent becomes a frame with the
 * original styles preserved rather than being dropped.
 */

import { parse as parseHtmlDom, type HTMLElement as ParsedElement } from 'node-html-parser';
import {
  type CanvasDocument, type CanvasNode, type NodeId, type NodeType, type StyleMap,
  makeNode, newId, defaultStylesFor,
} from './model.ts';
import {
  parseDeclarations, inlineDeclarations, serializeDeclarations, parseStylesheet,
  specificity, tokenToCssVar,
} from './css.ts';

const VOID_TAGS = new Set(['img', 'br', 'hr', 'input', 'source', 'track', 'wbr', 'meta', 'link']);

const TEXTUAL_TAGS = new Set([
  'p', 'span', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'label',
  'strong', 'em', 'b', 'i', 'small', 'code', 'blockquote', 'figcaption', 'td', 'th',
]);

/** Tags we keep verbatim as containers even though they are not <div>. */
const CONTAINER_TAGS = new Set([
  'div', 'section', 'main', 'header', 'footer', 'nav', 'aside', 'article', 'ul', 'ol',
  'form', 'button', 'table', 'thead', 'tbody', 'tr', 'figure', 'video', 'canvas', 'details', 'summary',
]);

export function nodeTypeForTag(tag: string, hasElementChildren: boolean): NodeType {
  const t = tag.toLowerCase();
  if (t === 'img') return 'image';
  if (t === 'svg') return 'vector';
  if (t === 'iframe') return 'embed';
  if (TEXTUAL_TAGS.has(t) && !hasElementChildren) return 'text';
  return 'frame';
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

export interface EmitOptions {
  /**
   * `inline` puts base styles on the style attribute (variants still need a
   * stylesheet); `stylesheet` puts everything in classes.
   */
  mode?: 'inline' | 'stylesheet';
  /** Emit `:root` custom properties for the document's tokens. */
  includeTokens?: boolean;
  theme?: string;
  pretty?: boolean;
}

export interface EmitResult {
  html: string;
  css: string;
}

export function emitHtml(doc: CanvasDocument, rootId: NodeId, opts: EmitOptions = {}): EmitResult {
  const mode = opts.mode ?? 'inline';
  const pretty = opts.pretty ?? true;
  const cssBlocks: string[] = [];

  if (opts.includeTokens !== false) {
    const vars = tokenCss(doc, opts.theme ?? 'default');
    if (vars) cssBlocks.push(vars);
  }

  const emitNode = (id: NodeId, depth: number): string => {
    const node = doc.nodes[id];
    if (!node || !node.visible) return '';
    const pad = pretty ? '  '.repeat(depth) : '';
    const cls = `c-${node.id.replace(/[^a-z0-9_-]/gi, '')}`;

    const attrs: string[] = [];
    for (const [k, v] of Object.entries(node.attrs)) {
      if (k.startsWith('data-x') || k.startsWith('data-y')) continue; // canvas-space only
      attrs.push(`${k}="${escapeAttr(v)}"`);
    }

    const needsClass = node.variants.length > 0 || mode === 'stylesheet';
    if (needsClass) attrs.push(`class="${cls}"`);
    if (mode === 'inline') {
      const inline = inlineDeclarations(node.styles);
      if (inline) attrs.push(`style="${escapeAttr(inline)}"`);
    } else {
      cssBlocks.push(`.${cls} {\n${serializeDeclarations(node.styles, '  ')}\n}`);
    }
    for (const v of node.variants) {
      const body = `.${cls}${v.selector.startsWith('@') ? '' : v.selector} {\n${serializeDeclarations(v.styles, '  ')}\n}`;
      cssBlocks.push(v.selector.startsWith('@') ? `${v.selector} {\n${body}\n}` : body);
    }

    const attrStr = attrs.length ? ' ' + attrs.join(' ') : '';
    const tag = node.tag;

    if (VOID_TAGS.has(tag)) return `${pad}<${tag}${attrStr} />`;
    if (node.type === 'vector') return `${pad}<${tag}${attrStr}>${node.text ?? ''}</${tag}>`;
    if (node.type === 'text') return `${pad}<${tag}${attrStr}>${escapeText(node.text ?? '')}</${tag}>`;

    const kids = node.children.map((c) => emitNode(c, depth + 1)).filter(Boolean);
    if (kids.length === 0) return `${pad}<${tag}${attrStr}></${tag}>`;
    const sep = pretty ? '\n' : '';
    return `${pad}<${tag}${attrStr}>${sep}${kids.join(sep)}${sep}${pad}</${tag}>`;
  };

  return { html: emitNode(rootId, 0), css: cssBlocks.join('\n\n') };
}

export function tokenCss(doc: CanvasDocument, theme = 'default'): string {
  const decls = doc.tokens
    .map((t) => {
      const v = t.values[theme] ?? t.values.default;
      return v ? `  ${tokenToCssVar(t.name)}: ${v};` : '';
    })
    .filter(Boolean);
  if (!decls.length) return '';
  const sel = theme === 'default' ? ':root' : `:root[data-theme="${theme}"]`;
  return `${sel} {\n${decls.join('\n')}\n}`;
}

/** A full standalone HTML document for an artboard — used by export and preview. */
export function emitStandalone(doc: CanvasDocument, rootId: NodeId, opts: EmitOptions = {}): string {
  const { html, css } = emitHtml(doc, rootId, { ...opts, mode: opts.mode ?? 'stylesheet' });
  const themeCss = doc.themes
    .filter((t) => t !== 'default')
    .map((t) => tokenCss(doc, t))
    .filter(Boolean)
    .join('\n\n');
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeText(doc.nodes[rootId]?.name ?? doc.name)}</title>
<style>
*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; }
${css}

${themeCss}
</style>
</head>
<body>
${html}
</body>
</html>`;
}

function escapeAttr(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function escapeText(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

export interface ParseResult {
  /** All created nodes. Roots are those whose `parent` is null. */
  nodes: CanvasNode[];
  roots: NodeId[];
  /** Things we could not represent faithfully, surfaced to the user/agent. */
  warnings: string[];
}

export interface ParseOptions {
  /** Applied under the parsed rules, so authored styles win. */
  baseStyles?: StyleMap;
  /** Drop <script>; on by default and not configurable off for safety. */
  keepComments?: boolean;
}

/**
 * Parses an HTML fragment (optionally containing <style> blocks) into nodes.
 *
 * Stylesheet rules are resolved onto nodes at parse time by specificity: we do
 * not keep a live cascade, because the document model stores per-node styles.
 * Media-query and pseudo-class rules become node variants instead.
 */
export function parseHtml(html: string, opts: ParseOptions = {}): ParseResult {
  const warnings: string[] = [];
  const root = parseHtmlDom(html, {
    lowerCaseTagName: false,
    comment: opts.keepComments ?? false,
    blockTextElements: { script: false, noscript: false, style: true, pre: true },
  });

  // Collect and remove <style> blocks before walking the tree.
  const rules = [] as ReturnType<typeof parseStylesheet>;
  for (const styleEl of root.querySelectorAll('style')) {
    rules.push(...parseStylesheet(styleEl.textContent ?? ''));
    styleEl.remove();
  }
  for (const scriptEl of root.querySelectorAll('script')) {
    warnings.push('Removed a <script> element; Canvas does not execute pasted scripts.');
    scriptEl.remove();
  }

  const nodes: CanvasNode[] = [];
  const roots: NodeId[] = [];

  const walk = (el: ParsedElement, parent: NodeId | null): NodeId | null => {
    const tag = el.rawTagName?.toLowerCase();
    if (!tag) return null;

    const childEls = el.childNodes.filter(isElement);
    const hasElementChildren = childEls.length > 0;
    const type = nodeTypeForTag(tag, hasElementChildren);

    const attrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(el.attributes ?? {})) {
      if (k === 'style' || k === 'class') continue;
      attrs[k] = String(v);
    }

    const { base, variants } = resolveStyles(el, rules);
    const styles: StyleMap = { ...(parent === null ? opts.baseStyles ?? {} : {}), ...base };

    // Frames get a sane default display so pasted markup does not collapse.
    if (type === 'frame' && !styles.display && CONTAINER_TAGS.has(tag)) styles.display = 'block';

    const node = makeNode({
      id: newId(),
      type,
      tag: type === 'text' && !TEXTUAL_TAGS.has(tag) ? 'p' : tag,
      name: nameFor(el, type, tag),
      attrs,
      styles,
      variants,
      parent,
    });

    if (type === 'text') {
      node.text = decodeEntities(el.textContent ?? '').trim();
      node.children = [];
    } else if (type === 'vector') {
      node.text = el.innerHTML;
      node.children = [];
    } else {
      for (const child of el.childNodes) {
        if (isElement(child)) {
          const cid = walk(child as ParsedElement, node.id);
          if (cid) node.children.push(cid);
        } else {
          const raw = decodeEntities(String(child.rawText ?? '')).trim();
          if (raw) {
            // A bare text run inside a container becomes its own text node so it
            // remains selectable and stylable on the canvas.
            const t = makeNode({
              type: 'text', id: newId(), tag: 'span', name: truncate(raw, 24),
              styles: { ...defaultStylesFor('text') }, parent: node.id, text: raw,
            });
            nodes.push(t);
            node.children.push(t.id);
          }
        }
      }
    }

    nodes.push(node);
    if (parent === null) roots.push(node.id);
    return node.id;
  };

  const topLevel = root.childNodes.filter(isElement) as ParsedElement[];
  if (topLevel.length === 0) {
    const text = decodeEntities(root.textContent ?? '').trim();
    if (text) {
      const t = makeNode({ type: 'text', id: newId(), tag: 'p', name: truncate(text, 24), text, parent: null });
      nodes.push(t);
      roots.push(t.id);
    } else {
      warnings.push('No elements found in the provided HTML.');
    }
  } else {
    for (const el of topLevel) walk(el, null);
  }

  return { nodes, roots, warnings };
}

function isElement(n: unknown): n is ParsedElement {
  return !!n && (n as { nodeType?: number }).nodeType === 1;
}

function resolveStyles(
  el: ParsedElement,
  rules: ReturnType<typeof parseStylesheet>,
): { base: StyleMap; variants: { selector: string; styles: StyleMap }[] } {
  const base: StyleMap = {};
  const variantMap = new Map<string, StyleMap>();

  const matching = rules
    .map((r) => ({ rule: r, parts: r.selector.split(',').map((s) => s.trim()) }))
    .flatMap(({ rule, parts }) => parts.map((p) => ({ rule, part: p })))
    .filter(({ part }) => selectorMatches(el, part))
    .sort((a, b) => specificity(a.part) - specificity(b.part));

  for (const { rule, part } of matching) {
    const pseudo = /(:hover|:focus|:active|:focus-visible|:disabled)\s*$/.exec(part);
    const key = rule.atRule ?? (pseudo ? pseudo[1]! : null);
    if (key) {
      const target = variantMap.get(key) ?? {};
      Object.assign(target, rule.styles);
      variantMap.set(key, target);
    } else {
      Object.assign(base, rule.styles);
    }
  }

  // The style attribute is the highest-precedence source.
  Object.assign(base, parseDeclarations(el.getAttribute('style') ?? ''));

  return {
    base,
    variants: [...variantMap.entries()].map(([selector, styles]) => ({ selector, styles })),
  };
}

/**
 * Matches a *simple* selector (last compound only) against an element. We
 * intentionally ignore combinators: over-applying a descendant rule is a better
 * failure than silently dropping every style the author wrote.
 */
function selectorMatches(el: ParsedElement, selector: string): boolean {
  const last = selector.split(/[\s>+~]+/).filter(Boolean).pop();
  if (!last) return false;
  const compound = last.replace(/::?[\w-]+(\([^)]*\))?/g, '');
  if (!compound) return true;

  const tagMatch = /^[a-zA-Z][\w-]*/.exec(compound);
  if (tagMatch && tagMatch[0].toLowerCase() !== el.rawTagName?.toLowerCase()) return false;

  const classes = compound.match(/\.[\w-]+/g) ?? [];
  const elClasses = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
  for (const c of classes) if (!elClasses.includes(c.slice(1))) return false;

  const ids = compound.match(/#[\w-]+/g) ?? [];
  for (const i of ids) if (el.getAttribute('id') !== i.slice(1)) return false;

  return true;
}

function nameFor(el: ParsedElement, type: NodeType, tag: string): string {
  const aria = el.getAttribute('aria-label');
  if (aria) return truncate(aria, 32);
  if (type === 'text') return truncate(decodeEntities(el.textContent ?? '').trim() || 'Text', 28);
  if (type === 'image') return truncate(el.getAttribute('alt') || 'Image', 28);
  const cls = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)[0];
  if (cls && !/^[a-z-]+-\d+$/.test(cls)) return truncate(cls, 28);
  return tag.charAt(0).toUpperCase() + tag.slice(1);
}

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', copy: '©', reg: '®', trade: '™',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, g: string) => {
    if (g.startsWith('#x') || g.startsWith('#X')) return String.fromCodePoint(parseInt(g.slice(2), 16));
    if (g.startsWith('#')) return String.fromCodePoint(parseInt(g.slice(1), 10));
    return ENTITIES[g.toLowerCase()] ?? m;
  });
}
