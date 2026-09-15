/** Trims every Landing artboard to the height its own content needs. */
import { chromium } from 'playwright';
import { session, connect } from './connect.mjs';
const s = await session();
const { call, close } = await connect(s.url);
const info = JSON.parse(await call('get_basic_info'));
const boards = info.artboards.filter((a) => a.name.startsWith('Landing'));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto(`${s.base}/d/${s.docId}`, { waitUntil: 'networkidle' });
await page.waitForSelector('.artboard-frame iframe', { timeout: 20000 });
// Only artboards near the viewport get a live iframe, so zoom out to bring
// them all in before measuring.
await page.keyboard.press('Shift+1');
await page.waitForTimeout(3500);

const heights = await page.evaluate(() => {
  const out = {};
  for (const f of document.querySelectorAll('.artboard-frame iframe')) {
    // Classes are resolved into node styles at parse time and not kept in the
    // DOM, so the page is found by position: artboard root → its only child.
    const el = f.contentDocument?.body?.firstElementChild?.firstElementChild;
    if (el) out[f.title] = Math.ceil(el.getBoundingClientRect().height);
  }
  return out;
});
await browser.close();

const updates = boards
  .filter((b) => heights[b.name])
  .map((b) => ({ id: b.id, styles: { height: `${heights[b.name]}px` } }));
if (updates.length) await call('update_styles', { updates });
console.log(JSON.stringify(heights, null, 2));
await close();
