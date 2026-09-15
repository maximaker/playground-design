/**
 * Where the panels live, and what they point at.
 *
 *   node scripts/panels-check.mjs [base]
 *
 * Two rails, split by scope rather than by kind: the left one is about the
 * document — pages, layers, components, and the lists of things happening to it
 * — and the right one is about whatever is selected. The spec sits there beside
 * the properties because they are the same object from two sides.
 *
 * And the lists on the left are lenses: while one is open the canvas outlines
 * what it is talking about. A review that says "2 to fix" and points at nothing
 * is a list you have to click through one row at a time.
 */

import { signedOutPage } from './lib/session.mjs';
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://localhost:4000';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
};

// Something to find fault with, something to comment on, and a checkpoint to
// compare against.
const doc = (await (await fetch(`${BASE}/api/documents`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: 'Panels check',
    html: `<div style="padding:40px;background:#ffffff;display:flex;flex-direction:column;gap:20px">
      <h1 style="margin:0;font-size:40px">A page</h1>
      <p style="color:#cfcfcf;font-size:14px">Barely visible text</p>
      <p style="color:#d4d4d4;font-size:14px">Also barely visible</p>
    </div>`,
  }),
})).json()).document;

const browser = await chromium.launch({ headless: true });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/d/${doc.id}`, { waitUntil: 'networkidle' });
await page.waitForSelector('.artboard-frame iframe', { timeout: 30000 });
await page.waitForTimeout(2000);

// --- Where things are ---------------------------------------------------------

const leftTabs = await page.$$eval('.rail-left .rail-tabs button',
  (els) => els.map((e) => e.getAttribute('aria-label')));
check('the left rail is the document: structure then activity',
  leftTabs.join(',') === 'Layers,Pages,Components,Tokens,Comments,Review,History', leftTabs.join(', '));
// Geometry, not just presence: written as a horizontal rule first, it rendered
// as a stray dash floating above the row rather than as a break in it.
const divider = await page.evaluate(() => {
  const d = document.querySelector('.rail-tab-divider')?.getBoundingClientRect();
  const strip = document.querySelector('.rail-left .rail-tabs')?.getBoundingClientRect();
  if (!d || !strip) return null;
  return {
    upright: d.height > d.width,
    inside: d.top >= strip.top && d.bottom <= strip.bottom,
    centred: Math.abs((d.top + d.height / 2) - (strip.top + strip.height / 2)) < 4,
  };
});
check('with an upright break sitting in the row, not above it',
  !!divider && divider.upright && divider.inside && divider.centred, JSON.stringify(divider));

const rightTabs = await page.$$eval('.rail-switch .segmented button',
  (els) => els.map((e) => e.textContent?.trim()));
check('the right rail is the selection: design and spec',
  rightTabs.join(',') === 'Design,Spec', rightTabs.join(', '));

const heading = await page.locator('.rail-heading').innerText();
check('and the spec is no longer on the left', !leftTabs.includes('Spec') && heading !== 'Spec',
  heading);

const nodeId = await page.evaluate(() => {
  const d = window.__playground.store.getState().doc;
  return Object.values(d.nodes).find((n) => n.tag === 'h1')?.id;
});
await page.evaluate((id) => window.__playground.store.getState().select([id]), nodeId);
await page.waitForTimeout(400);
await page.click('.rail-switch .segmented button:has-text("Spec")');
await page.waitForTimeout(600);
check('switching to Spec inspects the same selection',
  (await page.locator('.rail-right .prop-header').innerText()).includes('×'),
  (await page.locator('.rail-right .prop-header').innerText()).replace(/\n/g, ' · '));
await page.click('.rail-switch .segmented button:has-text("Design")');

// --- The lenses ------------------------------------------------------------------

await page.click('.rail-left .rail-tabs button[aria-label="Review"]');
await page.waitForTimeout(2500);
check('opening Review outlines what it found',
  (await page.locator('.overlay-highlight.is-review').count()) >= 2,
  `${await page.locator('.overlay-highlight.is-review').count()} outlined`);

await page.click('.rail-left .rail-tabs button[aria-label="Layers"]');
await page.waitForTimeout(500);
check('and leaving the panel takes them away',
  (await page.locator('.overlay-highlight').count()) === 0);

// A comment, then the Comments lens.
await page.evaluate((id) => window.__playground.store.getState().select([id]), nodeId);
await page.waitForTimeout(300);
await page.keyboard.press('c');
await page.waitForTimeout(500);
await page.fill('.comment-pin.is-draft textarea', 'about this heading');
await page.keyboard.press('Enter');
await page.waitForTimeout(900);
await page.click('.rail-left .rail-tabs button[aria-label="Comments"]');
await page.waitForTimeout(800);
check('opening Comments outlines the layers people wrote about',
  (await page.locator('.overlay-highlight.is-comments').count()) === 1,
  `${await page.locator('.overlay-highlight.is-comments').count()} outlined`);

// A checkpoint, a change, then the comparison lens.
await page.click('.rail-left .rail-tabs button[aria-label="History"]');
await page.waitForTimeout(600);
await page.evaluate(async (docId) => {
  await fetch(`/api/documents/${docId}/snapshots`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'Before' }),
  });
}, doc.id);
await page.evaluate((id) => {
  const st = window.__playground.store.getState();
  st.dispatch([{ t: 'styles', updates: [{ id, styles: { 'font-size': '52px' } }] }]);
}, nodeId);
await page.waitForTimeout(800);
await page.click('.rail-left .rail-tabs button[aria-label="Layers"]');
await page.click('.rail-left .rail-tabs button[aria-label="History"]');
await page.waitForTimeout(900);
await page.locator('.history-row button', { hasText: 'Compare' }).first().click();
await page.waitForTimeout(1200);
check('comparing a version outlines what moved',
  (await page.locator('.overlay-highlight.is-changes').count()) >= 1,
  `${await page.locator('.overlay-highlight.is-changes').count()} outlined`);
check('the three lenses are told apart by colour and by kind',
  (await page.locator('.overlay-highlight.is-review').count()) === 0
  && (await page.locator('.overlay-highlight.is-comments').count()) === 0);

await page.screenshot({ path: '/tmp/panels.png' });
await page.close();

// --- The person the right rail is for ---------------------------------------------

const share = await (await fetch(`${BASE}/api/documents/${doc.id}/shares`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'panels' }),
})).json();
const viewer = await signedOutPage(browser, { viewport: { width: 1400, height: 900 } });
viewer.on('pageerror', (e) => errors.push(e.message));
await viewer.goto(share.url, { waitUntil: 'networkidle' });
await viewer.waitForSelector('.artboard-frame iframe', { timeout: 30000 });
await viewer.waitForTimeout(1200);
check('a view-only visitor lands on the spec, not on controls they cannot use',
  (await viewer.locator('.rail-switch .segmented button:has-text("Spec")[aria-pressed="true"]').count()) === 1);
await viewer.close();

check('no runtime errors', errors.length === 0, errors[0] ?? '');
await browser.close();
await fetch(`${BASE}/api/documents/${doc.id}`, { method: 'DELETE' });

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} of ${results.length} checks failed` : `\nall ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
