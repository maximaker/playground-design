/**
 * The library: thumbnails, the column grid, and the controls above it.
 *
 * The grid part is the one that needs a machine. "Aligned to a grid" is easy to
 * approximate by eye and easy to lose on the next change — so the check
 * computes where the twelve column lines actually are and asserts that the
 * header, the kit strip, the sidebar, the toolbar and every card start exactly
 * on one, at every width.
 *
 *   node scripts/dashboard-check.mjs [base]
 */

import './lib/session.mjs';
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://localhost:4000';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
};

// A document with something in it, so there is a thumbnail worth rendering.
const made = await (await fetch(`${BASE}/api/documents`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: 'Dashboard check',
    html: `<div style="padding:64px;display:flex;flex-direction:column;gap:24px;background:#fff">
             <h1 style="margin:0;font-size:56px">A page with a picture</h1>
             <p style="margin:0;font-size:20px;color:#666">Enough content to see in a thumbnail.</p>
             <div style="height:220px;border-radius:20px;background:#1c1c1c"></div>
           </div>`,
  }),
})).json();
const docId = made.document.id;

// --- The thumbnail --------------------------------------------------------

const first = await fetch(`${BASE}/api/documents/${docId}/thumbnail`);
const bytes = Buffer.from(await first.arrayBuffer());
check('a document renders a thumbnail', first.ok && bytes.length > 2000,
  `${first.status} ${(bytes.length / 1024).toFixed(0)}KB ${first.headers.get('content-type')}`);
// A JPEG starts FF D8 FF. A 200 that is actually an error page would pass a
// length test and fail here.
check('and it is really an image', bytes[0] === 0xff && bytes[1] === 0xd8);

const t0 = Date.now();
const again = await fetch(`${BASE}/api/documents/${docId}/thumbnail`);
await again.arrayBuffer();
const warm = Date.now() - t0;
check('the second request comes from cache', warm < 150, `${warm}ms`);

const etag = first.headers.get('etag');
const revalidated = await fetch(`${BASE}/api/documents/${docId}/thumbnail`, {
  headers: { 'if-none-match': etag ?? '' },
});
check('an unchanged document answers 304', revalidated.status === 304, `${revalidated.status}`);

// --- The grid --------------------------------------------------------------

const browser = await chromium.launch({ headless: true });
const errors = [];

/** Where the twelve column lines are, computed from the container itself. */
const measure = (page) => page.evaluate(() => {
  const home = document.querySelector('.home');
  const cs = getComputedStyle(home);
  const box = home.getBoundingClientRect();
  const left = box.left + parseFloat(cs.paddingLeft);
  const inner = box.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const gap = parseFloat(cs.columnGap);
  const col = (inner - 11 * gap) / 12;
  const lines = Array.from({ length: 12 }, (_, i) => left + i * (col + gap));
  const edges = (sel) => [...new Set([...document.querySelectorAll(sel)]
    .map((e) => e.getBoundingClientRect().left))];
  const worst = (xs) => Math.max(0, ...xs.map((x) =>
    Math.min(...lines.map((l) => Math.abs(l - x)))));
  return {
    offsets: {
      header: worst(edges('.home-head')),
      kits: worst(edges('.starter')),
      sidebar: worst(edges('.library-nav')),
      toolbar: worst(edges('.library-docs-head')),
      cards: worst(edges('.home-card')),
    },
    perRow: (() => {
      const cards = [...document.querySelectorAll('.home-card')];
      if (!cards.length) return 0;
      const top = Math.min(...cards.map((c) => c.getBoundingClientRect().top));
      return cards.filter((c) => Math.abs(c.getBoundingClientRect().top - top) < 2).length;
    })(),
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  };
});

for (const [width, expectPerRow] of [[1440, 3], [1024, 2], [430, 1]]) {
  const page = await browser.newPage({ viewport: { width, height: 950 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.home-card', { timeout: 15000 });
  await page.waitForTimeout(700);
  const m = await measure(page);
  const worst = Math.max(...Object.values(m.offsets));
  check(`at ${width}px every band starts on a column line`, worst < 1.5,
    Object.entries(m.offsets).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', '));
  check(`at ${width}px the cards run ${expectPerRow} to a row`, m.perRow === expectPerRow, `${m.perRow}`);
  check(`at ${width}px nothing overflows sideways`, !m.overflow);
  if (width === 1440) {
    await page.waitForTimeout(2500);
    const shown = await page.evaluate(() =>
      [...document.querySelectorAll('.home-card-shot')].filter((i) => i.complete && i.naturalWidth > 0).length);
    check('thumbnails appear on the cards', shown > 0, `${shown} loaded`);
  }
  await page.close();
}

// --- The controls -----------------------------------------------------------

const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await page.waitForSelector('.home-card');
const total = await page.locator('.home-card').count();
await page.fill('.library-search input', 'Dashboard check');
await page.waitForTimeout(400);
check('search narrows the library', await page.locator('.home-card').count() < total,
  `${total} → ${await page.locator('.home-card').count()}`);
await page.fill('.library-search input', '');
await page.waitForTimeout(300);

await page.selectOption('.library-sort select', 'name');
await page.waitForTimeout(300);
const names = await page.$$eval('.home-card h3', (els) => els.map((e) => e.textContent ?? ''));
check('sorting by name orders them', names.join('|') === [...names].sort((a, b) => a.localeCompare(b)).join('|'),
  names.slice(0, 3).join(', '));

await page.click('.library-view button[aria-label="List view"]');
await page.waitForTimeout(300);
check('the list view drops the pictures',
  (await page.locator('.home-list').count()) === 1
  && !(await page.locator('.home-list .home-card-shot').first().isVisible().catch(() => false)));

await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(800);
check('and is remembered', (await page.locator('.home-list').count()) === 1);
await page.click('.library-view button[aria-label="Grid view"]');

check('no runtime errors', errors.length === 0, errors[0] ?? '');
await browser.close();
await fetch(`${BASE}/api/documents/${docId}`, { method: 'DELETE' });

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} of ${results.length} checks failed` : `\nall ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
