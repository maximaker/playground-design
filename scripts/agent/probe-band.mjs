/** Dump one band's subtree with the styles that decide its height, both sides. */
import '../lib/session.mjs';
import { chromium } from 'playwright';
import { emitStandalone } from '@playground/shared';
import { writeFileSync } from 'node:fs';

const [SITE, DOC, ROUTE, PAGE, IDX] = process.argv.slice(2);
const BASE = 'https://playground.thedigitalvitamins.com';
const { document: doc } = await (await fetch(`${BASE}/api/documents/${DOC}`)).json();
const board = doc.pages.find((p) => p.name === PAGE).artboards[0];

const dump = (sel, idx) => (page) => page.evaluate(([sel, idx]) => {
  const root = [...(document.querySelector(sel) || document.body).children][+idx];
  const walk = (el, d) => {
    const c = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const line = `${'  '.repeat(d)}${el.tagName.toLowerCase()} h=${Math.round(r.height)} w=${Math.round(r.width)} ` +
      `disp=${c.display} pad=${c.paddingTop}/${c.paddingBottom} mar=${c.marginTop}/${c.marginBottom} ` +
      `gap=${c.rowGap} fs=${c.fontSize} lh=${c.lineHeight} "${(el.textContent||'').replace(/\s+/g,' ').trim().slice(0,24)}"`;
    return [line, ...[...el.children].flatMap((k) => walk(k, d + 1))];
  };
  return walk(root, 0).join('\n');
}, [sel, idx]);

const browser = await chromium.launch({ headless: true });
const live = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await live.goto(new URL(ROUTE, SITE).toString(), { waitUntil: 'networkidle' });
await live.waitForTimeout(600);
console.log('=== SITE ===\n' + await dump('main', IDX)(live));
await live.close();

const file = '/tmp/probe-band.html';
writeFileSync(file, emitStandalone(doc, board, { includeTokens: true }));
const mine = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await mine.goto(`file://${file}`, { waitUntil: 'networkidle' });
await mine.waitForTimeout(800);
console.log('\n=== DOC ===\n' + await dump('body > div > div', IDX)(mine));
await mine.close();
await browser.close();
