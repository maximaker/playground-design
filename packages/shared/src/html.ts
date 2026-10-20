/**
 * HTML projection: document tree -> HTML/CSS, and HTML/CSS -> document tree.
 *
 * The parse direction is the primary agent write path (`write_html`), so it is
 * deliberately tolerant: anything it cannot represent becomes a frame with the
 * original styles preserved rather than being dropped.
 */

import { sanitizeMarkup } from './sanitize.ts';
import { fontFamiliesIn, googleFontsHref } from './fonts.ts';
import { TIMER_ASPECT, TIMER_ATTR, isTimer, makeTimerNode, readTimer, timerSpecFromTag, timerSvg } from './timer.ts';
import { parse as parseHtmlDom, type HTMLElement as ParsedElement } from 'node-html-parser';
import {
  type CanvasDocument, type CanvasNode, type ComponentDef, type InstanceOverride, type NodeId, type NodeType, type StyleMap,
  SLOT_ATTR, artboardTheme, contestedProperties, makeNode, newId, defaultStylesFor,
} from './model.ts';
import { type ExpandedNode, expandNode } from './components.ts';
import {
  parseDeclarations, inlineDeclarations, serializeDeclarations, parseStylesheet,
  specificity, tokenToCssVar, resolveTokenAliases,
} from './css.ts';

const VOID_TAGS = new Set(['img', 'br', 'hr', 'input', 'source', 'track', 'wbr', 'meta', 'link']);
/** Text-level tags: a sibling of these is part of a run of text, not a block. */
const INLINE_TAGS = new Set(['span', 'b', 'strong', 'i', 'em', 'a', 'u', 's', 'small', 'code', 'mark', 'sub', 'sup', 'abbr', 'kbd', 'q', 'cite', 'time', 'label', 'br']);

const TEXTUAL_TAGS = new Set([
  'p', 'span', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li',
  'strong', 'em', 'b', 'i', 'small', 'code', 'blockquote', 'figcaption',
]);

/** Tags we keep verbatim as containers even though they are not <div>. */
const CONTAINER_TAGS = new Set([
  'div', 'section', 'main', 'header', 'footer', 'nav', 'aside', 'article', 'ul', 'ol',
  'form', 'button', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'figure', 'video', 'canvas',
  'details', 'summary', 'picture', 'label', 'fieldset', 'colgroup',
]);

/**
 * The display value a tag has by default in a browser.
 *
 * Without this, forcing `display: block` on every container destroys table
 * layouts — and a great deal of the real web, especially older pages, is laid
 * out with tables. Only applied when the author set no display of their own.
 */
