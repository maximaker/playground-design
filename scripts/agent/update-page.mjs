/**
 * Rewrites the landing page inside a document that already exists.
 *
 * build.mjs always creates a new document, which is wrong once a URL has been
 * shared: the fix has to land where people are already looking. This replaces
 * the page in the 1440 artboard, refreshes the two copies from it, and refits
 * every height — reading the result back rather than assuming the writes took.
 *
 *   node scripts/agent/update-page.mjs <base> <docId>
 */
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [base, docId] = process.argv.slice(2);

const raw = await (await fetch(`${base}/api/documents/${docId}/connections`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'update' }),
})).text();
const code = raw.match(/\/mcp\/([A-Z0-9-]+)/)[1];

const client = new Client({ name: 'update', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${code}`)));
const call = async (n, a = {}) => {
  const r = await client.callTool({ name: n, arguments: a });
  const t = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r.isError) throw new Error(`${n}: ${t}`);
  return t;
};

const html = readFileSync(new URL('./page.html', import.meta.url), 'utf8');
const boards = JSON.parse(await call('get_basic_info')).artboards;
const desktop = boards.find((b) => b.name === 'Landing — 1440');
if (!desktop) throw new Error('no "Landing — 1440" artboard in this document');

await call('write_html', { targetId: desktop.id, mode: 'replace-children', html });
const pageRoot = JSON.parse(await call('get_children', { id: desktop.id }))[0];
console.log('  rewrote the 1440 page');

// The copies are exactly that. Replacing them from the original is the only way
// they stay identical; patching each one is how three artboards drift apart.
for (const name of ['Landing — 900 tablet', 'Landing — 390 phone']) {
  const board = boards.find((b) => b.name === name);
  if (!board) continue;
  const old = JSON.parse(await call('get_children', { id: board.id }));
  if (old.length) await call('delete_nodes', { ids: old.map((o) => o.id) });
  await call('duplicate_nodes', { ids: [pageRoot.id], parentId: board.id });
  console.log('  refreshed', name);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto(`${base}/d/${docId}`, { waitUntil: 'networkidle' });
await page.waitForSelector('.artboard-frame iframe', { timeout: 30000 });
await page.keyboard.press('Shift+1');
await page.waitForTimeout(4000);
const heights = await page.evaluate(() => {
  const out = {};
  for (const f of document.querySelectorAll('.artboard-frame iframe')) {
    const el = f.contentDocument?.body?.firstElementChild?.firstElementChild;
    if (el) out[f.title] = Math.ceil(el.getBoundingClientRect().height);
  }
  return out;
});
await browser.close();

const current = JSON.parse(await call('get_basic_info')).artboards;
const updates = current
  .filter((b) => heights[b.name] && b.height !== heights[b.name])
  .map((b) => ({ id: b.id, styles: { height: `${heights[b.name]}px` } }));
if (updates.length) await call('update_styles', { updates });

const after = JSON.parse(await call('get_basic_info')).artboards;
const unfitted = after.filter((b) => heights[b.name] && b.height !== heights[b.name]);
console.log('  heights:', after.map((b) => `${b.name} ${b.width}×${b.height}`).join(' | '));
if (unfitted.length) {
  console.log('  these did not take:', unfitted.map((b) => b.name).join(', '));
  process.exit(1);
}
await client.close();
