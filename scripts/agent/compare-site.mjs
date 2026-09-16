/**
 * Compare an imported document against the site it came from.
 *
 *   node scripts/agent/compare-site.mjs <url> <docId> [base]
 *
 * Section by section, at the same width, measuring the same thing on both
 * sides. A screenshot diff would be all noise — the images are placeholders on
 * purpose — so what is compared is geometry: how tall each band of the page is
 * and where it starts. A section that is 200px short is a section that lost
 * something.
 */

import '../lib/session.mjs';
import { chromium } from 'playwright';
import { emitStandalone } from '@playground/shared';
import { writeFileSync } from 'node:fs';

const SITE = process.argv[2];
const DOC = process.argv[3];
const BASE = process.argv[4] ?? 'https://playground.thedigitalvitamins.com';

const { document: doc } = await (await fetch(`${BASE}/api/documents/${DOC}`)).json();
const browser = await chromium.launch({ headless: true });

const settle = async (page) => {
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 600) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 40));
    }
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 500));
  });
};

const bands = (root) => (page) => page.evaluate((sel) => {
  const main = document.querySelector(sel) || document.body;
  // The document holds the page's header and footer around main's bands, so
  // the site's list is composed the same way or the two are off by one.
  const outer = sel === 'main'
    ? [...document.body.children].filter((el) => el !== main && !main.contains(el) && /^(header|footer|nav)$/i.test(el.tagName))
    : [];
  const before = outer.filter((el) => el.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING);
  return [...before, ...main.children, ...outer.filter((el) => !before.includes(el))].map((el) => {
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      top: Math.round(r.top + window.scrollY),
      height: Math.round(r.height),
      text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
    };
  }).filter((b) => b.height > 4);
}, root);

/**
 * Where a height difference is actually born.
 *
 * A band being 400px too tall says nothing about why. Walking both trees in
 * step and reporting the deepest node whose own children do *not* explain its
 * delta points at the element that is wrong, which is usually one style.
 */
const DEEP = process.argv.includes('--deep');
const probe = (page, root) => page.evaluate((sel) => {
  const walk = (el) => ({
    tag: el.tagName.toLowerCase(),
    height: Math.round(el.getBoundingClientRect().height),
    width: Math.round(el.getBoundingClientRect().width),
    text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30),
    style: el.getAttribute('style') ?? '',
    children: [...el.children].map(walk),
  });
  const main = document.querySelector(sel) || document.body;
  return [...main.children].map(walk);
}, root);

function diverge(a, b, path = '', out = []) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    const here = `${path}/${i}`;
    if (!x || !y) { out.push({ where: here, note: x ? 'missing in doc' : 'extra in doc', text: (x ?? y).text }); continue; }
    const delta = y.height - x.height;
    if (Math.abs(delta) <= 24) continue;
    const kids = diverge(x.children, y.children, here, []);
    // Children that already account for the difference are the better report.
    const explained = kids.reduce((n, k) => n + Math.abs(k.delta ?? 0), 0);
    if (kids.length && explained >= Math.abs(delta) * 0.6) out.push(...kids);
    else out.push({ where: here, delta, site: x.height, doc: y.height, width: `${x.width}→${y.width}`, text: x.text, style: y.style.slice(0, 160) });
  }
  return out;
}

const ROUTES = doc.pages.map((p) => ({
  page: p,
  route: p.name === 'Acasă' ? '/' : `/${p.name.toLowerCase()}`,
}));

for (const { page: docPage, route } of ROUTES) {
  const board = docPage.artboards[0];
  if (!board) continue;

  const live = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await live.goto(new URL(route, SITE).toString(), { waitUntil: 'networkidle' });
  await settle(live);
  const siteBands = await bands('main')(live);
  const siteTree = DEEP ? await probe(live, 'main') : [];
  const siteHeight = await live.evaluate(() => document.body.scrollHeight);
  await live.close();

  const file = `/tmp/cmp-${docPage.name.toLowerCase().replace(/[^a-z]/g, '')}.html`;
  writeFileSync(file, emitStandalone(doc, board, { includeTokens: true }));
  const mine = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await mine.goto(`file://${file}`, { waitUntil: 'networkidle' });
  await mine.waitForTimeout(900);
  // The artboard's own root is the wrapper the import made; its children are
  // the sections, which is the same level the site's <main> children are at.
  const mineBands = await bands('body > div > div')(mine);
  const mineTree = DEEP ? await probe(mine, 'body > div > div') : [];
  const mineHeight = await mine.evaluate(() => document.body.scrollHeight);
  await mine.close();

  console.log(`\n${docPage.name}  (${route})  site ${siteHeight}px · doc ${mineHeight}px · ${Math.round((mineHeight / siteHeight - 1) * 100)}%`);

  if (DEEP) {
    for (const d of diverge(siteTree, mineTree).slice(0, 8)) {
      console.log(`  ${d.where}  ${d.note ?? `${d.delta > 0 ? '+' : ''}${d.delta} (site ${d.site} → doc ${d.doc}, w ${d.width})`}`);
      console.log(`      "${d.text}"  ${d.style ?? ''}`);
    }
    continue;
  }
  const rows = Math.max(siteBands.length, mineBands.length);
  for (let i = 0; i < rows; i++) {
    const a = siteBands[i];
    const b = mineBands[i];
    const delta = a && b ? b.height - a.height : null;
    const flag = !a ? 'EXTRA' : !b ? 'MISSING' : Math.abs(delta) > 24 ? `${delta > 0 ? '+' : ''}${delta}` : '';
    if (!flag) continue;
    console.log(`  ${String(i).padStart(2)} ${flag.padEnd(8)} site ${(a?.height ?? 0).toString().padStart(5)}  doc ${(b?.height ?? 0).toString().padStart(5)}  ${(a?.text ?? b?.text ?? '').slice(0, 46)}`);
  }
}

await browser.close();
