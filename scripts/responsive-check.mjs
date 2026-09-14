/**
 * Checks the editor across viewport widths.
 *
 * Verifies the things that actually break when a three-column tool meets a
 * small screen: horizontal overflow, controls pushed off-screen, panels that
 * cannot be reached, and tap targets too small to hit.
 */

import { chromium, devices } from 'playwright';

const BASE = process.argv[2] ?? 'http://localhost:4000';
const DOC = process.argv[3];

const VIEWPORTS = [
  { name: 'desktop', width: 1680, height: 1000 },
  { name: 'laptop', width: 1280, height: 800 },
  { name: 'small laptop', width: 1100, height: 760 },
  { name: 'tablet landscape', width: 1024, height: 768, touch: true },
  { name: 'tablet portrait', width: 820, height: 1180, touch: true },
  { name: 'phone large', width: 430, height: 932, touch: true },
  { name: 'phone small', width: 360, height: 740, touch: true },
];

const browser = await chromium.launch({ headless: true });
const docId = DOC ?? (await (await fetch(`${BASE}/api/documents`)).json()).documents[0].id;
let failures = 0;

for (const vp of VIEWPORTS) {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    hasTouch: !!vp.touch,
    isMobile: !!vp.touch && vp.width < 700,
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(`${BASE}/d/${docId}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.toolbar', { timeout: 20000 });
  await page.waitForTimeout(800);

  const report = await page.evaluate(() => {
    const doc = document.documentElement;
    const overflowX = doc.scrollWidth - doc.clientWidth;

    // Anything that spills past an edge is a layout failure — except a closed
    // drawer, which is parked off-screen by design.
    const spilling = [...document.querySelectorAll('.topbar *, .toolbar, .rail.is-open')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1);
      })
      .map((el) => el.className || el.tagName)
      .slice(0, 4);

    // Every interactive control should be reachable and big enough to tap.
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    const small = [...document.querySelectorAll('.topbar button, .toolbar button')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && (r.width < (coarse ? 32 : 22) || r.height < (coarse ? 32 : 22));
      })
      .map((el) => el.getAttribute('aria-label') || el.className)
      .slice(0, 4);

    const rails = [...document.querySelectorAll('.rail')].map((el) => ({
      cls: el.className,
      visible: el.getBoundingClientRect().left > -10 && el.getBoundingClientRect().right < window.innerWidth + 10,
    }));

    return {
      overflowX,
      spilling,
      small,
      toggles: document.querySelectorAll('.panel-toggle').length,
      railsDocked: rails.filter((r) => r.visible).length,
      canvasWidth: Math.round(document.querySelector('.stage')?.getBoundingClientRect().width ?? 0),
      appMode: (document.querySelector('.app')?.className ?? '').replace('app ', ''),
    };
  });

  // On overlay layouts the panel toggles must actually open a panel.
  let drawerWorks = 'n/a';
  if (report.toggles > 0) {
    await page.click('.panel-toggle');
    await page.waitForTimeout(350);
    const open = await page.evaluate(() => document.querySelectorAll('.rail.is-open').length);
    const onScreen = await page.evaluate(() => {
      const el = document.querySelector('.rail.is-open');
      return el ? el.getBoundingClientRect().left >= -2 : false;
    });
    drawerWorks = open === 1 && onScreen ? 'opens' : `BROKEN (open=${open}, onScreen=${onScreen})`;
  }

  const problems = [];
  if (report.overflowX > 1) problems.push(`overflows ${report.overflowX}px`);
  if (report.spilling.length) problems.push(`off-screen: ${report.spilling.join(', ')}`);
  if (report.small.length) problems.push(`tap targets: ${report.small.join(', ')}`);
  if (drawerWorks.startsWith('BROKEN')) problems.push(drawerWorks);
  if (errors.length) problems.push(`js errors: ${errors[0]}`);
  if (problems.length) failures++;

  console.log(
    `${vp.name.padEnd(17)} ${String(vp.width).padStart(4)}px  ${report.appMode.padEnd(10)}` +
    ` canvas ${String(report.canvasWidth).padStart(4)}px  drawer ${drawerWorks.padEnd(7)}` +
    (problems.length ? `  ✗ ${problems.join(' | ')}` : '  ✓'),
  );

  await context.close();
}

await browser.close();
console.log(failures ? `\n${failures} viewport(s) with problems` : '\nall viewports clean');
process.exit(failures ? 1 : 0);
