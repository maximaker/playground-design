/**
 * Frame-timing check in a real browser.
 *
 * The in-app browser pane throttles requestAnimationFrame when it is not the
 * focused window, which makes frame timings measured there meaningless — an
 * idle page reports multi-second "frames". This drives a real Chromium instead
 * and reports an idle baseline alongside the drag, so the numbers validate
 * themselves: if the idle baseline is not ~16.7ms, the run was throttled and
 * the drag figure should be ignored.
 */

import './lib/session.mjs';  // signs these checks in; see the module header
import { chromium } from 'playwright';

const URL_BASE = process.argv[2] ?? 'http://localhost:4000';
const DOC = process.argv[3];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const docId = DOC ?? (await (await fetch(`${URL_BASE}/api/documents`)).json()).documents[0].id;
await page.goto(`${URL_BASE}/d/${docId}`, { waitUntil: 'networkidle' });
await page.waitForSelector('.artboard-frame iframe', { timeout: 20000 });
await page.waitForTimeout(1500);

const sample = async (label, action) => {
  await page.evaluate(() => {
    window.__frames = [];
    window.__last = performance.now();
    window.__running = true;
    const tick = () => {
      if (!window.__running) return;
      const now = performance.now();
      window.__frames.push(now - window.__last);
      window.__last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await action();
  const frames = await page.evaluate(() => { window.__running = false; return window.__frames; });
  // Drop sub-millisecond entries: those are multiple callbacks within one
  // frame, not frames, and they drag the median to a meaningless number.
  const s = frames.slice(3).filter((f) => f > 1).sort((a, b) => a - b);
  if (!s.length) return { label, median: 0, p95: 0, fps: 0 };
  return {
    label,
    median: +s[Math.floor(s.length / 2)].toFixed(1),
    p95: +s[Math.floor(s.length * 0.95)].toFixed(1),
    fps: Math.round(1000 / s[Math.floor(s.length / 2)]),
  };
};

const results = [];

results.push(await sample('idle (baseline)', () => page.waitForTimeout(1200)));

// Zoom to fit so every artboard is live, then drag one across the canvas.
await page.keyboard.press('1');
await page.waitForTimeout(600);

results.push(await sample('drag an artboard', async () => {
  const label = await page.$('.artboard-label');
  const box = await label.boundingBox();
  await page.mouse.move(box.x + 20, box.y + 6);
  await page.mouse.down();
  for (let i = 1; i <= 40; i++) {
    await page.mouse.move(box.x + 20 + i * 4, box.y + 6 + i * 2);
    await page.waitForTimeout(8);
  }
  await page.mouse.up();
}));

// Panning is driven by the wheel, which does not produce one rAF per event —
// timing it this way yields sub-millisecond samples that mean nothing. Space-
// drag goes through the same pointer path as any other gesture.
results.push(await sample('pan the canvas', async () => {
  await page.keyboard.down('Space');
  await page.mouse.move(700, 450);
  await page.mouse.down();
  for (let i = 1; i <= 40; i++) {
    await page.mouse.move(700 + i * 5, 450 + i * 3);
    await page.waitForTimeout(8);
  }
  await page.mouse.up();
  await page.keyboard.up('Space');
}));

const stats = await page.evaluate(() => ({
  nodes: Object.keys(window.__playground.store.getState().doc.nodes).length,
  liveFrames: document.querySelectorAll('.artboard-frame iframe').length,
  artboards: document.querySelectorAll('.artboard').length,
}));

console.log(`document: ${stats.nodes} nodes, ${stats.artboards} artboards (${stats.liveFrames} live)`);
for (const r of results) {
  console.log(`  ${r.label.padEnd(18)} median ${String(r.median).padStart(5)}ms  p95 ${String(r.p95).padStart(5)}ms  ~${r.fps}fps`);
}

await browser.close();
