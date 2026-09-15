/** Measures the page inside the artboard and screenshots it at a given width. */
import { chromium } from 'playwright';
import { session, connect } from './connect.mjs';

const width = Number(process.argv[2] ?? 1440);
const out = process.argv[3] ?? `/tmp/shot-${width}.png`;
const s = await session();
const { call, close } = await connect(s.url);
const info = JSON.parse(await call('get_basic_info'));
const board = info.artboards.find((a) => a.name.startsWith('Landing'));
if (width !== board.width) await call('preview_at_width', { id: board.id, width, restore: false });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto(`${s.base}/d/${s.docId}`, { waitUntil: 'networkidle' });
await page.waitForSelector('.artboard-frame iframe', { timeout: 20000 });
await page.waitForTimeout(2500);

const height = await page.evaluate((name) => {
  for (const f of document.querySelectorAll('.artboard-frame iframe')) {
    if (f.title !== name) continue;
    // The artboard root fills the artboard, so measure the page inside it.
    const root = f.contentDocument?.querySelector('.page') ?? f.contentDocument?.body.firstElementChild?.firstElementChild;
    return root ? Math.ceil(root.getBoundingClientRect().height) : 0;
  }
  return 0;
}, board.name);

await browser.close();
if (height) await call('update_styles', { updates: [{ id: board.id, styles: { height: `${height}px` } }] });

const png = JSON.parse(await call('export', { ids: [board.id], format: 'png', scale: 1 }));
console.log(JSON.stringify({ width, height, url: png.exported[0].url }));
await close();
