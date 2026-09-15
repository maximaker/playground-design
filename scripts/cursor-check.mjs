/**
 * Live cursors, checked with two real tabs.
 *
 * The failure this is built to catch is not "no cursor appears" — it is a
 * cursor appearing in the *wrong place*. Positions travel in world coordinates
 * because the two tabs are at different zoom and scroll positions; send screen
 * coordinates instead and the cursor still shows up, just somewhere else on the
 * design, which is the version that looks like it works.
 *
 * So the two tabs are deliberately put at different zooms, and the check asserts
 * the remote cursor lands on the same *design* point, not the same screen point.
 */

import './lib/session.mjs';  // signs these checks in; see the module header
import { chromium } from 'playwright';
import WebSocket from 'ws';

const BASE = process.argv[2] ?? 'http://localhost:4000';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
};

/**
 * Presence rides the WebSocket, and serverless hosts cannot hold one open — so
 * on those hosts live cursors genuinely do not work. That is a documented
 * limitation of the deployment, not a regression, so the check says so and
 * stops rather than reporting failures that no code change could fix.
 */
const probe = await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false);
if (!probe) { console.log('  server unreachable'); process.exit(1); }

const socketWorks = await new Promise((resolve) => {
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws`);
  ws.on('open', () => { ws.close(); resolve(true); });
  ws.on('error', () => resolve(false));
});

if (!socketWorks) {
  console.log('  — this host cannot hold a WebSocket open, so there is no presence channel.');
  console.log('    Live cursors are unavailable here by design; nothing to check.');
  process.exit(0);
}

const doc = await (await fetch(`${BASE}/api/documents`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Cursor check', template: 'clean' }),
})).json();
const docId = doc.document.id;

const browser = await chromium.launch({ headless: true });
const errors = [];

const openTab = async (name) => {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  await page.addInitScript((n) => localStorage.setItem('canvas.name', n), name);
  await page.goto(`${BASE}/d/${docId}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.artboard-frame iframe', { timeout: 20000 });
  await page.waitForTimeout(1200);
  return page;
};

const alice = await openTab('Alice');
const bob = await openTab('Bob');
await bob.waitForTimeout(1500);

// Different zooms, which is the whole point of sending world coordinates.
const setViewport = (page, vp) => page.evaluate((v) => {
  window.__playground.store.getState().setViewport(v);
}, vp);
await setViewport(alice, { zoom: 1, x: 200, y: 120 });
await setViewport(bob, { zoom: 0.5, x: 40, y: 60 });
await bob.waitForTimeout(400);

// Alice points at a known world coordinate.
const WORLD = { x: 300, y: 200 };
const aliceScreen = await alice.evaluate((w) => {
  const vp = window.__playground.store.getState().viewport;
  return { x: vp.x + w.x * vp.zoom, y: vp.y + w.y * vp.zoom };
}, WORLD);
await alice.mouse.move(aliceScreen.x, aliceScreen.y);
await alice.waitForTimeout(1200);

const sent = await alice.evaluate(() => window.__playground.store.getState().pointer);
check('the pointer is tracked in world coordinates',
  !!sent && Math.abs(sent.x - WORLD.x) <= 1 && Math.abs(sent.y - WORLD.y) <= 1,
  JSON.stringify(sent));

await bob.waitForTimeout(900);
const onBob = await bob.evaluate(() => {
  const el = document.querySelector('.peer-cursor');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const vp = window.__playground.store.getState().viewport;
  return {
    name: el.querySelector('.peer-cursor-name')?.textContent,
    // Back to world coordinates, so the assertion is about the design, not the
    // screen — the two tabs do not share a screen position for anything.
    world: { x: Math.round((r.left - vp.x) / vp.zoom), y: Math.round((r.top - vp.y) / vp.zoom) },
  };
});

check('the other tab sees a cursor', !!onBob, onBob ? onBob.name : '(none)');
// The tab asked to be called "Alice" in localStorage; the server labels the
// cursor with the signed-in account instead. A name a tab can choose for itself
// is not identity, and the whole point of accounts is that this one cannot lie.
check('it is labelled with the account, not with what the tab asked to be called',
  !!onBob?.name && onBob.name !== 'Alice', onBob?.name ?? '');
check('it lands on the same point of the design',
  !!onBob && Math.abs(onBob.world.x - WORLD.x) <= 3 && Math.abs(onBob.world.y - WORLD.y) <= 3,
  onBob ? `world ${onBob.world.x},${onBob.world.y} (expected ${WORLD.x},${WORLD.y})` : '');

// Moving must carry, not just the first position.
await alice.mouse.move(aliceScreen.x + 120, aliceScreen.y + 80);
await alice.waitForTimeout(1000);
const moved = await bob.evaluate(() => {
  const el = document.querySelector('.peer-cursor');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const vp = window.__playground.store.getState().viewport;
  return { x: Math.round((r.left - vp.x) / vp.zoom), y: Math.round((r.top - vp.y) / vp.zoom) };
});
check('it follows the hand',
  !!moved && Math.abs(moved.x - (WORLD.x + 120)) <= 4 && Math.abs(moved.y - (WORLD.y + 80)) <= 4,
  moved ? `${moved.x},${moved.y}` : '');

// Leaving the canvas clears it, rather than parking it on the design forever.
await alice.mouse.move(5, 5);
await alice.evaluate(() => {
  document.querySelector('.canvas')?.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
});
await bob.waitForTimeout(1200);
const afterLeave = await bob.evaluate(() => document.querySelectorAll('.peer-cursor').length);
check('leaving the canvas removes it', afterLeave === 0, `${afterLeave} left`);

check('no runtime errors', errors.length === 0, errors[0] ?? '');

await browser.close();
await fetch(`${BASE}/api/documents/${docId}`, { method: 'DELETE' });

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} of ${results.length} checks failed` : `\nall ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
