import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 2 });
await page.goto(`http://localhost:4000/d/${process.argv[2]}`, { waitUntil: 'networkidle' });
await page.waitForSelector('.artboard-frame iframe'); await page.waitForTimeout(1200);
await page.keyboard.press('1'); await page.waitForTimeout(600);
await page.click('button[aria-label="Review"]');
await page.waitForTimeout(600);
const groups = await page.$$('.review-group');
if (groups[0]) { await groups[0].click(); await page.waitForTimeout(400); }
const summary = await page.evaluate(() => ({
  summary: document.querySelector('.review-summary')?.textContent,
  groups: [...document.querySelectorAll('.review-group-head')].map(g => g.textContent.trim()),
}));
console.log(JSON.stringify(summary, null, 1));
await page.screenshot({ path: '/tmp/review.png' });
await browser.close();
