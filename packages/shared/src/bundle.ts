/**
 * A whole document, as one file.
 *
 * Until now the only way out of a document was HTML, which is a projection: it
 * carries structure, styles and variants, and drops everything the projection
 * does not have a place for. Tokens come out as `var(--name)` references that
 * resolve to whatever the destination happens to mean by that name — or to
 * nothing — and components are flattened into copies of their own markup.
 *
 * A bundle is the document itself: nodes, pages, tokens, components, code
 * components, breakpoints and comments, plus the assets they point at, so that
 * the copy is a copy rather than a likeness.
 *
 * What is deliberately not in it: connection codes, share tokens and version
 * snapshots. The first two are credentials for one instance and must never
 * travel in a file people email each other; the third is the history of a
 * document, not the document.
 */

import type { CanvasDocument } from './model.ts';

export const BUNDLE_FORMAT = 'playground.document/1';

export interface BundleAsset {
  id: string;
  mime: string;
  name: string | null;
  /** base64, so the bundle stays one JSON file. */
  data: string;
}

export interface DocumentBundle {
  format: typeof BUNDLE_FORMAT;
  exportedAt: string;
  /** Where it came from, for the human reading the file. Never used on import. */
  source?: { id?: string; url?: string };
  document: CanvasDocument;
  assets: BundleAsset[];
}

/** Every asset id the document refers to, wherever the reference lives. */
export function referencedAssets(doc: CanvasDocument): Set<string> {
  const found = new Set<string>();
  const scan = (value: unknown) => {
    if (typeof value !== 'string') return;
    for (const m of value.matchAll(/\/assets\/([A-Za-z0-9_-]+)/g)) found.add(m[1]!);
  };

  for (const node of Object.values(doc.nodes)) {
    for (const v of Object.values(node.attrs)) scan(v);
    for (const v of Object.values(node.styles)) scan(v);
    for (const variant of node.variants) for (const v of Object.values(variant.styles)) scan(v);
  }
  // A code component's bundle is an asset id on its own, not inside a URL.
  for (const component of Object.values(doc.codeComponents ?? {})) found.add(component.bundle);
  return found;
}

/**
 * Rewrites every asset reference through `map`.
 *
 * Asset ids are unique per instance, not per document, so an imported document
 * must point at the copies that were just stored — otherwise it renders against
 * whatever happens to live at those ids on the destination, or nothing at all.
 */
export function remapAssets(doc: CanvasDocument, map: Map<string, string>): void {
  const rewrite = (value: string): string =>
    value.replace(/\/assets\/([A-Za-z0-9_-]+)/g, (whole, id: string) => {
      const next = map.get(id);
      return next ? `/assets/${next}` : whole;
    });

  for (const node of Object.values(doc.nodes)) {
    for (const [k, v] of Object.entries(node.attrs)) {
      if (typeof v === 'string') node.attrs[k] = rewrite(v);
    }
    for (const [k, v] of Object.entries(node.styles)) {
      if (typeof v === 'string') node.styles[k] = rewrite(v);
    }
    for (const variant of node.variants) {
      for (const [k, v] of Object.entries(variant.styles)) {
        if (typeof v === 'string') variant.styles[k] = rewrite(v);
      }
    }
  }
  for (const component of Object.values(doc.codeComponents ?? {})) {
    component.bundle = map.get(component.bundle) ?? component.bundle;
  }
}

/**
 * Checks a bundle well enough that importing it cannot produce a document the
 * editor chokes on.
 *
 * This is parsing a file someone was handed, so it does not assume the tree is
 * coherent: a child id that points at nothing, or a page listing an artboard
 * that was never included, renders as a blank canvas with no explanation. It is
 * better to refuse the file and say which reference is dangling.
 */
export function validateBundle(value: unknown):
  | { ok: true; bundle: DocumentBundle; problems: string[] }
  | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const b = value as Partial<DocumentBundle>;

  if (!b || typeof b !== 'object') return { ok: false, problems: ['not an object'] };
  if (b.format !== BUNDLE_FORMAT) {
    problems.push(`format is ${JSON.stringify(b.format)}; this reads ${BUNDLE_FORMAT}`);
  }
  const doc = b.document;
  if (!doc || typeof doc !== 'object') return { ok: false, problems: [...problems, 'no document'] };
  if (!doc.nodes || typeof doc.nodes !== 'object') return { ok: false, problems: [...problems, 'document has no nodes'] };
  if (!Array.isArray(doc.pages) || doc.pages.length === 0) problems.push('document has no pages');

  const ids = new Set(Object.keys(doc.nodes));
  const dangling: string[] = [];
  for (const [id, node] of Object.entries(doc.nodes)) {
    if (node.parent !== null && node.parent !== undefined && !ids.has(node.parent)) {
      dangling.push(`${id}.parent → ${node.parent}`);
    }
    for (const child of node.children ?? []) if (!ids.has(child)) dangling.push(`${id}.children → ${child}`);
  }
  for (const page of doc.pages ?? []) {
    for (const artboard of page.artboards ?? []) {
      if (!ids.has(artboard)) dangling.push(`page ${page.id} → ${artboard}`);
    }
  }
  // Listing a few is enough to identify the problem; listing four hundred is not.
  if (dangling.length) {
    problems.push(`${dangling.length} dangling reference(s): ${dangling.slice(0, 5).join(', ')}`);
  }

  if (b.assets !== undefined && !Array.isArray(b.assets)) problems.push('assets is not a list');
  for (const asset of b.assets ?? []) {
    if (!asset?.id || typeof asset.data !== 'string' || !asset.mime) {
      problems.push(`an asset is missing id, mime or data`);
      break;
    }
  }

  const missing = [...referencedAssets(doc as CanvasDocument)]
    .filter((id) => !(b.assets ?? []).some((a) => a.id === id));
  // Not fatal: a bundle exported without assets is still worth importing, and
  // the images simply do not resolve. Saying so beats a silent blank.
  if (missing.length) problems.push(`NOTE ${missing.length} asset(s) referenced but not included`);

  const fatal = problems.filter((p) => !p.startsWith('NOTE'));
  return fatal.length
    ? { ok: false, problems }
    // Notes travel with a successful result too: "12 assets referenced but not
    // included" is something the importer should be told, not swallowed.
    : { ok: true, bundle: b as DocumentBundle, problems };
}

/** Everything that must not leave the instance it belongs to. */
export function stripLocalState(doc: CanvasDocument): CanvasDocument {
  const copy: CanvasDocument = structuredClone(doc);
  // Project membership is library metadata of *that* library.
  delete copy.projectId;
  return copy;
}
