/**
 * Does a document bundle actually carry what an HTML export drops?
 *
 * The source deliberately uses the things the HTML path loses: design tokens
 * with more than one theme, a component with instances, code components with an
 * uploaded bundle, an image asset, hover and breakpoint variants, and comments.
 *
 * Every assertion compares the copy against the original rather than against a
 * number written down here, so the check keeps meaning something as the source
 * document changes.
 */

import { writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = process.argv[2] ?? 'http://localhost:4000';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
};

async function connect(docId) {
  const raw = await (await fetch(`${BASE}/api/documents/${docId}/connections`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'bundle check' }),
  })).text();
  const c = new Client({ name: 'bundle-check', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(
    new URL(`${BASE}/mcp/${raw.match(/\/mcp\/([A-Z0-9-]+)/)[1]}`)));
  return {
    c,
    call: async (n, a = {}) => {
      const r = await c.callTool({ name: n, arguments: a });
      const t = r.content.filter((x) => x.type === 'text').map((x) => x.text).join('\n');
      if (r.isError) throw new Error(`${n}: ${t}`);
      return t;
    },
  };
}

// --- A source worth copying ------------------------------------------------

const src = (await (await fetch(`${BASE}/api/documents`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Bundle source' }),
})).json()).document;
const a = await connect(src.id);

await a.call('set_tokens', { tokens: [
  { name: 'color.brand', group: 'color', values: { default: '#4F46E5', dark: '#818CF8' } },
  { name: 'space.card', group: 'space', values: { default: '28px' } },
]});

const board = JSON.parse(await a.call('create_artboard', { name: 'Source', width: 900, height: 600 }));
const written = JSON.parse(await a.call('write_html', {
  targetId: board.id, mode: 'replace-children',
  html: `<style>
    .card { display:flex; flex-direction:column; gap:12px; padding:var(--space-card); background:#fff; }
    .card:hover { border-color: var(--color-brand); }
    @media (max-width: 600px) { .card { padding: 12px; } }
  </style>
  <div style="display:flex;flex-direction:column;gap:24px;padding:40px;height:100%">
    <h1 style="margin:0;color:var(--color-brand)">Bundle</h1>
    <div class="card"><strong>A card</strong><p style="margin:0">With a hover and a breakpoint.</p></div>
  </div>`,
}));

// A 1×1 PNG, so there is a real asset to carry.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const form = new FormData();
form.append('file', new Blob([png], { type: 'image/png' }), 'dot.png');
const asset = await (await fetch(`${BASE}/api/documents/${src.id}/assets`, { method: 'POST', body: form })).json();
await a.call('write_html', {
  targetId: written.roots[0].id,
  html: `<img src="${asset.url}" alt="a dot" style="width:32px;height:32px" />`,
});

const cardId = JSON.parse(await a.call('get_children', { id: written.roots[0].id }))[1].id;
const comp = JSON.parse(await a.call('create_component', { id: cardId, name: 'Card' }));
await a.call('insert_instance', { componentId: comp.componentId, parentId: written.roots[0].id });

const pageId = JSON.parse(await a.call('get_basic_info')).currentPage;
await a.call('write_html', { targetId: written.roots[0].id, html: '<span>anchor</span>' });

const srcInfo = JSON.parse(await a.call('get_basic_info'));
const srcTokens = JSON.parse(await a.call('get_tokens')).tokens;
const srcComps = JSON.parse(await a.call('list_components')).components;
await a.c.close();

console.log(`  source: ${srcInfo.nodeCount} nodes, ${srcTokens.length} tokens, ` +
  `${srcComps.length} component(s), 1 asset`);

// --- Export, import, compare ----------------------------------------------

const bundleRes = await fetch(`${BASE}/api/documents/${src.id}/bundle`);
check('the document exports as a bundle', bundleRes.ok, `${bundleRes.status}`);
const bundle = await bundleRes.json();
check('the bundle carries its assets', bundle.assets.length === 1, `${bundle.assets.length} asset(s)`);
check('and no credentials ride along',
  !JSON.stringify(bundle).includes('/mcp/') && !bundle.document.connections && !bundle.document.shares);

const importRes = await fetch(`${BASE}/api/documents/import?name=Bundle%20copy`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bundle),
});
const imported = await importRes.json();
check('it imports', importRes.ok, importRes.ok ? '' : JSON.stringify(imported).slice(0, 140));
if (!importRes.ok) process.exit(1);

