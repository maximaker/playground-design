/**
 * Renders every slide at 1920×1080 and reports the ones that overflow.
 *
 * A slide that runs past its height is a slide with a line cut off at the
 * bottom, and nothing in the model complains — the only way to know is to lay it
 * out and measure. This exports each artboard as standalone HTML and renders it
 * on its own, rather than reading the editor canvas, because the canvas keeps
 * only the artboards near the viewport live and an unrendered frame measures as
 * zero, which would pass a height test by being empty.
 *
 *   node scripts/agent/deck-check.mjs <base> <docId> [page] [outDir]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [base, docId, pageName = 'Deck', outDir = '/tmp/deck'] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

const doc = (await (await fetch(`${base}/api/documents/${docId}`)).json()).document;
const page = doc.pages.find((p) => p.name === pageName);
if (!page) throw new Error(`no page named "${pageName}"`);

const raw = await (await fetch(`${base}/api/documents/${docId}/connections`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'deck check' }),
})).text();
const client = new Client({ name: 'deck-check', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${raw.match(/\/mcp\/([A-Z0-9-]+)/)[1]}`)));
const call = async (n, a = {}) => {
  const r = await client.callTool({ name: n, arguments: a });
  const t = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r.isError) throw new Error(`${n}: ${t}`);
  return t;
};

// get_html deliberately leaves the tokens out — it emits a fragment for pasting
// into a page that already has them. Rendering it on its own means supplying the
// :root block, or every var() falls back to nothing and the slide comes out
// unstyled black-on-white, which looks exactly like a broken slide.
const root = `<style>:root{${(doc.tokens ?? [])
  .map((t) => `--${t.name.replace(/\./g, '-')}:${t.values.default};`).join('')}}
  body{margin:0}</style>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400&display=swap" rel="stylesheet">`;

const browser = await chromium.launch({ headless: true });
const view = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
let bad = 0;

for (const id of page.artboards) {
  const node = doc.nodes[id];
  const html = await call('get_html', { id, standalone: true });
  const file = `${outDir}/${node.name.replace(/[^\w]+/g, '-')}.html`;
  writeFileSync(file, `${root}\n${html}`);
  await view.goto(`file://${file}`, { waitUntil: 'networkidle' });
  const box = await view.evaluate(() => {
    const root = document.body.firstElementChild;
    return { h: Math.ceil(root?.scrollHeight ?? 0), w: Math.ceil(root?.scrollWidth ?? 0),
             text: (root?.textContent ?? '').trim().length };
  });
  const over = box.h > 1080 || box.w > 1920 || box.text === 0;
  if (over) bad++;
  console.log(`  ${over ? '✗' : '✓'} ${node.name.padEnd(22)} ${box.h}×${box.w}, ${box.text} chars`);
  await view.screenshot({ path: `${outDir}/${node.name.replace(/[^\w]+/g, '-')}.png` });
}

await browser.close();
await client.close();
console.log(bad ? `\n  ${bad} slide(s) do not fit` : `\n  all ${page.artboards.length} slides fit 1920×1080`);
console.log('  images in', outDir);
process.exit(bad ? 1 : 0);
