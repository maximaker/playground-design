/**
 * Does the extractor still read the page as the page?
 *
 *   node scripts/agent/extract-check.mjs <url> [route,route,...]
 *
 * No document and no server: the page is read, written straight back out as
 * plain HTML, and the two are measured band by band. A fidelity fix can be
 * judged in twenty seconds this way instead of after a re-import.
 */
import { chromium } from 'playwright';
import { extractPage } from '@playground/shared';
import { writeFileSync } from 'node:fs';

const SITE = process.argv[2];
const ROUTES = (process.argv[3] ?? '/').split(',');

const bands = (sel) => (page) => page.evaluate((sel) => {
  const main = document.querySelector(sel) || document.body;
  // The same composition the extractor uses: the page's own header and footer
  // around main's bands, so the two lists line up.
  const outer = sel === 'main'
    ? [...document.body.children].filter((el) => el !== main && !main.contains(el) && /^(header|footer|nav)$/i.test(el.tagName))
    : [];
  const before = outer.filter((el) => el.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING);
  const kids = [...before, ...main.children, ...outer.filter((el) => !before.includes(el))];
  return kids.map((el) => ({
    height: Math.round(el.getBoundingClientRect().height),
    text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 44),
  })).filter((b) => b.height > 4);
}, sel);

const browser = await chromium.launch({ headless: true });
let worst = 0;
for (const route of ROUTES) {
  const live = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await live.goto(new URL(route, SITE).toString(), { waitUntil: 'networkidle' });
  await live.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 40)); }
    window.scrollTo(0, 0); await new Promise((r) => setTimeout(r, 400));
  });
  const shot = await live.evaluate(extractPage);
  // The fonts, and nothing else. Measured in a fallback face, every chip and
  // badge on the page wraps differently and the report is all noise.
  const faces = await live.evaluate(async () => {
    const hrefs = [...document.querySelectorAll('link[rel=stylesheet]')].map((l) => l.href);
    const texts = await Promise.all(hrefs.map((h) => fetch(h).then((r) => r.text()).catch(() => '')));
    const blocks = texts.join('\n').match(/@font-face\s*\{[^}]*\}/g) ?? [];
    return blocks.join('\n').replace(/url\((['"]?)(\/[^)'"]+)\1\)/g, (_, q, u) => `url(${location.origin}${u})`);
  });
  const siteBands = await bands('main')(live);
  await live.close();

  const file = `/tmp/extract-${route.replace(/\W/g, '') || 'home'}.html`;
  writeFileSync(file, `<!doctype html><meta charset="utf-8">
<style>${faces}
*,*::before,*::after{box-sizing:border-box}body{margin:0}</style>
<div style="${shot.wrapper}">${shot.sections.join('')}</div>`);
  const mine = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await mine.goto(`file://${file}`, { waitUntil: 'networkidle' });
  await mine.waitForTimeout(500);
  const myBands = await bands('body > div')(mine);
  await mine.close();

  console.log(`\n${route}`);
  for (let i = 0; i < Math.max(siteBands.length, myBands.length); i++) {
    const a = siteBands[i]; const b = myBands[i];
    if (!a || !b) { console.log(`  ${i} ${a ? 'MISSING' : 'EXTRA'} ${(a ?? b).text}`); worst = 999; continue; }
    const d = b.height - a.height;
    if (Math.abs(d) > 12) { worst = Math.max(worst, Math.abs(d)); console.log(`  ${String(i).padStart(2)} ${(d > 0 ? '+' : '') + d}  site ${a.height} → ${b.height}  ${a.text}`); }
  }
}
await browser.close();
console.log(`\nworst band delta ${worst}px`);
