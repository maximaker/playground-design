/** Band-level diff between a live page and its extraction, no document involved. */
import { chromium } from 'playwright';
import { extractPage } from '@playground/shared';
import { writeFileSync } from 'node:fs';

const [SITE, ROUTE, IDX] = process.argv.slice(2);
const dump = (sel, idx) => (page) => page.evaluate(([sel, idx]) => {
  const root = [...(document.querySelector(sel) || document.body).children][+idx];
  const walk = (el, d) => {
    const c = getComputedStyle(el); const r = el.getBoundingClientRect();
    return [`${'  '.repeat(d)}${el.tagName.toLowerCase()} h=${Math.round(r.height)} w=${Math.round(r.width)} ` +
      `${c.display} pad=${c.paddingTop}/${c.paddingBottom} mar=${c.marginTop}/${c.marginBottom} gap=${c.rowGap} ` +
      `fs=${c.fontSize} lh=${c.lineHeight} "${(el.textContent||'').replace(/\s+/g,' ').trim().slice(0,22)}"`,
      ...[...el.children].flatMap((k) => walk(k, d + 1))];
  };
  return walk(root, 0).join('\n');
}, [sel, idx]);

const browser = await chromium.launch({ headless: true });
const live = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await live.goto(new URL(ROUTE, SITE).toString(), { waitUntil: 'networkidle' });
await live.waitForTimeout(600);
const shot = await live.evaluate(extractPage);
const faces = await live.evaluate(async () => {
  const hrefs = [...document.querySelectorAll('link[rel=stylesheet]')].map((l) => l.href);
  const texts = await Promise.all(hrefs.map((h) => fetch(h).then((r) => r.text()).catch(() => '')));
  return (texts.join('\n').match(/@font-face\s*\{[^}]*\}/g) ?? []).join('\n')
    .replace(/url\((['"]?)(\/[^)'"]+)\1\)/g, (_, q, u) => `url(${location.origin}${u})`);
});
console.log('=== SITE ===\n' + await dump('main', IDX)(live));
await live.close();

const file = '/tmp/probe-extract.html';
writeFileSync(file, `<!doctype html><meta charset="utf-8"><style>${faces}
*,*::before,*::after{box-sizing:border-box}body{margin:0}</style><div style="${shot.wrapper}">${shot.sections.join('')}</div>`);
const mine = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await mine.goto(`file://${file}`, { waitUntil: 'networkidle' });
await mine.waitForTimeout(400);
console.log('\n=== EXTRACT ===\n' + await dump('body > div', IDX)(mine));
await mine.close();
await browser.close();
