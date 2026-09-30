/**
 * Photographs the editor in its main states, full resolution, for a UX walk.
 *   node tour.mjs <outdir> [docId] [base]
 */
import '../lib/session.mjs';
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2];
const DOC = process.argv[3] ?? 'doc_fcufdns1cs';
const BASE = process.argv[4] ?? 'http://localhost:4000';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const shot = async (name) => { await page.waitForTimeout(350); await page.screenshot({ path: `${OUT}/${name}.png` }); console.log(name); };
const state = () => page.evaluate(() => window.__playground.store.getState());

await page.goto(`${BASE}/d/${DOC}`, { waitUntil: 'networkidle' });
await page.waitForSelector('.artboard-frame iframe', { timeout: 20000 });
await page.waitForTimeout(800);
await shot('01-open');
await page.keyboard.press('1');
await shot('02-fit');

// Select the first artboard, then a layer inside it.
await page.evaluate(() => {
  const s = window.__playground.store.getState();
  const pg = s.doc.pages.find((p) => p.id === s.pageId);
  s.select([pg.artboards[0]]);
});
await shot('03-artboard-selected');
await page.evaluate(() => {
  const s = window.__playground.store.getState();
  const pg = s.doc.pages.find((p) => p.id === s.pageId);
  const kids = s.doc.nodes[pg.artboards[0]].children;
  s.select([kids[0]]);
});
await shot('04-layer-selected');
await page.mouse.click(760, 450, { button: 'right' });
await shot('05-context-menu');
await page.keyboard.press('Escape');

// Board shape and connector.
await page.evaluate(() => {
  const s = window.__playground.store.getState();
  const pg = s.doc.pages.find((p) => p.id === s.pageId);
  const shape = (pg.board ?? []).find((i) => i.type === 'shape' && i.kind !== 'section');
  if (shape) s.selectBoard([shape.id]);
});
await shot('06-board-shape');
await page.evaluate(() => {
  const s = window.__playground.store.getState();
  const pg = s.doc.pages.find((p) => p.id === s.pageId);
  const c = (pg.board ?? []).find((i) => i.type === 'connector');
  if (c) s.selectBoard([c.id]);
});
await shot('07-board-connector');
await page.keyboard.press('Escape');

// Toolbar flyout.
await page.hover('.tool-group.has-more:nth-of-type(3) button');
await page.waitForTimeout(500);
await shot('08-flyout');
await page.mouse.move(700, 300);

// Modals and palette.
await page.keyboard.press('Meta+k'); await shot('09-palette'); await page.keyboard.press('Escape');
await page.keyboard.press('?'); await shot('10-shortcuts'); await page.keyboard.press('Escape'); await page.waitForTimeout(150); if (await page.locator('.modal-backdrop').count()) { console.log('  escape did not close shortcuts'); await page.mouse.click(5, 5); }
for (const [label, name] of [['Share', '11-share'], ['Export', '12-export'], ['Import', '13-import'], ['Connect agent', '14-connect']]) {
  const b = page.locator(`.topbar button:has-text("${label}")`).first();
  if (await b.count()) { await b.click(); await shot(name); await page.keyboard.press('Escape'); await page.waitForTimeout(150); if (await page.locator('.modal-backdrop').count()) { console.log('  escape did not close', name); await page.mouse.click(5, 5); } await page.waitForTimeout(200); }
}

// Rails.
const leftTabs = page.locator('.rail-left .rail-tabs button');
for (let i = 1; i < await leftTabs.count(); i++) { await leftTabs.nth(i).click(); await shot(`16-left-${i}`); }
await leftTabs.nth(0).click();
const rightTabs = page.locator('.rail-right .rail-tabs button');
for (let i = 1; i < await rightTabs.count(); i++) { await rightTabs.nth(i).click(); await shot(`17-right-${i}`); }
await rightTabs.nth(0).click();

// Empty page.
await page.evaluate(() => { const s = window.__playground.store.getState(); s.select([]); s.selectBoard([]); });
await page.locator('.rail-left .rail-tabs button').nth(1).click();
await shot('18-pages');

// Light theme.
await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
await shot('19-light');
await page.evaluate(() => {
  const s = window.__playground.store.getState();
  const pg = s.doc.pages.find((p) => p.id === s.pageId);
  s.select([s.doc.nodes[pg.artboards[0]].children[0]]);
});
await shot('20-light-layer');
await page.mouse.click(760, 450, { button: 'right' }); await shot('21-light-context'); await page.keyboard.press('Escape');
await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });

// Smaller screens.
await page.setViewportSize({ width: 1000, height: 700 }); await page.waitForTimeout(400); await shot('22-compact');
await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(400); await shot('23-phone');
await page.locator('.topbar .panel-toggle').first().click().catch(() => {}); await shot('24-phone-left');

// Home.
await page.setViewportSize({ width: 1440, height: 900 });
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' }); await shot('25-home');
await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; }); await shot('26-home-light');
await browser.close();
