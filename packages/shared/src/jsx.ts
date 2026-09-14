/**
 * JSX projection.
 *
 * Two formats, matching what agents actually ask for: inline styles (explicit,
 * lossless, easy for a model to reason about) and Tailwind (what most codebases
 * want). The Tailwind emitter maps the properties that have exact utilities and
 * falls back to arbitrary-value classes for everything else, so it is lossless
 * either way — no declaration is silently dropped.
 */

import type { CanvasDocument, CanvasNode, NodeId, StyleMap } from './model.ts';
import { type ExpandedNode, expandNode } from './components.ts';
import { sanitizeMarkup } from './sanitize.ts';
import { codeComponentOf, codeElementJsx, collectCodeImports, explicitCodeProps } from './code-components.ts';

export type JsxFormat = 'tailwind' | 'inline';

export interface JsxOptions {
  format?: JsxFormat;
  /** Wrap the output in `export function Name() { return (...) }`. */
  componentName?: string;
}

const VOID_TAGS = new Set(['img', 'br', 'hr', 'input', 'source', 'track', 'wbr']);

/** HTML attribute -> JSX prop, for the attributes that differ. */
const ATTR_MAP: Record<string, string> = {
  class: 'className', for: 'htmlFor', tabindex: 'tabIndex', readonly: 'readOnly',
  maxlength: 'maxLength', colspan: 'colSpan', rowspan: 'rowSpan', autocomplete: 'autoComplete',
  srcset: 'srcSet', crossorigin: 'crossOrigin', contenteditable: 'contentEditable',
};

export function emitJsx(doc: CanvasDocument, rootId: NodeId, opts: JsxOptions = {}): string {
  const format = opts.format ?? 'tailwind';

  const render = (expanded: ExpandedNode | null, depth: number): string => {
    if (!expanded) return '';
    const node = expanded.node;
    const pad = '  '.repeat(depth);
    const props = propsFor(node, format);
    const tag = node.tag;

    // A code node *is* the project's component — emit the real element, not a
    // rendering of it. This is the point of the whole feature: round-tripping.
    if (node.type === 'code') {
      const component = codeComponentOf(doc, node);
      if (component) return pad + codeElementJsx(component, explicitCodeProps(component, node));
    }

    if (VOID_TAGS.has(tag)) return `${pad}<${tag}${props} />`;

    if (node.type === 'vector') {
      // SVG children are kept verbatim; re-authoring them as JSX loses detail.
      return `${pad}<${tag}${props} dangerouslySetInnerHTML={{ __html: ${JSON.stringify(sanitizeMarkup(node.text ?? ''))} }} />`;
    }
    if (node.type === 'text') {
      return `${pad}<${tag}${props}>${escapeJsxText(node.text ?? '')}</${tag}>`;
    }

    const kids = expanded.children.map((c) => render(c, depth + 1)).filter(Boolean);
    if (!kids.length) return `${pad}<${tag}${props} />`;
    return `${pad}<${tag}${props}>\n${kids.join('\n')}\n${pad}</${tag}>`;
  };

  const root = doc.nodes[rootId];
  const body = root ? render(expandNode(doc, root), opts.componentName ? 2 : 0) : '';
  if (!opts.componentName) return body;
  const imports = collectCodeImports(doc, rootId);
  const preamble = imports.length ? `${imports.join('\n')}\n\n` : '';
  return `${preamble}export function ${opts.componentName}() {\n  return (\n${body}\n  );\n}\n`;
}

function propsFor(node: CanvasNode, format: JsxFormat): string {
  const props: string[] = [];

  for (const [k, v] of Object.entries(node.attrs)) {
    if (k.startsWith('data-x') || k.startsWith('data-y')) continue;
    // Slot markers are authoring metadata, not output.
    if (k === 'data-slot' || k === 'data-slot-target') continue;
    const name = ATTR_MAP[k] ?? k;
    props.push(`${name}={${JSON.stringify(v)}}`);
  }

  if (format === 'tailwind') {
    const { classes, leftover } = cssToTailwind(node.styles);
    const variantClasses = node.variants.flatMap((v) => {
      const prefix = variantPrefix(v.selector);
      if (!prefix) return [];
      return cssToTailwind(v.styles).classes.map((c) => `${prefix}:${c}`);
    });
    const all = [...classes, ...variantClasses];
    if (all.length) props.push(`className="${all.join(' ')}"`);
    if (Object.keys(leftover).length) props.push(`style={${styleObject(leftover)}}`);
  } else {
    if (Object.keys(node.styles).length) props.push(`style={${styleObject(node.styles)}}`);
  }

  return props.length ? ' ' + props.join(' ') : '';
}

