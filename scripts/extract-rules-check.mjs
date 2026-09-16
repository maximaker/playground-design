/**
 * The rules the extractor learned from importing a real site.
 *
 *   node scripts/extract-rules-check.mjs
 *
 * Each one is a way a page came back wrong: a figure 32px from its neighbours
 * on every page, an accordion the site had open, a button that wrapped onto a
 * second line, a gallery tile that lost its two-column span. The fixture is a
 * page written to contain exactly those shapes, so the rules can be checked in
 * seconds without going near the network.
 */

import { chromium } from 'playwright';
import { extractPage } from '@playground/shared';

const FIXTURE = `<!doctype html><meta charset="utf-8">
<style>
  *,*::before,*::after{box-sizing:border-box}
  body{margin:0;font:16px/1.65 system-ui;color:#333}
  main{padding:0}
  figure{margin:0}
  ul{margin:0;padding:0;list-style:none}
  .chip{display:inline-flex;padding:7px 15.2px;border:1px solid #ccc}
  .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
  .wide{grid-column:span 2;grid-row:span 2}
  .card{position:relative;padding:24px}
  .card::before{content:"“";position:absolute;top:8px;left:8px;font-size:32px;color:#999}
  .narrow{width:200px}
  h2{text-wrap:balance}
  .mark{display:block;width:18px;height:18px;background:#000;border-radius:50%}
</style>
<main>
  <section>
    <figure><span>caption</span></figure>
    <span class="chip"><span class="mark"></span>Boli cronice</span>
    <ul><li>one</li></ul>
    <details open><summary>Open by default</summary><p>Its answer.</p></details>
    <details><summary>Closed</summary><p>Hidden.</p></details>
    <div class="grid"><div class="wide">wide</div><div>a</div><div>b</div></div>
    <div class="card">Quoted</div>
    <div><div class="narrow">A column the author sized</div></div>
    <h2>One<br>Two</h2>
    <a href="#"><svg width="16" height="16"><rect width="16" height="16"/></svg>Label</a>
  </section>
</main>`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  ${detail}`}`);
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
await page.setContent(FIXTURE);
const shot = await page.evaluate(extractPage);
await browser.close();
const html = shot.sections.join('');

const figure = /<figure style="([^"]*)"/.exec(html)?.[1] ?? '';
check('a figure records the zero margin its page gave it', /margin:0px/.test(figure), figure);
check('the root keeps the line height everything inherits', /line-height:26.4px/.test(shot.wrapper), shot.wrapper);
check('a list records that it has no markers', /list-style:none/.test(html));
check('a list records its reset padding', /<ul style="[^"]*padding:0px/.test(html));
check('an open accordion stays open', /<details open/.test(html));
check('a closed accordion stays closed', (html.match(/<details/g) ?? []).length === 2 && (html.match(/<details open/g) ?? []).length === 1);
check('a tile that spans two columns says so', /grid-column:span 2/.test(html) && /grid-row:span 2/.test(html));
check('an icon keeps the box it occupied', /width:16px;height:16px/.test(html));
check('a line break survives', /<br \/>/.test(html));
check('a decorative marker stays out of the flow', /position:absolute[^"]*top:8px/.test(html));
check('an empty decorative box keeps its size', /width:18px;height:18px/.test(html));
check('a box with content is not pinned to a measured width',
  !/<span style="[^"]*width:\d+px[^"]*">Boli/.test(html));
check('a heading that balances its lines keeps doing so', /text-wrap:balance/.test(html));
check('a width the author set is kept', /width:200px/.test(html));
check('boxes round but type keeps its fractions',
  /padding:7px 15px/.test(html) && !/line-height:26px[;"]/.test(`${html}${shot.wrapper}`));
check('nothing is written for a property at its initial value', !/order:0|align-self:auto/.test(html));

const failed = results.filter((r) => !r).length;
console.log(`\n${failed ? `${failed} failed` : `all ${results.length} checks passed`}`);
process.exit(failed ? 1 : 0);
