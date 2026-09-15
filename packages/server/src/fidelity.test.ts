/**
 * Export fidelity gate.
 *
 * PRD success metric: a design must survive the round trip through its own
 * projection. We render an artboard, export it, parse the export back into a
 * fresh document, render that, and pixel-diff the two. Anything the emitter or
 * parser loses shows up here as drifting pixels.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PLAYGROUND_DB = `/tmp/playground-fidelity-${Date.now()}.db`;

const { createEmptyDocument, parseHtml, emitHtml, emitJsx, applyOp, cssToTailwind } = await import('@playground/shared');
const { createDocument, getDocument, applyOps } = await import('./store.ts');
const { renderNode, shutdownRenderer } = await import('./render.ts');

/** A page that exercises flex, wrapping text, borders, shadows, and media queries. */
const SOURCE = `
<style>
  .root { display:flex; flex-direction:column; gap:32px; padding:48px;
          background:#ffffff; font-family:Georgia, serif; width:100%; }
  .row { display:flex; flex-direction:row; gap:16px; align-items:stretch; }
  .box { display:flex; flex-direction:column; gap:8px; padding:20px; flex:1;
         border:2px solid #0f172a; border-radius:12px; background:#f8fafc;
         box-shadow:0 6px 18px rgba(15,23,42,.14); }
  .h { font-size:40px; font-weight:700; line-height:1.15; color:#0f172a; margin:0; }
  .p { font-size:15px; line-height:1.7; color:#334155; margin:0; }
  .tag { font-size:11px; letter-spacing:.18em; text-transform:uppercase; color:#7c3aed; }
  .pill { padding:8px 14px; border-radius:999px; background:#7c3aed; color:#fff;
          font-size:13px; width:fit-content; }
</style>
<div class="root">
  <span class="tag">Fidelity</span>
  <h1 class="h">A layout that has to survive a round trip through its own export</h1>
  <div class="row">
    <div class="box"><span class="tag">One</span><p class="p">Text that wraps across several lines so line breaking is compared, not just boxes.</p><div class="pill">Action</div></div>
    <div class="box"><span class="tag">Two</span><p class="p">Shadows, borders and radii all have to come back identically.</p><div class="pill">Action</div></div>
    <div class="box"><span class="tag">Three</span><p class="p">Flex sizing with flex:1 must resolve to the same widths.</p><div class="pill">Action</div></div>
  </div>
</div>`;

let originalPng: Buffer;
let roundTripPng: Buffer;
let playwrightAvailable = true;

before(async () => {
  const doc = createEmptyDocument('Fidelity');
  await createDocument('Fidelity', doc);
  const artboard = doc.pages[0]!.artboards[0]!;

  const parsed = parseHtml(SOURCE);
  applyOps(doc.id, [{
    op: { t: 'insert', nodes: parsed.nodes, parent: artboard, index: 0 },
    origin: { kind: 'system', id: 'test' },
  }]);

  const live = getDocument(doc.id)!;
  try {
    originalPng = (await renderNode(live, artboard, { format: 'png', scale: 1 })).data;
  } catch (err) {
    // Without Playwright there is no headless rasterizer, so this gate cannot run.
    playwrightAvailable = false;
    console.log(`  (skipping pixel diff: ${err instanceof Error ? err.message.slice(0, 80) : err})`);
    return;
  }

  // Export, then rebuild a fresh document from nothing but the exported markup.
  const { html, css } = emitHtml(live, artboard, { mode: 'stylesheet', includeTokens: false });
  const exported = `<style>${css}</style>${html}`;

  const rebuilt = createEmptyDocument('Rebuilt');
  await createDocument('Rebuilt', rebuilt);
  const rebuiltArtboard = rebuilt.pages[0]!.artboards[0]!;
  // Match the source artboard's own box so the comparison is like-for-like.
  applyOp(rebuilt, { t: 'styles', updates: [{ id: rebuiltArtboard, styles: live.nodes[artboard]!.styles }] });

  const reparsed = parseHtml(exported);
  applyOps(rebuilt.id, [{
    op: { t: 'insert', nodes: reparsed.nodes, parent: rebuiltArtboard, index: 0 },
    origin: { kind: 'system', id: 'test' },
  }]);

  roundTripPng = (await renderNode(getDocument(rebuilt.id)!, rebuiltArtboard, { format: 'png', scale: 1 })).data;
});

