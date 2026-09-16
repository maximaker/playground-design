/**
 * Publishing a document as a page on the web.
 *
 *   node scripts/publish-check.mjs [base]
 *
 * The interesting assertions are about what a *stranger* gets: no account, a
 * page that is responsive rather than a 1,440px slab, and a real 404 once the
 * link is withdrawn — this route sits in front of the single-page app, so the
 * first version answered 200 with the editor shell and an unpublished link
 * looked like a page that had lost its content.
 */

import { rawFetch, signedOutPage } from './lib/session.mjs';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = process.argv[2] ?? 'http://localhost:4000';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
};

const stamp = Date.now().toString(36);
const doc = (await (await fetch(`${BASE}/api/documents`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: `Publish check ${stamp}` }),
})).json()).document;

const raw = await (await fetch(`${BASE}/api/documents/${doc.id}/connections`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'publish check' }),
})).text();
const client = new Client({ name: 'publish-check', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/${raw.match(/\/mcp\/([A-Z0-9-]+)/)[1]}`)));
const call = async (n, a = {}) => {
  const r = await client.callTool({ name: n, arguments: a });
  const t = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r.isError) throw new Error(`${n}: ${t}`);
  return t;
};

// A page with a media query in it, so "responsive" is a real claim.
const board = JSON.parse(await call('get_basic_info')).artboards[0];
await call('write_html', {
  targetId: board.id, mode: 'replace-children',
  html: `<style>
    .row { display: flex; flex-direction: row; gap: 24px; }
    @media (max-width: 700px) { .row { flex-direction: column; } .title { font-size: 32px; } }
  </style>
  <div style="padding:64px;display:flex;flex-direction:column;gap:32px;background:#fff;font-family:'Fraunces',Georgia,serif">
    <h1 class="title" style="margin:0;font-size:64px">A published page</h1>
    <div class="row" data-check="row">
      <div style="flex:1;padding:24px;border-radius:16px;background:#f4f4f5">One</div>
      <div style="flex:1;padding:24px;border-radius:16px;background:#f4f4f5">Two</div>
    </div>
  </div>`,
});

// --- Publishing over MCP -------------------------------------------------------

check('a document starts unpublished', JSON.parse(await call('get_publication')).published === false);

const published = JSON.parse(await call('publish_page', {
  slug: `check-${stamp}`, description: 'A page published by the check.',
}));
check('an agent can publish it', !!published.url, published.url);

const anonymous = await rawFetch(published.url);
const html = await anonymous.text();
check('a stranger with no account gets the page', anonymous.ok, `${anonymous.status}`);
check('and it is a page, not the editor',
  !html.includes('id="root"') && html.includes('A published page'));
/*
 * A published page is set in the design's own typefaces.
 *
 * This file used to name Inter and IBM Plex Mono in the head whatever the
 * document was set in, so a page designed in Fraunces published in Inter — the
 * one thing a designer checks first, wrong on every published page.
 */
const publishedHtml = await (await rawFetch(published.url)).text();
check('the fonts are the ones the design uses',
  /fonts\.googleapis[^"']*Fraunces/.test(publishedHtml), (/href="(https:\/\/fonts[^"]*)"/.exec(publishedHtml) ?? [])[1] ?? 'no font link');
check('and no others are requested',
  !/family=Inter/.test(publishedHtml));

check('with the document name as its title',
  html.includes(`<title>Publish check ${stamp}</title>`),
  html.match(/<title>[^<]*<\/title>/)?.[0]);
check('and the description in its metadata', html.includes('A page published by the check.'));

// --- What it looks like ---------------------------------------------------------

const browser = await chromium.launch({ headless: true });
const errors = [];
for (const [width, expectColumn] of [[1280, false], [420, true]]) {
  const page = await signedOutPage(browser, { viewport: { width, height: 900 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(published.url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  const m = await page.evaluate(() => {
    // Marked in the source: picking "the first flex div with two children"
    // found the outer column wrapper and reported it as a stacked row.
    const row = document.querySelector('[data-check="row"]');
    return {
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      pageWidth: Math.round(document.body.firstElementChild.getBoundingClientRect().width),
      stacked: row ? getComputedStyle(row).flexDirection === 'column' : null,
      chrome: !!document.querySelector('.topbar, .rail, #root'),
    };
  });
  check(`at ${width}px the page fills the window and does not overflow`,
    !m.overflow && Math.abs(m.pageWidth - width) < 2, `${m.pageWidth}px`);
  check(`at ${width}px the document's own media query ${expectColumn ? 'stacks' : 'does not stack'} it`,
    m.stacked === expectColumn, `flex-direction ${m.stacked ? 'column' : 'row'}`);
  check(`at ${width}px there is no editor chrome`, !m.chrome);
  if (width === 420) await page.screenshot({ path: '/tmp/published-phone.png' });
  await page.close();
}

// --- Taking it down ---------------------------------------------------------------

const moved = JSON.parse(await call('publish_page', { slug: `moved-${stamp}` }));
check('republishing at a new address works', moved.url.endsWith(`moved-${stamp}`), moved.url);
check('and the old address stops working',
  (await rawFetch(published.url)).status === 404, `${(await rawFetch(published.url)).status}`);

const down = JSON.parse(await call('unpublish_page'));
check('unpublishing reports where it was', down.published === false && !!down.wasAt);
const after = await rawFetch(moved.url);
check('and the link is a real 404, not the app shell',
  after.status === 404 && !(await after.text()).includes('id="root"'), `${after.status}`);

check('no runtime errors', errors.length === 0, errors[0] ?? '');
await browser.close();
await client.close();
await fetch(`${BASE}/api/documents/${doc.id}`, { method: 'DELETE' });

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} of ${results.length} checks failed` : `\nall ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
