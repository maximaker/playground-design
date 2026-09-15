/**
 * An artboard that leaves the viewport and comes back must render again.
 *
 * Offscreen artboards drop their iframe — that is the mitigation against
 * iframe-per-artboard memory — and when they come back they mount a *new* one.
 * The setup effect was keyed to the artboard id alone, so it never ran for that
 * second frame: the portal went on writing into the body of the document that
 * had just been discarded and the artboard stayed blank for the rest of the
 * session. On a ten-slide deck that meant eight blank frames.
 *
 *   node scripts/artboard-remount-check.mjs [base]
 */

import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = process.argv[2] ?? 'http://localhost:4000';
const SLIDES = 8;
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
};

const doc = (await (await fetch(`${BASE}/api/documents`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Remount check' }),
})).json()).document;

const raw = await (await fetch(`${BASE}/api/documents/${doc.id}/connections`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'remount check' }),
})).text();
const client = new Client({ name: 'remount-check', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/${raw.match(/\/mcp\/([A-Z0-9-]+)/)[1]}`)));
const call = async (n, a = {}) => {
  const r = await client.callTool({ name: n, arguments: a });
  const t = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r.isError) throw new Error(`${n}: ${t}`);
  return t;
};

// The starter artboard is empty, and an empty frame is indistinguishable from
// an unrendered one by the only measure available here.
const starter = JSON.parse(await call('get_basic_info')).artboards.map((b) => b.id);
if (starter.length) await call('delete_nodes', { ids: starter });

// A long row, so that fitting them all is far enough out that most were never
// near the viewport at load — which is the state the bug needed.
for (let i = 0; i < SLIDES; i++) {
  const board = JSON.parse(await call('create_artboard', {
    name: `Slide ${i + 1}`, width: 1920, height: 1080, x: i * 2080, y: 0,
  }));
  await call('write_html', {
    targetId: board.id, mode: 'replace-children',
    html: `<div style="padding:80px"><h1 style="font-size:96px;margin:0">Slide ${i + 1}</h1></div>`,
  });
}
await client.close();

const browser = await chromium.launch({ headless: true });
const view = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await view.goto(`${BASE}/d/${doc.id}`, { waitUntil: 'networkidle' });
await view.waitForSelector('.artboard-frame iframe', { timeout: 30000 });

/** Characters of text inside each live frame, by artboard name. */
const filled = () => view.evaluate(() => Object.fromEntries(
  [...document.querySelectorAll('.artboard-frame iframe')].map((f) =>
    [f.title, (f.contentDocument?.body?.textContent ?? '').trim().length])));

const settle = async () => { await view.keyboard.press('Shift+1'); await view.waitForTimeout(4000); };

await settle();
const first = await filled();
check('fitting the page renders every artboard',
  Object.keys(first).length === SLIDES && Object.values(first).every((n) => n > 0),
  Object.entries(first).filter(([, n]) => !n).map(([k]) => k).join(', ') || `${SLIDES}/${SLIDES}`);

// Pan far enough that every frame unmounts, then come back. A blank frame here
// is the regression: the artboards are mounted, they simply never re-init.
await view.mouse.move(750, 500);
for (let i = 0; i < 8; i++) { await view.mouse.wheel(1500, 0); await view.waitForTimeout(250); }
await view.waitForTimeout(1500);
const away = await filled();
check('panning away drops the frames', Object.keys(away).length < SLIDES,
  `${Object.keys(away).length} still live`);

await settle();
const back = await filled();
check('coming back renders them again',
  Object.keys(back).length === SLIDES && Object.values(back).every((n) => n > 0),
  Object.entries(back).filter(([, n]) => !n).map(([k]) => k).join(', ') || `${SLIDES}/${SLIDES}`);
check('with the same content as before',
  JSON.stringify(back) === JSON.stringify(first));

await browser.close();
await fetch(`${BASE}/api/documents/${doc.id}`, { method: 'DELETE' });

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} of ${results.length} checks failed` : `\nall ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