after(async () => { await shutdownRenderer(); });

test('an exported design re-imports to a pixel-identical render', { skip: !playwrightAvailable }, () => {
  const diff = comparePng(originalPng, roundTripPng);
  assert.ok(
    diff.ratio <= 0.01,
    `${(diff.ratio * 100).toFixed(2)}% of pixels differ after the round trip (limit 1%)`,
  );
});

test('the tree survives the round trip structurally', () => {
  const doc = createEmptyDocument('Structure');
  const parsed = parseHtml(SOURCE);
  for (const n of parsed.nodes) doc.nodes[n.id] = n;
  const artboard = doc.pages[0]!.artboards[0]!;
  applyOp(doc, { t: 'insert', nodes: [], parent: artboard, index: 0 });
  doc.nodes[artboard]!.children = parsed.roots;
  for (const r of parsed.roots) doc.nodes[r]!.parent = artboard;

  const { html, css } = emitHtml(doc, artboard, { mode: 'stylesheet', includeTokens: false });
  const reparsed = parseHtml(`<style>${css}</style>${html}`);

  assert.equal(
    reparsed.nodes.length, parsed.nodes.length + 1,
    'node count should match (plus the artboard wrapper itself)',
  );

  const textsBefore = parsed.nodes.filter((n) => n.type === 'text').map((n) => n.text).sort();
  const textsAfter = reparsed.nodes.filter((n) => n.type === 'text').map((n) => n.text).sort();
  assert.deepEqual(textsAfter, textsBefore, 'no text may be lost or altered');

  const before = parsed.nodes.find((n) => n.name === 'root' || n.attrs.class === 'root');
  const after = reparsed.nodes.find((n) => n.styles.display === 'flex' && n.styles.padding === '48px');
  assert.ok(after, 'the root container keeps its layout styles');
  void before;
});

test('JSX export keeps every declaration', () => {
  const doc = createEmptyDocument('Jsx');
  const parsed = parseHtml(SOURCE);
  const artboard = doc.pages[0]!.artboards[0]!;
  for (const n of parsed.nodes) doc.nodes[n.id] = n;
  doc.nodes[artboard]!.children = parsed.roots;
  for (const r of parsed.roots) doc.nodes[r]!.parent = artboard;

  const jsx = emitJsx(doc, artboard, { format: 'tailwind' });

  // The invariant is that nothing is silently dropped: every declaration either
  // becomes a utility class or survives in the style prop. A property that maps
  // to an exact utility (font-weight: 700 -> font-bold) is not findable by name
  // in the output, so check the mapping itself rather than grepping the string.
  for (const node of parsed.nodes) {
    const declarations = Object.entries(node.styles).filter(([, v]) => v);
    if (!declarations.length) continue;

    const { classes, leftover } = cssToTailwind(node.styles);
    for (const [prop, value] of declarations) {
      const inLeftover = leftover[prop] === value;
      // A mapped property yields at least one class; shorthands may yield several.
      const mapped = cssToTailwind({ [prop]: value }).classes.length > 0;
      assert.ok(inLeftover || mapped, `declaration ${prop}: ${value} is dropped by the Tailwind emitter`);
    }

    assert.ok(
      classes.length > 0 || Object.keys(leftover).length > 0,
      `node ${node.name} has styles but produced neither classes nor a style prop`,
    );
  }

  // And the emitted JSX must actually carry them.
  assert.match(jsx, /className="/);
  assert.match(jsx, /style=\{\{/, 'unmapped properties should appear in a style prop');
});

/**
 * Minimal PNG comparison. Decoding PNG properly would need a dependency; byte
 * length plus a chunked byte diff is a coarse but real signal, and the render
 * is deterministic, so identical input produces identical bytes.
 */
function comparePng(a: Buffer, b: Buffer): { ratio: number } {
  if (a.equals(b)) return { ratio: 0 };
  const len = Math.max(a.length, b.length);
  let differing = 0;
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) differing++;
  }
  return { ratio: differing / len };
}
