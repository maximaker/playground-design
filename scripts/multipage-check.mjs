/**
 * Does a bundle carry a document with more than one page?
 *
 * Pages are the part of the model most easily lost in a copy: they are a list
 * beside the node map rather than nodes themselves, each naming its artboards by
 * id. A copy that drops a page, or keeps the page but loses which artboards
 * belong to it, still opens — it just quietly shows fewer screens.
 *
 *   node scripts/multipage-check.mjs [fromBase] [toBase]
 *
 * With two bases it exports from one instance and imports into the other, which
 * is the trip that matters; with one it round-trips locally.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const FROM = process.argv[2] ?? 'http://localhost:4000';
const TO = process.argv[3] ?? FROM;
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
};

async function connect(base, docId) {
  const raw = await (await fetch(`${base}/api/documents/${docId}/connections`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'multipage check' }),
  })).text();
  const c = new Client({ name: 'multipage-check', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(
    new URL(`${base}/mcp/${raw.match(/\/mcp\/([A-Z0-9-]+)/)[1]}`)));
  return { c, call: async (n, a = {}) => {
    const r = await c.callTool({ name: n, arguments: a });
    const t = r.content.filter((x) => x.type === 'text').map((x) => x.text).join('\n');
    if (r.isError) throw new Error(`${n}: ${t}`);
    return t;
  }};
}

const id = () => Math.random().toString(36).slice(2, 10);

// --- A document with three pages -------------------------------------------

const src = (await (await fetch(`${FROM}/api/documents`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Multipage source' }),
})).json()).document;

const extra = [
  { id: `p_${id()}`, name: 'Marketing', artboards: [] },
  { id: `p_${id()}`, name: 'App', artboards: [] },
];
await fetch(`${FROM}/api/documents/${src.id}/ops`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ops: extra.map((page) => ({
    op: { t: 'page', action: 'add', page }, origin: { kind: 'system', id: 'multipage-check' },
  }))}),
});

const a = await connect(FROM, src.id);
const pages = JSON.parse(await a.call('get_basic_info')).pages;
check('the source has three pages', pages.length === 3, pages.map((p) => p.name).join(', '));

// Each page gets its own artboard with its own content, so a page that arrives
// holding the wrong artboards is visible rather than merely miscounted.
for (const [i, page] of pages.entries()) {
  const board = JSON.parse(await a.call('create_artboard', {
    name: `${page.name} — board`, width: 800 + i * 100, height: 500, pageId: page.id,
  }));
  await a.call('write_html', {
    targetId: board.id, mode: 'replace-children',
    html: `<div style="padding:40px"><h1 style="margin:0">${page.name}</h1><p>Page ${i + 1} of 3.</p></div>`,
  });
}

const srcPages = JSON.parse(await a.call('get_basic_info')).pages;
const srcDoc = (await (await fetch(`${FROM}/api/documents/${src.id}`)).json()).document;
await a.c.close();

// Page → the text on that page's artboard. Comparing this rather than ids is
// what catches artboards arriving under the wrong page.
const shape = (doc) => doc.pages.map((p) => {
  const texts = [];
  const walk = (nid) => {
    const n = doc.nodes[nid];
    if (!n) return;
    if (typeof n.text === 'string' && n.text.trim()) texts.push(n.text.trim());
    for (const child of n.children ?? []) walk(child);
  };
  for (const board of p.artboards) walk(board);
  return `${p.name}: [${p.artboards.map((b) => doc.nodes[b]?.name ?? '???').join(', ')}] ${texts.join(' / ')}`;
});
console.log('  source shape:');
for (const line of shape(srcDoc)) console.log(`    ${line}`);

// --- Through the bundle ------------------------------------------------------

const bundle = await (await fetch(`${FROM}/api/documents/${src.id}/bundle`)).json();
check('every page is in the bundle', bundle.document.pages.length === 3,
  bundle.document.pages.map((p) => p.name).join(', '));

const res = await fetch(`${TO}/api/documents/import?name=Multipage%20copy`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bundle),
});
const imported = await res.json();
check('it imports', res.ok, res.ok ? '' : JSON.stringify(imported).slice(0, 200));
if (!res.ok) process.exit(1);

const dstDoc = (await (await fetch(`${TO}/api/documents/${imported.document.id}`)).json()).document;
check('all three pages arrive', dstDoc.pages.length === srcPages.length,
  `${srcPages.length} → ${dstDoc.pages.length}`);
check('in the same order, with their names',
  dstDoc.pages.map((p) => p.name).join(' | ') === srcPages.map((p) => p.name).join(' | '),
  dstDoc.pages.map((p) => p.name).join(' | '));
check('each page keeps its own artboards and their content',
  shape(dstDoc).join('\n') === shape(srcDoc).join('\n'));
if (shape(dstDoc).join('\n') !== shape(srcDoc).join('\n')) {
  console.log('  copy shape:');
  for (const line of shape(dstDoc)) console.log(`    ${line}`);
}
check('and no node is orphaned from a page',
  Object.values(dstDoc.nodes).filter((n) => n.type === 'artboard')
    .every((n) => dstDoc.pages.some((p) => p.artboards.includes(n.id))));

// The editor reads currentPage; a copy pointing at a page id that no longer
// exists opens on nothing.
const b = await connect(TO, imported.document.id);
const info = JSON.parse(await b.call('get_basic_info'));
check('the current page is one the copy actually has',
  dstDoc.pages.some((p) => p.id === info.currentPage), info.currentPage);

// Reading the last page's own artboard back is the closest thing to a person
// clicking that page tab.
const last = dstDoc.pages.at(-1);
const tree = await b.call('get_tree_summary', { id: last.artboards[0], depth: 4 });
check('a later page reads back with its own content', tree.includes(last.name),
  tree.split('\n')[0]?.slice(0, 70));
await b.c.close();

// --- And in the editor -------------------------------------------------------
//
// The model being right is not the same as the pages being reachable: the copy
// has to list all three in the rail and switch between them.

const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true });
const view = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [];
view.on('pageerror', (e) => errors.push(e.message));
await view.goto(`${TO}/d/${imported.document.id}`, { waitUntil: 'networkidle' });
await view.waitForSelector('.artboard-frame iframe', { timeout: 30000 });
await view.click('.rail-tabs button[aria-label="Pages"]');
await view.waitForTimeout(600);
// Each row is the page name followed by its artboard count, so match by prefix.
const rows = await view.$$eval('.page-row', (els) => els.map((e) => e.textContent.trim()));
check('the editor lists every page',
  rows.length === 3 && dstDoc.pages.every((p, i) => rows[i].startsWith(p.name)), rows.join(' | '));

await view.locator('.page-row', { hasText: last.name }).click();
await view.waitForTimeout(1500);
await view.keyboard.press('Shift+1');
await view.waitForTimeout(2500);
const shown = await view.evaluate(() =>
  [...document.querySelectorAll('.artboard-frame iframe')].map((f) => f.title));
check('switching page shows that page\'s artboards',
  shown.length === last.artboards.length &&
  shown.every((t) => last.artboards.some((id) => dstDoc.nodes[id]?.name === t)), shown.join(', '));
const heading = await view.evaluate(() =>
  [...document.querySelectorAll('.artboard-frame iframe')].pop()?.contentDocument?.querySelector('h1')?.textContent ?? null);
check('and renders that page\'s own content', heading === last.name, heading ?? '(nothing)');
check('with no runtime error', errors.length === 0, errors[0] ?? '');
await browser.close();

if (process.env.KEEP !== '1') {
  await fetch(`${FROM}/api/documents/${src.id}`, { method: 'DELETE' });
  await fetch(`${TO}/api/documents/${imported.document.id}`, { method: 'DELETE' });
} else {
  console.log(`\n  kept: ${FROM}/d/${src.id} → ${TO}/d/${imported.document.id}`);
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} of ${results.length} checks failed` : `\nall ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