function variantPrefix(selector: string): string | null {
  const pseudo: Record<string, string> = {
    ':hover': 'hover', ':focus': 'focus', ':active': 'active',
    ':focus-visible': 'focus-visible', ':disabled': 'disabled',
  };
  if (pseudo[selector]) return pseudo[selector]!;
  const m = /@media\s*\(\s*max-width:\s*(\d+)px/.exec(selector);
  if (m) {
    const bp = Number(m[1]);
    // Tailwind is min-width-first; map the common max-width breakpoints to the
    // nearest standard screen and leave anything unusual to arbitrary syntax.
    if (bp <= 640) return 'max-sm';
    if (bp <= 768) return 'max-md';
    if (bp <= 1024) return 'max-lg';
    return `max-[${bp}px]`;
  }
  const mm = /@media\s*\(\s*min-width:\s*(\d+)px/.exec(selector);
  if (mm) {
    const bp = Number(mm[1]);
    if (bp === 640) return 'sm';
    if (bp === 768) return 'md';
    if (bp === 1024) return 'lg';
    if (bp === 1280) return 'xl';
    return `min-[${bp}px]`;
  }
  return null;
}

function styleObject(styles: StyleMap): string {
  const entries = Object.entries(styles).map(([k, v]) => `${JSON.stringify(camel(k))}: ${JSON.stringify(v)}`);
  return `{ ${entries.join(', ')} }`;
}

export function camel(prop: string): string {
  if (prop.startsWith('--')) return prop;
  return prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function escapeJsxText(s: string): string {
  if (/[{}<>]/.test(s)) return `{${JSON.stringify(s)}}`;
  return s;
}

// ---------------------------------------------------------------------------
// Tailwind mapping
// ---------------------------------------------------------------------------

const EXACT: Record<string, Record<string, string>> = {
  display: { flex: 'flex', block: 'block', 'inline-flex': 'inline-flex', grid: 'grid', none: 'hidden', 'inline-block': 'inline-block', contents: 'contents' },
  'flex-direction': { row: 'flex-row', column: 'flex-col', 'row-reverse': 'flex-row-reverse', 'column-reverse': 'flex-col-reverse' },
  'flex-wrap': { wrap: 'flex-wrap', nowrap: 'flex-nowrap', 'wrap-reverse': 'flex-wrap-reverse' },
  'align-items': { 'flex-start': 'items-start', start: 'items-start', center: 'items-center', 'flex-end': 'items-end', end: 'items-end', stretch: 'items-stretch', baseline: 'items-baseline' },
  'justify-content': { 'flex-start': 'justify-start', center: 'justify-center', 'flex-end': 'justify-end', 'space-between': 'justify-between', 'space-around': 'justify-around', 'space-evenly': 'justify-evenly' },
  position: { relative: 'relative', absolute: 'absolute', fixed: 'fixed', sticky: 'sticky', static: 'static' },
  overflow: { hidden: 'overflow-hidden', auto: 'overflow-auto', scroll: 'overflow-scroll', visible: 'overflow-visible' },
  'text-align': { left: 'text-left', center: 'text-center', right: 'text-right', justify: 'text-justify' },
  'font-weight': { '100': 'font-thin', '200': 'font-extralight', '300': 'font-light', '400': 'font-normal', '500': 'font-medium', '600': 'font-semibold', '700': 'font-bold', '800': 'font-extrabold', '900': 'font-black' },
  'font-style': { italic: 'italic', normal: 'not-italic' },
  'text-transform': { uppercase: 'uppercase', lowercase: 'lowercase', capitalize: 'capitalize', none: 'normal-case' },
  'text-decoration-line': { underline: 'underline', 'line-through': 'line-through', none: 'no-underline' },
  'object-fit': { cover: 'object-cover', contain: 'object-contain', fill: 'object-fill', none: 'object-none' },
  'white-space': { nowrap: 'whitespace-nowrap', pre: 'whitespace-pre', normal: 'whitespace-normal' },
  'flex-grow': { '1': 'grow', '0': 'grow-0' },
  'flex-shrink': { '1': 'shrink', '0': 'shrink-0' },
};

/** Properties that become `prefix-[value]` when not an exact match. */
const ARBITRARY: Record<string, string> = {
  width: 'w', height: 'h', 'min-width': 'min-w', 'min-height': 'min-h',
  'max-width': 'max-w', 'max-height': 'max-h',
  gap: 'gap', 'row-gap': 'gap-y', 'column-gap': 'gap-x',
  padding: 'p', 'padding-top': 'pt', 'padding-right': 'pr', 'padding-bottom': 'pb', 'padding-left': 'pl',
  margin: 'm', 'margin-top': 'mt', 'margin-right': 'mr', 'margin-bottom': 'mb', 'margin-left': 'ml',
  'background-color': 'bg', color: 'text', 'font-size': 'text', 'font-family': 'font',
  'line-height': 'leading', 'letter-spacing': 'tracking', 'border-radius': 'rounded',
  'border-width': 'border', 'border-color': 'border', opacity: 'opacity', 'z-index': 'z',
  top: 'top', right: 'right', bottom: 'bottom', left: 'left', 'box-shadow': 'shadow',
  'flex-basis': 'basis', 'aspect-ratio': 'aspect', 'mix-blend-mode': 'mix-blend',
  'grid-template-columns': 'grid-cols', 'grid-template-rows': 'grid-rows',
};

const SPECIAL_VALUES: Record<string, Record<string, string>> = {
  width: { '100%': 'w-full', auto: 'w-auto', 'fit-content': 'w-fit', '100vw': 'w-screen' },
  height: { '100%': 'h-full', auto: 'h-auto', 'fit-content': 'h-fit', '100vh': 'h-screen' },
  'border-radius': { '9999px': 'rounded-full', '0px': 'rounded-none' },
  opacity: { '0': 'opacity-0', '1': 'opacity-100', '0.5': 'opacity-50' },
};

export function cssToTailwind(styles: StyleMap): { classes: string[]; leftover: StyleMap } {
  const classes: string[] = [];
  const leftover: StyleMap = {};

  for (const [prop, rawValue] of Object.entries(styles)) {
    const value = rawValue.trim();
    if (!value) continue;

    if (prop.startsWith('--')) { leftover[prop] = value; continue; }

    const special = SPECIAL_VALUES[prop]?.[value];
    if (special) { classes.push(special); continue; }

    const exact = EXACT[prop]?.[value];
    if (exact) { classes.push(exact); continue; }

    // `flex: 1` and shorthand padding/margin with multiple values need care.
    if (prop === 'flex') {
      if (value === '1' || value === '1 1 0%') { classes.push('flex-1'); continue; }
      if (value === 'none') { classes.push('flex-none'); continue; }
    }
    if ((prop === 'padding' || prop === 'margin') && value.split(/\s+/).length > 1) {
      const parts = value.split(/\s+/);
      const p = prop === 'padding' ? 'p' : 'm';
      if (parts.length === 2) { classes.push(`${p}y-[${parts[0]}]`, `${p}x-[${parts[1]}]`); continue; }
      const [t, r, b, l] = [parts[0]!, parts[1]!, parts[2] ?? parts[0]!, parts[3] ?? parts[1]!];
      classes.push(`${p}t-[${t}]`, `${p}r-[${r}]`, `${p}b-[${b}]`, `${p}l-[${l}]`);
      continue;
    }

    const prefix = ARBITRARY[prop];
    if (prefix) {
      classes.push(`${prefix}-[${value.replace(/\s+/g, '_')}]`);
      continue;
    }

    leftover[prop] = value;
  }

  return { classes, leftover };
}
