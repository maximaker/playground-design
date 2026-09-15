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
check('the left rail is the document and nothing else',
  leftTabs.join(',') === 'Layers,Pages,Components,Tokens', leftTabs.join(', '));
const rightTabs = await page.$$eval('.rail-right .rail-tabs button',
  (els) => els.map((e) => e.getAttribute('aria-label')));
check('the right rail is how you are looking at it',
  rightTabs.join(',') === 'Design,Spec,Comments,Review', rightTabs.join(', '));
check('and both rails use the same tab style',
  (await page.locator('.rail-left .rail-tabs').count()) === 1
  && (await page.locator('.rail-right .rail-tabs').count()) === 1);

const headings = await page.$$eval('.rail-heading', (els) => els.map((e) => e.textContent));
check('each rail names the panel it is showing', headings.length === 2, headings.join(' | '));
check('and the lenses are no longer on the left',
  !leftTabs.some((t) => ['Spec', 'Comments', 'Review', 'History'].includes(t ?? '')),
  leftTabs.join(', '));

const nodeId = await page.evaluate(() => {
  const d = window.__playground.store.getState().doc;
  return Object.values(d.nodes).find((n) => n.tag === 'h1')?.id;
});
await page.evaluate((id) => window.__playground.store.getState().select([id]), nodeId);
await page.waitForTimeout(400);
await page.click('.rail-right .rail-tabs button[aria-label="Spec"]');
await page.waitForTimeout(600);
check('switching to Spec inspects the same selection',
  (await page.locator('.rail-right .prop-header').innerText()).includes('×'),
  (await page.locator('.rail-right .prop-header').innerText()).replace(/\n/g, ' · '));
await page.click('.rail-right .rail-tabs button[aria-label="Design"]');

// --- The lenses ------------------------------------------------------------------

await page.click('.rail-right .rail-tabs button[aria-label="Review"]');
await page.waitForTimeout(2500);
check('opening Review outlines what it found',
  (await page.locator('.overlay-highlight.is-review').count()) >= 2,
  `${await page.locator('.overlay-highlight.is-review').count()} outlined`);

await page.click('.rail-right .rail-tabs button[aria-label="Design"]');
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
await page.click('.rail-right .rail-tabs button[aria-label="Comments"]');
await page.waitForTimeout(800);
check('opening Comments outlines the layers people wrote about',
  (await page.locator('.overlay-highlight.is-comments').count()) === 1,
  `${await page.locator('.overlay-highlight.is-comments').count()} outlined`);

// A checkpoint, a change, then the comparison lens.
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
await page.click('.history-bar-strip');
await page.waitForTimeout(900);
await page.locator('.history-row button', { hasText: 'Compare' }).first().click();
await page.waitForTimeout(1200);
check('comparing a version outlines what moved',
  (await page.locator('.overlay-highlight.is-changes').count()) >= 1,
  `${await page.locator('.overlay-highlight.is-changes').count()} outlined`);
check('the three lenses are told apart by colour and by kind',
  (await page.locator('.overlay-highlight.is-review').count()) === 0
  && (await page.locator('.overlay-highlight.is-comments').count()) === 0);

// --- Knowing what you are about to select -------------------------------------
//
// A plain click takes the outermost layer inside the artboard, which is right —
// and leaves "did I select the thing I pointed at?" unanswered in a deep tree.

const deep = await page.evaluate(() => {
  const d = window.__playground.store.getState().doc;
  const p = Object.values(d.nodes).find((n) => n.tag === 'p');
  return p ? { id: p.id, name: p.name } : null;
});
const at = await page.evaluate((id) => {
  for (const f of document.querySelectorAll('.artboard-frame iframe')) {
    const el = f.contentDocument?.querySelector(`[data-node-id="${id}"]`);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    const box = f.getBoundingClientRect();
    const scale = box.width / (f.offsetWidth || box.width || 1);
    return { x: box.left + (r.left + r.width / 2) * scale, y: box.top + (r.top + r.height / 2) * scale };
  }
  return null;
}, deep.id);