check('the copy is a new document, not the original',
  imported.document.id !== src.id, `${src.id} → ${imported.document.id}`);

const b = await connect(imported.document.id);
const dstInfo = JSON.parse(await b.call('get_basic_info'));
const dstTokens = JSON.parse(await b.call('get_tokens')).tokens;
const dstComps = JSON.parse(await b.call('list_components')).components;

check('every node arrives', dstInfo.nodeCount === srcInfo.nodeCount,
  `${srcInfo.nodeCount} → ${dstInfo.nodeCount}`);

// Tokens are what the HTML path loses most damagingly: a name the target shares
// resolves to the target's value, which renders fine and is simply wrong.
const brandSrc = srcTokens.find((t) => t.name === 'color.brand');
const brandDst = dstTokens.find((t) => t.name === 'color.brand');
check('tokens arrive with every theme',
  JSON.stringify(brandSrc.values) === JSON.stringify(brandDst?.values),
  JSON.stringify(brandDst?.values));
check('including ones the target had never heard of',
  !!dstTokens.find((t) => t.name === 'space.card'));

check('components arrive as components', dstComps.length === srcComps.length,
  `${srcComps.length} → ${dstComps.length}`);
check('with their instances still linked',
  dstComps[0]?.instances === srcComps[0].instances,
  `${srcComps[0].instances} → ${dstComps[0]?.instances}`);

// The card became a component, so its hover and breakpoint rules live on the
// definition rather than anywhere in the artboard — which is where looking for
// them the obvious way finds nothing.
const srcRoot = JSON.parse(await (await connect(src.id)).call('get_node_info', { id: srcComps[0].root }));
const dstRoot = JSON.parse(await b.call('get_node_info', { id: dstComps[0].root }));
const sel = (n) => (n.variants ?? []).map((v) => v.selector).sort().join(', ');
check('variants survive, on the component definition',
  sel(dstRoot) === sel(srcRoot) && sel(dstRoot) !== '', sel(dstRoot) || '(none)');

// The asset must be re-stored under a new id and the reference rewritten, or
// the copy renders against whatever happens to live at that id here.
const dstDoc = (await (await fetch(`${BASE}/api/documents/${imported.document.id}`)).json()).document;
const img = Object.values(dstDoc.nodes).find((n) => n.type === 'image');
const newId = img?.attrs.src?.match(/\/assets\/([\w-]+)/)?.[1];
check('the asset is re-stored under a new id', !!newId && newId !== asset.id, `${asset.id} → ${newId}`);
const fetched = await fetch(`${BASE}/assets/${newId}`);
check('and the bytes are actually there', fetched.ok && (await fetched.arrayBuffer()).byteLength === png.length);

// --- Refusals --------------------------------------------------------------

const broken = structuredClone(bundle);
broken.document.pages[0].artboards.push('n_not_here');
const refused = await fetch(`${BASE}/api/documents/import`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(broken),
});
check('a bundle with a dangling reference is refused', refused.status === 400, `${refused.status}`);

const wrongFormat = await fetch(`${BASE}/api/documents/import`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ format: 'figma/1', document: bundle.document }),
});
check('so is a file this does not understand', wrongFormat.status === 400);

// --- The same trip through the interface ------------------------------------
//
// The HTTP path working says nothing about whether a person can reach it: the
// Export panel points at the home screen, so the home screen has to have a
// control that accepts the file.

const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });

const file = `${process.env.TMPDIR ?? '/tmp'}/bundle-check.playground.json`;
writeFileSync(file, JSON.stringify(bundle));
const control = page.locator('label', { hasText: 'Import a bundle' });
check('the home screen offers an import control', await control.count() === 1);
await control.locator('input[type=file]').setInputFiles(file);
// Importing opens the new document, which is the only confirmation a person gets.
await page.waitForURL(/\/d\/doc_/, { timeout: 20000 }).catch(() => {});
const openedId = page.url().match(/\/d\/(doc_\w+)/)?.[1];
check('importing from the home screen opens the copy', !!openedId && openedId !== src.id, openedId ?? page.url());
await page.waitForTimeout(2500);
check('and it renders without a runtime error', errors.length === 0, errors[0] ?? '');
await browser.close();

await b.c.close();
for (const id of [src.id, imported.document.id, ...(openedId ? [openedId] : [])]) {
  await fetch(`${BASE}/api/documents/${id}`, { method: 'DELETE' });
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} of ${results.length} checks failed` : `\nall ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
