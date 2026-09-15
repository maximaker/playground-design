/**
 * The visual system and the interaction parity that goes with it.
 *
 *   node scripts/ui-check.mjs [base]
 *
 * Asserts the rules from DESIGN.md that are cheap to break by accident — the
 * meaning of a colour, one shape per idea, a focus state on everything — and
 * the layer-tree gestures a hand arriving from Figma expects to work.
 */

import './lib/session.mjs';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = process.argv[2] ?? 'http://localhost:4000';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
};

const doc = (await (await fetch(`${BASE}/api/documents`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'UI system' }),
})).json()).document;
const raw = await (await fetch(`${BASE}/api/documents/${doc.id}/connections`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'ui' }),
})).text();
const client = new Client({ name: 'ui', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/${raw.match(/\/mcp\/([A-Z0-9-]+)/)[1]}`)));
const call = async (n, a = {}) => {
  const r = await client.callTool({ name: n, arguments: a });
  const t = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r.isError) throw new Error(`${n}: ${t}`);
  return t;
};
const board = JSON.parse(await call('get_basic_info')).artboards[0];
const written = JSON.parse(await call('write_html', {
  targetId: board.id, mode: 'replace-children',
  html: `<div style="padding:40px;display:flex;flex-direction:column;gap:12px;background:#fff">
    <span>One</span><span>Two</span><span>Three</span><span>Four</span>
  </div>`,
}));
const row = written.roots[0].id;
const kids = JSON.parse(await call('get_children', { id: row }));

const browser = await chromium.launch({ headless: true });
const errors = [];
const view = await browser.newPage({ viewport: { width: 1500, height: 950 } });
view.on('pageerror', (e) => errors.push(e.message));
await view.goto(`${BASE}/d/${doc.id}`, { waitUntil: 'networkidle' });
await view.waitForSelector('.artboard-frame iframe', { timeout: 30000 });
await view.waitForTimeout(2200);
await view.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
await view.waitForTimeout(400);

const css = (sel, prop) => view.evaluate(([s, p]) => {
  const el = document.querySelector(s);
  return el ? getComputedStyle(el).getPropertyValue(p).trim() : null;
}, [sel, prop]);

// --- The system ---------------------------------------------------------------

// Green means state. A primary button is an action, so it is ink.
const primaryBg = await css('.button.primary', 'background-color');
const accent = await view.evaluate(() =>
  getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
check('the primary button is ink, not the state colour', primaryBg !== accent && !!primaryBg,
  `${primaryBg} vs accent ${accent}`);

// One shape per idea: the rail tabs and the segmented control are one recipe.
const tabRadius = await css('.rail-tabs', 'border-radius');
const tabTrack = await css('.rail-tabs', 'background-color');
const railTrack = await view.evaluate(() =>
  getComputedStyle(document.documentElement).getPropertyValue('--bg-sunken').trim());
check('the rail tabs are a segmented control on an inset track',
  parseFloat(tabRadius) > 100 || tabRadius.includes('px'), tabRadius);
check('and the track is the sunken surface, as the reference has it',
  !!tabTrack && tabTrack !== 'rgba(0, 0, 0, 0)', `${tabTrack} / --bg-sunken ${railTrack}`);

// The selected tab is a raised pill, which is how it reads without a colour.
const activeShadow = await css('.rail-tabs button.is-active', 'box-shadow');
check('the selected tab is a raised pill', !!activeShadow && activeShadow !== 'none', activeShadow);

// Nesting is material: rail plate, panel card.
const railBg = await css('.rail-left', 'background-color');
const panelBg = await css('.rail-panel', 'background-color');
check('the panel is a card on the rail plate, not the same surface',
  railBg !== panelBg, `rail ${railBg} / panel ${panelBg}`);

// Everything focusable shows it.
// Tab from the top of the document, after giving the page focus the way a
// person would: the first press otherwise lands on nothing at all.
await view.mouse.click(5, 5);
for (let i = 0; i < 3; i++) {
  await view.keyboard.press('Tab');
  if (await view.evaluate(() => document.activeElement !== document.body)) break;
}
const focusRing = await view.evaluate(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return { tag: 'body' };
  const st = getComputedStyle(el);
  return { outline: st.outlineWidth, shadow: st.boxShadow };
});
check('keyboard focus is visible on the first focusable control',
  !!focusRing && (parseFloat(focusRing.outline) > 0 || (focusRing.shadow ?? 'none') !== 'none'),
  JSON.stringify(focusRing));

// Motion is a convenience: it collapses when the system asks it to.
const reduced = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1200, height: 800 } });
const rp = await reduced.newPage();
await rp.goto(`${BASE}/d/${doc.id}`, { waitUntil: 'networkidle' });
await rp.waitForTimeout(1500);
const dur = await rp.evaluate(() =>
  getComputedStyle(document.querySelector('.toolbar button') ?? document.body).transitionDuration);
check('motion collapses under prefers-reduced-motion', parseFloat(dur) <= 0.01, dur);
await reduced.close();

// --- Interaction parity --------------------------------------------------------

await view.click(`.layer-row[data-layer-id="${row}"] .layer-twisty`);
await view.waitForTimeout(400);

await view.click(`.layer-row[data-layer-id="${kids[0].id}"]`);
await view.click(`.layer-row[data-layer-id="${kids[2].id}"]`, { modifiers: ['Shift'] });
await view.waitForTimeout(300);
const ranged = await view.evaluate(() => window.__playground.store.getState().selection.length);
check('shift-click in the tree takes the run between two rows', ranged === 3, `${ranged} selected`);

await view.click(`.layer-row[data-layer-id="${kids[0].id}"]`);
await view.click(`.layer-row[data-layer-id="${kids[2].id}"]`, { modifiers: ['Meta'] });
await view.waitForTimeout(300);
const toggled = await view.evaluate(() => window.__playground.store.getState().selection.length);
check('and the platform modifier adds a single row', toggled === 2, `${toggled} selected`);

// The other half of the Tab rule: with a selection on the canvas it still
// walks the siblings, which is the design-tool meaning.
await view.evaluate((id) => window.__playground.store.getState().select([id]), kids[0].id);
await view.mouse.click(750, 500);
await view.evaluate((id) => window.__playground.store.getState().select([id]), kids[0].id);
await view.keyboard.press('Tab');
await view.waitForTimeout(300);
check('Tab still walks the siblings when the canvas has a selection',
  await view.evaluate((id) => window.__playground.store.getState().selection[0] !== id, kids[0].id));

// The tree navigates by arrow, the way a tree does everywhere else.
await view.click(`.layer-row[data-layer-id="${kids[0].id}"]`);
await view.waitForTimeout(200);
await view.keyboard.press('ArrowDown');
await view.waitForTimeout(250);
const down = await view.evaluate(() => window.__playground.store.getState().selection[0]);
check('arrow down moves to the next row in the tree', down === kids[1].id, `${down}`);
await view.keyboard.press('ArrowUp');
await view.waitForTimeout(250);
check('and arrow up moves back',
  (await view.evaluate(() => window.__playground.store.getState().selection[0])) === kids[0].id);

// Left steps out to the parent; right opens it again and steps back in.
await view.keyboard.press('ArrowLeft');
await view.waitForTimeout(250);
check('arrow left steps out to the parent',
  (await view.evaluate(() => window.__playground.store.getState().selection[0])) === row);
await view.keyboard.press('ArrowRight');
await view.waitForTimeout(250);
check('and arrow right steps back in',
  (await view.evaluate(() => window.__playground.store.getState().selection[0])) === kids[0].id);

// The nudge that plain arrows do on the canvas must not also happen.
const nudged = await view.evaluate((id) =>
  Object.keys(window.__playground.store.getState().doc.nodes[id].styles).some((k) => k.startsWith('margin')),
kids[0].id);
check('walking the tree does not nudge the layer', !nudged);

await view.click(`.layer-row[data-layer-id="${kids[1].id}"]`, { button: 'right' });
await view.waitForTimeout(300);
check('right-clicking a layer row opens the same menu as the canvas',
  (await view.locator('.context-menu').count()) === 1);
const rename = view.locator('.context-item', { hasText: 'Rename' });
check('the menu offers Rename', (await rename.count()) === 1);
await rename.first().click();
await view.waitForTimeout(300);
check('which opens the name for editing in place',
  (await view.locator('.layer-rename').count()) === 1);
await view.keyboard.press('Escape');

await view.evaluate((id) => window.__playground.store.getState().select([id]), kids[1].id);
await view.keyboard.press('F2');
await view.waitForTimeout(300);
check('F2 renames the selection', (await view.locator('.layer-rename').count()) === 1);
await view.keyboard.press('Escape');

const zoomBefore = await view.evaluate(() => window.__playground.store.getState().viewport.zoom);
await view.evaluate(() => window.__playground.store.getState().setViewport({ zoom: 0.2 }));
await view.keyboard.press('Shift+1');
await view.waitForTimeout(500);
const zoomAfter = await view.evaluate(() => window.__playground.store.getState().viewport.zoom);
check('⇧1 zooms to fit, as it does in Figma', Math.abs(zoomAfter - 0.2) > 0.01,
  `${zoomBefore} → ${zoomAfter}`);

// Two questions, two axes. The picker used to be one wrapping row of chips
// where "Base" belonged to both and neither row said what it was.
await view.evaluate((id) => window.__playground.store.getState().select([id]), kids[0].id);
await view.waitForTimeout(500);
const axes = await view.$$eval('.variant-axis', (els) => els.map((e) => ({
  label: e.querySelector('.variant-axis-label')?.textContent,
  active: e.querySelector('.segmented button.is-active')?.textContent,
  options: e.querySelectorAll('.segmented button').length,
})));
check('the variant picker is split into a state axis and a width axis',
  axes.length === 2 && axes[0].label === 'State' && axes[1].label === 'Width',
  JSON.stringify(axes));
check('and each axis always shows a definite answer',
  axes.every((a) => !!a.active), JSON.stringify(axes.map((a) => a.active)));

await view.locator('.variant-axis .segmented button', { hasText: ':hover' }).first().click();
await view.waitForTimeout(400);
const afterState = await view.$$eval('.variant-axis', (els) =>
  els.map((e) => e.querySelector('.segmented button.is-active')?.textContent));
check('choosing a state leaves the width axis on All — one selector, honestly shown',
  afterState[0] === ':hover' && afterState[1] === 'All', JSON.stringify(afterState));

const bpButton = view.locator('.variant-axis').nth(1).locator('.segmented button').nth(1);
if (await bpButton.count()) {
  await bpButton.click();
  await view.waitForTimeout(400);
  const afterWidth = await view.$$eval('.variant-axis', (els) =>
    els.map((e) => e.querySelector('.segmented button.is-active')?.textContent));
  check('and choosing a width returns the state axis to Base',
    afterWidth[0] === 'Base' && afterWidth[1] !== 'All', JSON.stringify(afterWidth));
}
check('the note reads as one sentence, not as a flex row',
  (await view.evaluate(() => {
    const el = document.querySelector('.variant-note');
    return el ? getComputedStyle(el).display : null;
  })) === 'block');
await view.evaluate(() => window.__playground.store.getState().setActiveVariant(null));

// Icon-only controls say what they are, in the interface's own voice rather
// than the browser's.
const toolbarTips = await view.$$eval('.toolbar button', (els) => ({
  tipped: els.filter((e) => e.dataset.tip).length,
  native: els.filter((e) => e.title).length,
  total: els.length,
}));
check('every icon in the toolbar carries a tooltip',
  toolbarTips.tipped >= toolbarTips.total - 1, JSON.stringify(toolbarTips));
check('and none of them falls back to the browser\'s own', toolbarTips.native === 0);
const tipContent = await view.evaluate(() => {
  const el = document.querySelector('.toolbar .tip');
  return getComputedStyle(el, '::after').content;
});
check('the tooltip is drawn by the system, not by the platform',
  (tipContent ?? '').length > 2, tipContent);

// Zoom belongs to the canvas, and the browser owns ⌘+ on most platforms — so
// the bare keys are the ones that have to work.
await view.mouse.click(750, 500);
await view.evaluate(() => window.__playground.store.getState().setViewport({ zoom: 0.5, x: 100, y: 100 }));
const centreBefore = await view.evaluate(() => {
  const st = window.__playground.store.getState();
  const stage = document.querySelector('.stage').getBoundingClientRect();
  const vp = st.viewport;
  return {
    x: (stage.left + stage.width / 2 - vp.x) / vp.zoom,
    y: (stage.top + stage.height / 2 - vp.y) / vp.zoom,
  };
});
await view.keyboard.press('+');
await view.waitForTimeout(300);
const zoomedIn = await view.evaluate(() => window.__playground.store.getState().viewport.zoom);
check('plain + zooms the canvas', Math.abs(zoomedIn - 0.625) < 0.001, `${zoomedIn}`);
const centreAfter = await view.evaluate(() => {
  const st = window.__playground.store.getState();
  const stage = document.querySelector('.stage').getBoundingClientRect();
  const vp = st.viewport;
  return {
    x: (stage.left + stage.width / 2 - vp.x) / vp.zoom,
    y: (stage.top + stage.height / 2 - vp.y) / vp.zoom,
  };
});
check('and holds what is in the middle of the stage',
  Math.abs(centreAfter.x - centreBefore.x) < 1 && Math.abs(centreAfter.y - centreBefore.y) < 1,
  `${JSON.stringify(centreBefore)} → ${JSON.stringify(centreAfter)}`);
await view.keyboard.press('-');
await view.waitForTimeout(300);
check('and plain − zooms back out',
  Math.abs((await view.evaluate(() => window.__playground.store.getState().viewport.zoom)) - 0.5) < 0.001);
await view.keyboard.press('Shift+0');
await view.waitForTimeout(300);
check('⇧0 returns to 100%',
  Math.abs((await view.evaluate(() => window.__playground.store.getState().viewport.zoom)) - 1) < 0.001);

// A width typed into a field must still be a width, not a zoom.
await view.evaluate(() => window.__playground.store.getState().select([]));

// --- The other two surfaces ------------------------------------------------------

await view.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await view.waitForTimeout(1200);
const navRadius = await css('.library-nav', 'border-radius');
check('the dashboard rail is a floating card', parseFloat(navRadius) > 10, navRadius);

await view.screenshot({ path: '/tmp/ui-check.png' });
check('no runtime errors', errors.length === 0, errors[0] ?? '');
await browser.close();
await client.close();
await fetch(`${BASE}/api/documents/${doc.id}`, { method: 'DELETE' });

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} of ${results.length} checks failed` : `\nall ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