await page.mouse.move(at.x, at.y);
await page.waitForTimeout(600);
const hoverBadge = (await page.locator('.overlay-tag.is-hover').innerText()).replace(/\n/g, ' ');
check('hovering names what a click would select', hoverBadge.length > 0, hoverBadge);
check('and offers the modifier that reaches the layer under the pointer',
  hoverBadge.includes('⌘') && hoverBadge.includes(deep.name), hoverBadge);

await page.mouse.click(at.x, at.y);
await page.waitForTimeout(500);
check('the selection is named on the canvas too',
  (await page.locator('.overlay-tag.is-selected').count()) === 1,
  await page.locator('.overlay-tag.is-selected').innerText());

await page.keyboard.down('Meta');
await page.mouse.click(at.x, at.y);
await page.keyboard.up('Meta');
await page.waitForTimeout(500);
check('⌘-click reaches the layer itself',
  (await page.locator('.overlay-tag.is-selected').innerText()).includes(deep.name),
  await page.locator('.overlay-tag.is-selected').innerText());

// The breadcrumb belongs to the panels that are about the selection, so switch
// back to one of them before looking for it.
await page.click('.rail-right .rail-tabs button[aria-label="Design"]');
await page.waitForTimeout(400);
const crumbs = await page.$$eval('.crumbs button', (els) => els.map((e) => e.textContent?.trim()));
check('and the inspector shows the path to it', crumbs.length >= 3, crumbs.join(' › '));

// Climbing back up by clicking a crumb.
await page.locator('.crumbs button').first().click();
await page.waitForTimeout(400);
check('clicking a crumb selects that ancestor',
  !(await page.locator('.overlay-tag.is-selected').innerText()).includes(deep.name));

// And the layer tree does not make you go looking for the row.
await page.evaluate((id) => window.__playground.store.getState().select([id]), deep.id);
await page.waitForTimeout(700);
const row = await page.evaluate((id) => {
  const el = document.querySelector(`.layer-row[data-layer-id="${id}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const rail = document.querySelector('.rail-left').getBoundingClientRect();
  return { selected: el.className.includes('is-selected'), inView: r.top >= rail.top - 1 && r.bottom <= rail.bottom + 1 };
}, deep.id);
check('selecting on the canvas reveals the row in the layer tree',
  !!row?.selected && !!row?.inView, JSON.stringify(row));

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
  (await viewer.locator('.rail-right .rail-tabs button[aria-label="Spec"][aria-pressed="true"]').count()) === 1);
await viewer.close();

// Undo and redo belong to the canvas, so they are in its toolbar.
const undoPlacement = await (async () => {
  const again = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  again.on('pageerror', (e) => errors.push(e.message));
  await again.goto(`${BASE}/d/${doc.id}`, { waitUntil: 'networkidle' });
  await again.waitForSelector('.artboard-frame iframe', { timeout: 30000 });
  await again.waitForTimeout(1000);
  const out = {
    inToolbar: await again.locator('.toolbar button[aria-label="Undo"]').count(),
    inTopbar: await again.locator('.topbar button[aria-label="Undo"]').count(),
    // The bottom stack keeps them apart however tall the history bar gets.
    clearOfHistory: await again.evaluate(() => {
      const t = document.querySelector('.toolbar')?.getBoundingClientRect();
      const h = document.querySelector('.history-bar')?.getBoundingClientRect();
      return !!t && !!h && t.bottom <= h.top + 1;
    }),
  };
  await again.click('.history-bar-strip');
  await again.waitForTimeout(600);
  out.clearWhenOpen = await again.evaluate(() => {
    const t = document.querySelector('.toolbar')?.getBoundingClientRect();
    const h = document.querySelector('.history-bar')?.getBoundingClientRect();
    return !!t && !!h && t.bottom <= h.top + 1;
  });
  await again.close();
  return out;
})();
check('undo and redo sit with the tools, not in the topbar corner',
  undoPlacement.inToolbar === 1 && undoPlacement.inTopbar === 0, JSON.stringify(undoPlacement));
check('and the toolbar stays clear of the history bar, open or closed',
  undoPlacement.clearOfHistory && undoPlacement.clearWhenOpen);

check('no runtime errors', errors.length === 0, errors[0] ?? '');
await browser.close();
await fetch(`${BASE}/api/documents/${doc.id}`, { method: 'DELETE' });

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} of ${results.length} checks failed` : `\nall ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