const DEFAULT_DISPLAY: Record<string, string> = {
  table: 'table',
  thead: 'table-header-group',
  tbody: 'table-row-group',
  tfoot: 'table-footer-group',
  tr: 'table-row',
  td: 'table-cell',
  th: 'table-cell',
  colgroup: 'table-column-group',
  col: 'table-column',
  caption: 'table-caption',
  li: 'list-item',
  button: 'inline-block',
  label: 'inline',
  picture: 'inline',
  summary: 'list-item',
};

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
  /**
   * Emit `data-node-id` on every element.
   *
   * Off by default — published pages and exports should carry no trace of the
   * editor. On, it lets a headless render be measured and mapped back to the
   * document, which is how a spec gets real sizes with no browser tab open.
   */
  includeNodeIds?: boolean;
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
    // An artboard set to a theme resolves its tokens in that theme at :root,
    // so a dark screen exports, screenshots and publishes dark.
    const vars = tokenCss(doc, opts.theme ?? artboardTheme(doc, rootId), ':root');
    if (vars) cssBlocks.push(vars);
  }

  // `flat`: inside running text, where a newline between children would render
  // as a space ("smarter ." instead of "smarter.").
  const emitNode = (expanded: ExpandedNode | null, depth: number, flat = false): string => {
    if (!expanded) return '';
    const node = expanded.node;
    const pad = pretty && !flat ? '  '.repeat(depth) : '';
    // Definition nodes share ids across instances, so class names are derived
    // from the expanded key to keep per-instance variants distinct.
    const cls = `c-${expanded.key.replace(/[^a-z0-9_-]/gi, '-')}`;

    const attrs: string[] = [];
    for (const [k, v] of Object.entries(node.attrs)) {
      if (k.startsWith('data-x') || k.startsWith('data-y')) continue; // canvas-space only
      if (k.startsWith('data-repeat')) continue; // editor-side memory of a <repeat>
      attrs.push(`${k}="${escapeAttr(v)}"`);
    }

    const needsClass = node.variants.length > 0 || mode === 'stylesheet';
    if (needsClass) attrs.push(`class="${cls}"`);
    // The definition node's id, not the expanded key: a spec is about the node
    // as it exists in the document.
    if (opts.includeNodeIds) attrs.push(`data-node-id="${escapeAttr(node.id)}"`);

    if (mode === 'inline') {
      // Properties a variant overrides move to the stylesheet: an inline style
      // beats every rule, so leaving them here would make the variants dead.
      const contested = contestedProperties(node);
      const inline = inlineDeclarations(
        contested.size
          ? Object.fromEntries(Object.entries(node.styles).filter(([prop]) => !contested.has(prop)))
          : node.styles,
      );
      if (inline) attrs.push(`style="${escapeAttr(inline)}"`);

      const base = Object.fromEntries(Object.entries(node.styles).filter(([prop]) => contested.has(prop)));
      if (Object.keys(base).length) cssBlocks.push(`.${cls} {\n${serializeDeclarations(base, '  ')}\n}`);
    } else {
      cssBlocks.push(`.${cls} {\n${serializeDeclarations(node.styles, '  ')}\n}`);
    }
    for (const v of node.variants) {
      const body = `.${cls}${v.selector.startsWith('@') ? '' : v.selector} {\n${serializeDeclarations(v.styles, '  ')}\n}`;
      cssBlocks.push(v.selector.startsWith('@') ? `${v.selector} {\n${body}\n}` : body);
    }

    const attrStr = attrs.length ? ' ' + attrs.join(' ') : '';
    const tag = node.tag;

    // A code component has no HTML of its own here — it is React, rendered in a
    // sandbox. Static HTML export leaves a marked mount point rather than
    // pretending, so the gap is visible instead of silently empty.
    if (node.type === 'code') {
      const component = doc.codeComponents?.[node.codeRef ?? ''];
      const label = component ? `${component.name} from ${component.importPath}` : node.name;
      return `${pad}<${tag}${attrStr}><!-- ${escapeText(label)}: a code component. Export as JSX to get the real element. --></${tag}>`;
    }

    if (VOID_TAGS.has(tag)) return `${pad}<${tag}${attrStr} />`;
    if (node.type === 'vector') return `${pad}<${tag}${attrStr}>${sanitizeMarkup(node.text ?? '')}</${tag}>`;
    if (node.type === 'text') return `${pad}<${tag}${attrStr}>${escapeText(node.text ?? '')}</${tag}>`;
    // A countdown's face, at full duration: export and thumbnails are static.
    if (isTimer(node)) return `${pad}<${tag}${attrStr}>${timerSvg(readTimer(node.attrs))}</${tag}>`;

    // Mixed text and inline elements are one run: no whitespace between them.
    // Also flat where whitespace is significant: under pre-wrap the indentation
    // between children rendered as blank lines.
    const run = flat || /^pre/.test(node.styles['white-space'] ?? '')
      || expanded.children.some((c) => c?.node.type === 'text' && INLINE_TAGS.has(c.node.tag));
    const kids = expanded.children.map((c) => emitNode(c, depth + 1, run)).filter(Boolean);
    if (kids.length === 0) return `${pad}<${tag}${attrStr}></${tag}>`;
    const sep = pretty && !run ? '\n' : '';
    return `${pad}<${tag}${attrStr}>${sep}${kids.join(sep)}${sep}${run ? '' : pad}</${tag}>`;
  };

  const root = doc.nodes[rootId];
  return {
    html: root ? emitNode(expandNode(doc, root), 0) : '',
    css: cssBlocks.join('\n\n'),
  };
}

