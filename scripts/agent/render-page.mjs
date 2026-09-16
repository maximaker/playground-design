/**
 * Screenshot one page of a document as it really renders.
 *
 *   node scripts/agent/render-page.mjs <docId> <pageName> <out.png> [base]
 *
 * The standalone export in a headless browser, full height — the closest thing
 * to what someone sees, without the editor's chrome around it.
 */

import '../lib/session.mjs';
import { chromium } from 'playwright';
import { emitStandalone } from '@playground/shared';
import { writeFileSync } from 'node:fs';
const [DOC, PAGE, OUT, BASE = 'https://playground.thedigitalvitamins.com'] = process.argv.slice(2);
const { document: d } = await (await fetch(`${BASE}/api/documents/${DOC}`)).json();
const board = d.pages.find((p) => p.name === PAGE).artboards[0];
const file = `/tmp/render-${PAGE.toLowerCase().replace(/[^a-z]/g,'')}.html`;
writeFileSync(file, emitStandalone(d, board, { includeTokens: true }));
const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1440, height: 1200 } });
await p.goto(`file://${file}`, { waitUntil: 'networkidle' });
await p.evaluate(async () => { for (let y=0;y<document.body.scrollHeight;y+=600){window.scrollTo(0,y); await new Promise(r=>setTimeout(r,40));} window.scrollTo(0,0); await new Promise(r=>setTimeout(r,1200)); });
await p.screenshot({ path: OUT, fullPage: true });
await b.close();
console.log(OUT);
