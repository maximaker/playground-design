/**
 * Code components: the project's real components, rendered on the canvas.
 *
 * This is the half of "the design is the code" that was missing. Until now you
 * designed *towards* code — your Button already existed in the repo and the
 * tool made you rebuild it. A code component renders the actual component, with
 * its actual props, so what is on the canvas is the thing that ships.
 *
 * Playground runs in a browser and cannot read or build a repository, so the
 * agent does the bundling — it has the toolchain — and uploads a self-contained
 * ES module. The contract is deliberately small: export `mount(element, props)`.
 *
 * The bundle is third-party code, so it renders inside a sandboxed iframe with
 * `allow-scripts` and *without* `allow-same-origin`. It gets an opaque origin:
 * it cannot reach the document, the parent page, cookies or storage.
 */

import type { CanvasDocument, CanvasNode, NodeId } from './model.ts';

export type CodePropType = 'string' | 'number' | 'boolean' | 'enum';

export interface CodeProp {
  name: string;
  type: CodePropType;
  /** For `enum`. */
  values?: string[];
  default?: string;
  required?: boolean;
  description?: string;
}

export interface CodeComponent {
  id: string;
  name: string;
  /** How the project imports it, e.g. `@/components/Button`. */
  importPath: string;
  /** Named export, or `default`. */
  exportName: string;
  props: CodeProp[];
  /** Asset id of the uploaded ES module. */
  bundle: string;
  /** Natural size reported by the last render, for hugging. */
  naturalSize?: { width: number; height: number };
  createdAt: number;
  /** Source file, for the human. */
  sourcePath?: string;
}

export function codeComponentsOf(doc: CanvasDocument): CodeComponent[] {
  return Object.values(doc.codeComponents ?? {}).sort((a, b) => a.name.localeCompare(b.name));
}

export function codeComponentOf(doc: CanvasDocument, node: CanvasNode): CodeComponent | undefined {
  return node.codeRef ? doc.codeComponents?.[node.codeRef] : undefined;
}

/** An instance's props, with declared defaults filled in and unknowns dropped. */
export function resolvedCodeProps(component: CodeComponent | undefined, node: CanvasNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const prop of component?.props ?? []) {
    if (prop.default !== undefined) out[prop.name] = coerce(prop, prop.default);
  }
  for (const [key, raw] of Object.entries(node.props ?? {})) {
    const declared = component?.props.find((p) => p.name === key);
    // A prop the component no longer declares is stale, not a value to pass on.
    if (!declared) continue;
    out[key] = coerce(declared, raw);
  }
  return out;
}

function coerce(prop: CodeProp, raw: string): unknown {
  if (prop.type === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }
  if (prop.type === 'boolean') return raw === 'true' || raw === '1';
  if (prop.type === 'enum' && prop.values && !prop.values.includes(raw)) return prop.default;
  return raw;
}

/**
 * The props to write into exported JSX: only what the instance actually set.
 *
 * `resolvedCodeProps` fills defaults in because the canvas has to render
 * something. Export must not — the component already defines its defaults, and
 * spelling them out again produces `disabled={false}` noise on every element
 * and silently freezes today's default into the caller's code.
 */
export function explicitCodeProps(component: CodeComponent, node: CanvasNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(node.props ?? {})) {
    const declared = component.props.find((p) => p.name === key);
    if (!declared || raw === declared.default) continue;
    const value = coerce(declared, raw);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export interface CodeImport {
  importPath: string;
  exportName: string;
  localName: string;
}

/** The JSX element for a code node, e.g. `<Button variant="primary" />`. */
export function codeElementJsx(component: CodeComponent, props: Record<string, unknown>): string {
  const attrs = Object.entries(props)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([name, value]) => {
      if (typeof value === 'boolean') return value ? name : `${name}={false}`;
      if (typeof value === 'number') return `${name}={${value}}`;
      return `${name}=${JSON.stringify(String(value))}`;
    });
  const inline = attrs.join(' ');
  return `<${component.name}${inline ? ` ${inline}` : ''} />`;
}

/** Import statements for every code component used under a subtree. */
export function collectCodeImports(doc: CanvasDocument, rootId: NodeId): string[] {
  const used = new Map<string, CodeImport>();

  const walk = (id: NodeId) => {
    const node = doc.nodes[id];
    if (!node) return;
    const component = codeComponentOf(doc, node);
    if (component) {
      used.set(component.id, {
        importPath: component.importPath,
        exportName: component.exportName,
        localName: component.name,
      });
    }
    for (const child of node.children) walk(child);
  };
  walk(rootId);

  // Group by path so one module produces one import statement.
  const byPath = new Map<string, CodeImport[]>();
  for (const imp of used.values()) {
    byPath.set(imp.importPath, [...(byPath.get(imp.importPath) ?? []), imp]);
  }

  return [...byPath.entries()].map(([path, imports]) => {
    const defaults = imports.filter((i) => i.exportName === 'default');
    const named = imports.filter((i) => i.exportName !== 'default');
    const parts: string[] = [];
    if (defaults[0]) parts.push(defaults[0].localName);
    if (named.length) {
      parts.push(`{ ${named.map((i) => (i.exportName === i.localName ? i.localName : `${i.exportName} as ${i.localName}`)).join(', ')} }`);
    }
    return `import ${parts.join(', ')} from ${JSON.stringify(path)};`;
  }).sort();
}

/**
 * The wrapper an agent bundles around a component.
 *
 * Kept here so the guide, the demo and any generator agree on one contract.
 */
export const MOUNT_CONTRACT = `import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { YourComponent } from './your-component';

const roots = new WeakMap();

export function mount(element, props) {
  let root = roots.get(element);
  if (!root) { root = createRoot(element); roots.set(element, root); }
  root.render(createElement(YourComponent, props));
}

export function unmount(element) {
  roots.get(element)?.unmount();
  roots.delete(element);
}`;