export function tokenCss(doc: CanvasDocument, theme = 'default', selector?: string): string {
  const decls = doc.tokens
    .map((t) => {
      const v = t.values[theme] ?? t.values.default;
      return v ? `  ${tokenToCssVar(t.name)}: ${resolveTokenAliases(v)};` : '';
    })
    .filter(Boolean);
  if (!decls.length) return '';
  const sel = selector ?? (theme === 'default' ? ':root' : `:root[data-theme="${theme}"]`);
  return `${sel} {\n${decls.join('\n')}\n}`;
}

/** A full standalone HTML document for an artboard — used by export and preview. */
export function emitStandalone(doc: CanvasDocument, rootId: NodeId, opts: EmitOptions = {}): string {
  const { html, css } = emitHtml(doc, rootId, { ...opts, mode: opts.mode ?? 'stylesheet' });
  /*
   * The web fonts the design uses.
   *
   * Without this an exported page silently lost its typefaces and reflowed into
   * whatever the system stack is — the export looked like the design in every
   * way except the one a designer would check first.
   */
  const href = googleFontsHref(fontFamiliesIn(doc, rootId));
  const fontsLink = href ? `<link rel="stylesheet" href="${escapeAttr(href)}" />\n` : '';
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
${fontsLink}<style>
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
  /**
   * How many elements each stylesheet selector matched, out of `elements`. A
   * rule that matched nothing, or nearly everything, is almost always a
   * selector that does not say what its author meant — the health check reads
   * this rather than letting it show up later as a mystery restyle.
   */
  styleRules: StyleRuleStat[];
  elements: number;
  /** Component instances created from component tags. */
  instances?: number;
  /** `<repeat>` blocks expanded. */
  repeats?: number;
}

export interface StyleRuleStat {
  selector: string;
  matched: number;
  /** Elements parsed in the same import. */
  total: number;
  /** First root node of the import, to navigate to. */
  root?: NodeId;
}

export interface ParseOptions {
  /** Applied under the parsed rules, so authored styles win. */
  baseStyles?: StyleMap;
  /** Drop <script>; on by default and not configurable off for safety. */
  keepComments?: boolean;
  /**
   * The document's components. With them, `<Button variant="primary">Save</Button>`
   * and `<component name="Tab bar / Home" />` become real instances rather than
   * markup that only looks like one.
   */
  components?: Record<string, ComponentDef>;
  /** Definition nodes, to find a component's slots and main text. */
  defNodes?: Record<NodeId, CanvasNode>;
}

/** Marks a frame produced by `<repeat>`; holds the data it was expanded from. */
export const REPEAT_DATA_ATTR = 'data-repeat';
export const REPEAT_TEMPLATE_ATTR = 'data-repeat-template';
export const REPEAT_STYLE_ATTR = 'data-repeat-style';

const lookupPath = (item: unknown, path: string, index: number): unknown => {
  if (path === '@index') return index;
  if (path === '@number') return index + 1;
  if (path === '.' || path === 'this') return item;
  let cur: unknown = item;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(key in (cur as object))) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
};

/**
 * Fills a row template once per item. `{{field}}`, `{{a.b}}`, `{{@index}}`,
 * `{{@number}}` and `{{.}}` are replaced, HTML-escaped; a placeholder whose
 * field the item does not have is left alone, so a nested `<repeat>` keeps its own.
 */
export function expandRepeat(template: string, data: unknown[]): string {
  return data.map((item, i) => template.replace(/\{\{\s*([@\w.]+)\s*\}\}/g, (m, path: string) => {
    const v = lookupPath(item, path, i);
    if (v === undefined) return m;
    return escapeAttr(typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v));
  })).join('\n');
}

/** "Tab bar / Home", "TabBarHome" and "tab-bar-home" all name the same thing. */
export function componentKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isComponentTag(raw: string): boolean {
  // `Button` or `TabBar`, not `DIV` from shouting legacy markup.
  return /^[A-Z]/.test(raw) && raw !== raw.toUpperCase();
}

/**
 * Parses an HTML fragment (optionally containing <style> blocks) into nodes.
 *
 * Stylesheet rules are resolved onto nodes at parse time by specificity: we do
 * not keep a live cascade, because the document model stores per-node styles.
 * Media-query and pseudo-class rules become node variants instead.
 */
/**
 * Nesting the HTML parser will silently undo.
 *
 * A `<div>` inside a `<p>` is not a nesting mistake, it is a parse error: the
 * parser closes the paragraph and the div comes out as its sibling. Nothing
 * about the result says this happened — the tree simply is not the tree that
 * was written — and it cost an afternoon once: an avatar left the byline it was
 * flexed into and rendered as a 1136px square.
 *
 * Scanned as tags rather than matched with a nested regular expression, which
 * on a 40KB page is the difference between linear and quadratic.
 */
function relocations(html: string): string[] {
  const found = new Set<string>();
  let inParagraph = false;
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)\b/g)) {
    const closing = m[1] === '/';
    const tag = m[2]!.toLowerCase();
    if (tag === 'p') {
      if (closing) inParagraph = false;
      else {
        if (inParagraph) found.add('p');
        inParagraph = true;
      }
    } else if (inParagraph && tag === 'div') found.add('div');
  }
  return [...found].map((tag) =>
    `A <${tag}> inside a <p>: the HTML parser closes the paragraph first, so it became a sibling `
    + 'of the paragraph rather than a child of it. Use a <span> with display:block, or move it out.');
}

export function parseHtml(html: string, opts: ParseOptions = {}): ParseResult {
  const warnings: string[] = [];
  warnings.push(...relocations(html));
  const root = parseHtmlDom(html, {
    lowerCaseTagName: false,
    comment: opts.keepComments ?? false,
    blockTextElements: { script: false, noscript: false, style: true, pre: true },
  });

  // Collect and remove <style> blocks before walking the tree.
  const rules = [] as ReturnType<typeof parseStylesheet>;
  const styleText: string[] = [];
  for (const styleEl of root.querySelectorAll('style')) {
    styleText.push(styleEl.textContent ?? '');
    rules.push(...parseStylesheet(styleEl.textContent ?? ''));
    styleEl.remove();
  }
  for (const scriptEl of root.querySelectorAll('script')) {
    warnings.push('Removed a <script> element; Canvas does not execute pasted scripts.');
    scriptEl.remove();
  }
  // Figma's clipboard is its own binary format inside two marker spans; only
  // "Copy as SVG" gives markup a canvas can use.
  const figma = root.querySelectorAll('[data-buffer], [data-metadata]');
  if (figma.some((el) => /\(figma\)|\(figmeta\)/.test(el.getAttribute('data-buffer') ?? el.getAttribute('data-metadata') ?? ''))) {
    warnings.push('Figma copies in its own format. In Figma, use Copy as SVG (Ctrl Shift C), then paste.');
    for (const el of figma) el.remove();
  }
  // Document scaffolding is not content: <meta>, <title> and friends would
  // become layers that cannot render (a void <meta> crashed the editor).
  for (const el of root.querySelectorAll('meta, link, title, base, head, noscript, template')) el.remove();
  for (const el of root.querySelectorAll('html, body')) el.replaceWith(...el.childNodes);

  const nodes: CanvasNode[] = [];
  const roots: NodeId[] = [];
  const ruleHits = new Map<string, number>();
  for (const r of rules) for (const part of r.selector.split(',')) if (part.trim()) ruleHits.set(part.trim(), 0);
  let elements = 0;
  let instances = 0;
  let repeats = 0;

  const byKey = new Map<string, ComponentDef>();
  for (const def of Object.values(opts.components ?? {})) byKey.set(componentKey(def.name), def);
  const defNodes = opts.defNodes ?? {};

  const walkInstance = (el: ParsedElement, def: ComponentDef, parent: NodeId | null): NodeId => {
    const instance = makeNode({ type: 'instance', id: newId(), name: def.name, componentRef: def.id, parent });
    const props: Record<string, string> = {};
    const overrides: Record<NodeId, InstanceOverride> = {};
    // Definition nodes in order, for slots and for text addressed by layer name.
    const defOrder: CanvasNode[] = [];
    const collect = (id: NodeId) => {
      const n = defNodes[id];
      if (!n) return;
      defOrder.push(n);
      for (const c of n.children) collect(c);
    };
    collect(def.root);
    const textNodes = defOrder.filter((n) => n.type === 'text');
    const hasSlot = defOrder.some((n) => n.attrs[SLOT_ATTR] !== undefined);

    for (const [rawKey, value] of Object.entries(el.attributes ?? {})) {
      const key = rawKey.toLowerCase();
      if (key === 'name' && el.rawTagName.toLowerCase() === 'component') continue;
      if (key === 'id') { instance.attrs.id = String(value); continue; }
      if (key === 'style' || key === 'class') {
        warnings.push(`<${el.rawTagName}>: ${key} is ignored on a component instance; use a variant prop, or set_override afterwards.`);
        continue;
      }
      const prop = def.props?.find((p) => p.name.toLowerCase() === key);
      if (prop) {
        const v = prop.values.find((x) => x.toLowerCase() === String(value).toLowerCase());
        if (v) props[prop.name] = v;
        else warnings.push(`"${def.name}" has no ${prop.name}="${value}"; values are ${prop.values.join(', ')}. Left at "${prop.default}".`);
        continue;
      }
      // An attribute named after a text layer sets that layer: <Card title="..." />.
      const named = textNodes.find((n) => componentKey(n.name) === componentKey(key));
      if (named) { overrides[named.id] = { text: String(value) }; continue; }
      warnings.push(`"${def.name}" has no prop or text layer "${rawKey}"${def.props?.length ? ` (props: ${def.props.map((p) => p.name).join(', ')})` : ''}; ignored.`);
    }

    const kids = el.childNodes;
    const elementKids = kids.filter(isElement) as ParsedElement[];
    const inner = decodeEntities(el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (hasSlot) {
      // Children fill the definition's slots; `slot="footer"` picks a named one.
      for (const child of kids) {
        if (isElement(child)) {
          const c = child as ParsedElement;
          const slot = c.getAttribute('slot');
          if (slot) c.removeAttribute('slot');
          const cid = walk(c, instance.id);
          if (cid) {
            if (slot) { const cn = nodes.find((n) => n.id === cid); if (cn) cn.attrs['data-slot-target'] = slot; }
            instance.children.push(cid);
          }
        } else {
          const raw = decodeEntities(String(child.rawText ?? '')).replace(/\s+/g, ' ').trim();
          if (!raw) continue;
          const t = makeNode({ type: 'text', id: newId(), tag: 'span', name: truncate(raw, 24), styles: {}, parent: instance.id, text: raw });
          nodes.push(t);
          instance.children.push(t.id);
        }
      }
    } else if (elementKids.length) {
      warnings.push(`"${def.name}" has no data-slot, so the elements inside <${el.rawTagName}> were dropped; only its text was used.`);
      if (inner && textNodes[0]) overrides[textNodes[0].id] = { text: inner };
    } else if (inner) {
      const main = textNodes[0];
      if (main) overrides[main.id] = { ...overrides[main.id], text: inner };
      else warnings.push(`"${def.name}" has no text layer or slot for "${truncate(inner, 24)}"; it was dropped.`);
    }

    if (Object.keys(props).length) instance.props = props;
    if (Object.keys(overrides).length) instance.overrides = overrides;
    instances++;
    nodes.push(instance);
    if (parent === null) roots.push(instance.id);
    return instance.id;
  };

  const walkRepeat = (el: ParsedElement, parent: NodeId | null): NodeId => {
    const rawData = el.getAttribute('data') ?? '[]';
    let data: unknown[] = [];
    try {
      const parsed = JSON.parse(rawData);
      if (Array.isArray(parsed)) data = parsed;
      else warnings.push('<repeat data> must be a JSON array; nothing was repeated.');
    } catch {
      warnings.push(`<repeat data> is not valid JSON (single-quote the attribute: data='[{"a":1}]'); nothing was repeated.`);
    }
    const template = el.innerHTML;
    const { base } = resolveStyles(el, rules, ruleHits);
    const css = styleText.join('\n').trim();
    const frame = makeNode({
      type: 'frame', id: newId(), tag: 'div', parent,
      name: el.getAttribute('name') ?? 'Repeat',
      styles: { display: 'block', ...base },
      attrs: {
        [REPEAT_DATA_ATTR]: JSON.stringify(data),
        [REPEAT_TEMPLATE_ATTR]: template,
        ...(css ? { [REPEAT_STYLE_ATTR]: css } : {}),
      },
    });
    const expanded = parseHtmlDom(expandRepeat(template, data), {
      lowerCaseTagName: false, comment: false,
      blockTextElements: { script: false, noscript: false, style: true, pre: true },
    });
    for (const sc of expanded.querySelectorAll('script')) sc.remove();
    for (const child of expanded.childNodes) {
      if (!isElement(child)) continue;
      const cid = walk(child as ParsedElement, frame.id);
      if (cid) frame.children.push(cid);
    }
    repeats++;
    nodes.push(frame);
    if (parent === null) roots.push(frame.id);
    return frame.id;
  };

  // A countdown: `<timer minutes="3">` as an agent writes it, or the
  // `<div data-timer>` export emits (its SVG face is regenerated, not kept).
  const walkTimer = (el: ParsedElement, parent: NodeId | null, authored: boolean): NodeId => {
    const raw: Record<string, string> = {};
    for (const [k, v] of Object.entries(el.attributes ?? {})) raw[k] = String(v);
    let spec;
    if (authored) {
      const r = timerSpecFromTag(raw);
      warnings.push(...r.warnings);
      spec = r.spec;
    } else spec = readTimer(raw);
    const { base } = resolveStyles(el, rules, ruleHits);
    const made = makeTimerNode(spec);
    const styles: StyleMap = { 'font-family': made.styles['font-family']!, ...base };
    if (!styles.width && !styles.height) {
      const w = spec.variant === 'ring' ? 320 : spec.variant === 'pill' ? 300 : 600;
      styles.width = `${w}px`;
      styles.height = `${Math.round(w / TIMER_ASPECT[spec.variant])}px`;
    }
    const node = makeNode({
      ...made, id: newId(), parent, styles,
      name: el.getAttribute('data-name') ?? el.getAttribute('name') ?? made.name,
    });
    if (raw.id) node.attrs.id = raw.id;
    elements++;
    nodes.push(node);
    if (parent === null) roots.push(node.id);
    return node.id;
  };

  // Containers whose layout drops edge spaces (flex, grid): inline runs inside
  // them are trimmed; everywhere else a run keeps one space at each edge.
  const collapsing = new Set<NodeId>();
  const walk = (el: ParsedElement, parent: NodeId | null): NodeId | null => {
    const raw = el.rawTagName;
    let tag = raw?.toLowerCase();
    if (!tag) return null;
    if (tag === 'repeat') return walkRepeat(el, parent);
    if (tag === 'timer' || el.getAttribute(TIMER_ATTR) !== undefined) return walkTimer(el, parent, tag === 'timer');
    if (tag === 'component' || isComponentTag(raw)) {
      const name = tag === 'component' ? el.getAttribute('name') ?? '' : raw;
      const def = byKey.get(componentKey(name));
      if (def) return walkInstance(el, def, parent);
      const known = [...byKey.values()].map((d) => d.name);
      warnings.push(`No component named "${name}"${known.length ? ` (have: ${known.slice(0, 12).join(', ')})` : ''}; rendered as plain markup.`);
      el.setAttribute('data-component', name);
      tag = 'div';
    }

    const childEls = el.childNodes.filter(isElement);
    const hasElementChildren = childEls.length > 0;
    const type = nodeTypeForTag(tag, hasElementChildren);

    const attrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(el.attributes ?? {})) {
      if (k === 'style' || k === 'class' || k === 'data-name') continue;
      attrs[k] = String(v);
    }
    // The authored class list is gone once its rules are resolved into styles,
    // and with it the only record of what the element *is* ("btn primary").
    // Kept so layers can be named and matched by role later.
    const classList = (el.getAttribute('class') ?? '').trim().replace(/\s+/g, ' ');
    if (classList && !attrs['data-class']) attrs['data-class'] = classList;

    elements++;
    const { base, variants } = resolveStyles(el, rules, ruleHits);
    const styles: StyleMap = { ...(parent === null ? opts.baseStyles ?? {} : {}), ...base };

    // Give containers the display they would have in a browser, so pasted or
    // imported markup lays out the way it did on the page it came from.
    if (type === 'frame' && !styles.display) {
      const fallback = DEFAULT_DISPLAY[tag];
      if (fallback) styles.display = fallback;
      else if (CONTAINER_TAGS.has(tag)) styles.display = 'block';
    }

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
      // An inline run keeps one space at its edges: <span>pain </span><b>real</b>
      // and <span> </span> between styled words were trimmed to nothing, so
      // written text came out as "painreal" and "How tovalidate".
      const text = decodeEntities(el.textContent ?? '');
      const inline = INLINE_TAGS.has(tag) && (parent === null || !collapsing.has(parent));
      const collapsed = text.replace(/\s+/g, ' ');
      node.text = inline ? (collapsed.trim() ? collapsed : (text ? ' ' : '')) : text.trim();
      node.children = [];
    } else if (type === 'vector') {
      node.text = el.innerHTML;
      node.children = [];
      // The canvas sizes layers from CSS, so an SVG sized only by attributes
      // (as Figma's "Copy as SVG" is) collapsed to 0 high. Width/height come
      // from the attributes, else the viewBox; the box never shrinks in flex.
      const vb = (el.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
      const dim = (attr: string, fallback: number | undefined) => {
        const v = el.getAttribute(attr) ?? '';
        if (/^\d+(\.\d+)?(px)?$/.test(v)) return `${parseFloat(v)}px`;
        return fallback && Number.isFinite(fallback) ? `${fallback}px` : undefined;
      };
      const w = dim('width', vb.length === 4 ? vb[2] : undefined);
      const h = dim('height', vb.length === 4 ? vb[3] : undefined);
      if (w && !node.styles.width) node.styles.width = w;
      if (h && !node.styles.height) node.styles.height = h;
      if ((w || h) && !node.styles['flex-shrink']) node.styles['flex-shrink'] = '0';
    } else {
      const kids = el.childNodes;
      const layout = String(styles.display ?? '');
      const collapses = /flex|grid/.test(layout);
      if (collapses) collapsing.add(node.id);
      for (const [i, child] of kids.entries()) {
        if (isElement(child)) {
          const cid = walk(child as ParsedElement, node.id);
          if (cid) node.children.push(cid);
        } else {
          // Collapse whitespace like HTML does, but keep one space at an edge
          // that touches an element: "<strong>Ana</strong> Popescu" must not
          // become "AnaPopescu". In flex and grid containers CSS drops those
          // edge spaces anyway, so only plain text there is kept.
          const collapsed = decodeEntities(String(child.rawText ?? '')).replace(/\s+/g, ' ');
          const prevEl = i > 0 && isElement(kids[i - 1]!);
          const nextEl = i < kids.length - 1 && isElement(kids[i + 1]!);
          let raw = collapsed.trim();
          if (!raw && !(prevEl && nextEl && !collapses)) continue;
          if (!collapses) {
            if (prevEl && collapsed.startsWith(' ')) raw = ` ${raw}`;
            if (nextEl && collapsed.endsWith(' ') && raw !== ' ') raw = `${raw} `;
            if (!raw.trim()) raw = ' ';
          }
          if (raw) {
            // A bare text run inside a container becomes its own text node so it
            // remains selectable and stylable on the canvas — but with no styles
            // of its own. Giving it the text defaults would override the colour
            // and font it inherits in HTML, which silently changed how pasted
            // and imported markup renders (white button labels came out dark).
            const t = makeNode({
              type: 'text', id: newId(), tag: 'span', name: truncate(raw, 24),
              styles: {}, parent: node.id, text: raw,
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

  const styleRules = [...ruleHits].map(([selector, matched]) => ({ selector, matched, total: elements, root: roots[0] }));
  return { nodes, roots, warnings, styleRules, elements, instances, repeats };
}

function isElement(n: unknown): n is ParsedElement {
  return !!n && (n as { nodeType?: number }).nodeType === 1;
}

function resolveStyles(
  el: ParsedElement,
  rules: ReturnType<typeof parseStylesheet>,
  hits?: Map<string, number>,
): { base: StyleMap; variants: { selector: string; styles: StyleMap }[] } {
  const base: StyleMap = {};
  const variantMap = new Map<string, StyleMap>();

  const matching = rules
    .map((r) => ({ rule: r, parts: r.selector.split(',').map((s) => s.trim()) }))
    .flatMap(({ rule, parts }) => parts.map((p) => ({ rule, part: p })))
    .filter(({ part }) => selectorMatches(el, part))
    .sort((a, b) => specificity(a.part) - specificity(b.part));
  if (hits) for (const { part } of matching) hits.set(part, (hits.get(part) ?? 0) + 1);

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
 * Matches a selector against an element, combinators included: descendant
 * (` `), child (`>`), adjacent (`+`) and general sibling (`~`). Matching runs
 * right to left through the parsed tree, the way browsers do — `.nav span`
 * must not style every span in the document.
 */
function selectorMatches(el: ParsedElement, selector: string): boolean {
  const tokens = selector.trim().replace(/\s*([>+~])\s*/g, ' $1 ').split(/\s+/).filter(Boolean);
  if (!tokens.length) return false;
  // [compound, combinator-to-its-left, compound, …] read from the right.
  const compounds: string[] = [];
  const combinators: string[] = [];
  for (const t of tokens) {
    if (t === '>' || t === '+' || t === '~') combinators[compounds.length - 1] = t;
    else { if (compounds.length && combinators[compounds.length - 1] === undefined) combinators[compounds.length - 1] = ' '; compounds.push(t); }
  }
  return matchAt(el, compounds, combinators, compounds.length - 1);
}

type Parentish = { parentNode?: unknown; childNodes?: unknown[] };
const parentEl = (el: ParsedElement): ParsedElement | null => {
  const p = (el as unknown as Parentish).parentNode as ParsedElement | undefined;
  return p && isElement(p) && p.rawTagName ? p : null;
};
const prevSiblings = (el: ParsedElement): ParsedElement[] => {
  const p = (el as unknown as Parentish).parentNode as Parentish | undefined;
  const kids = (p?.childNodes ?? []).filter(isElement) as ParsedElement[];
  const i = kids.indexOf(el);
  return i > 0 ? kids.slice(0, i).reverse() : [];
};

function matchAt(el: ParsedElement, compounds: string[], combinators: string[], i: number): boolean {
  if (!compoundMatches(el, compounds[i]!)) return false;
  if (i === 0) return true;
  const comb = combinators[i - 1] ?? ' ';
  if (comb === '>') { const p = parentEl(el); return !!p && matchAt(p, compounds, combinators, i - 1); }
  if (comb === '+') { const s = prevSiblings(el)[0]; return !!s && matchAt(s, compounds, combinators, i - 1); }
  if (comb === '~') return prevSiblings(el).some((s) => matchAt(s, compounds, combinators, i - 1));
  for (let p = parentEl(el); p; p = parentEl(p)) if (matchAt(p, compounds, combinators, i - 1)) return true;
  return false;
}

function compoundMatches(el: ParsedElement, raw: string): boolean {
  const compound = raw.replace(/::?[\w-]+(\([^)]*\))?/g, '');
  if (!compound || compound === '*') return true;

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
  // An explicit layer name (Figma paste, agents) wins over anything inferred.
  const given = el.getAttribute('data-name');
  if (given?.trim()) return truncate(given, 60);
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
