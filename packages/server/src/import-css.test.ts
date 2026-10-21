/**
 * Importing a real site's CSS through write_html, end to end: a real MCP
 * client calls write_html, get_screenshot renders it, and the picture is
 * compared with Chrome rendering the same fragment directly.
 *
 * Each case here is something an agent importing a four-page static site hit:
 * ::after folded into the card, grid spans lost, <pre> children as literal
 * tags, a tiled radial-gradient drawing nothing, and media queries.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

process.env.PLAYGROUND_DB = `/tmp/playground-import-css-${Date.now()}.db`;

const { app } = await import('./app.ts');
const { createDocument, getDocument } = await import('./store.ts');
const { createConnection } = await import('./connections.ts');
const { shutdownRenderer } = await import('./render.ts');
const { tryLoadPlaywright, getBrowser } = await import('./browser.ts');
const { emitStandalone } = await import('@playground/shared');

const FRAGMENT = '<style>.card{position:relative;width:300px;height:120px;background:#fff;border-radius:24px}'
  + '.card::after{content:"";position:absolute;inset:0;border-radius:inherit;background:rgba(217,58,11,.05)}'
  + '.card:hover{transform:translateY(-4px)}'
  + '.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:10px}'
  + '.wide{grid-column:span 6;grid-row:span 2}'
  + '.quarter{grid-column:span 3;height:120px;background:#eee}'
  + '.dots{height:120px;background:#111;background-image:radial-gradient(circle,#EE6A1E 0,#EE6A1E 1.5px,transparent 2px);background-size:36px 32px}'
  + '@media (max-width:600px){.card{width:100%}}'
  + ':root{--accent:#d93a0b}.pill{color:var(--accent, red)}'
  + '@keyframes spin{to{transform:rotate(360deg)}}'
  + '@media print{@media (min-width:1px){.x{color:red}}}'
  + '</style>'
  + '<div class="card">Test 1</div><div class="card">Test 1b</div>'
  + '<div class="grid"><div class="wide quarter">Test 2</div><div class="quarter">a</div><div class="quarter">b</div><div class="quarter">c</div><div class="quarter">d</div></div>'
  + '<pre><b>Test 3:</b> bold</pre><div class="dots">Test 4</div><span class="pill">pill</span>';

let server: ReturnType<typeof serve>;
let client: Client;
let docId: string;
let wide: string;
let narrow: string;
let written: { warnings: string[]; tokensAdded?: string[]; keptAsCss?: string };

function textOf(res: unknown): string {
  const content = (res as { content: { type: string; text?: string }[] }).content;
  return content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
}
function jsonOf<T>(res: unknown): T { return JSON.parse(textOf(res)) as T; }

const pw = await tryLoadPlaywright();

before(async () => {
  const port = 4500 + Math.floor(Math.random() * 400);
  server = serve({ fetch: app.fetch, port });
  docId = (await createDocument('Import CSS')).id;
  const conn = await createConnection(docId, 'Test Agent');
  client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${conn.code}`)));

  wide = getDocument(docId)!.pages[0]!.artboards[0]!;
  written = jsonOf(await client.callTool({ name: 'write_html', arguments: { targetId: wide, html: FRAGMENT } }));
  narrow = jsonOf<{ id: string }>(await client.callTool({ name: 'create_artboard', arguments: { name: 'Phone', width: 390, height: 900 } })).id;
  await client.callTool({ name: 'write_html', arguments: { targetId: narrow, html: FRAGMENT } });
});

after(async () => {
  await client.close().catch(() => {});
  await shutdownRenderer();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('write_html keeps ::after and :hover out of the element, and grid placement on it', () => {
  const doc = getDocument(docId)!;
  const cards = Object.values(doc.nodes).filter((n) => n.attrs['data-class'] === 'card');
  assert.equal(cards.length, 4);
  for (const card of cards) {
    assert.equal(card.styles.position, 'relative', 'the card keeps its own position');
    assert.equal(card.styles.inset, undefined, '::after declarations are not on the card');
    assert.equal(card.styles.transform, undefined, ':hover is not applied at rest');
    assert.ok(card.variants.some((v) => v.selector === ':hover'), ':hover stays a state variant');
  }
  const cell = Object.values(doc.nodes).find((n) => n.attrs['data-class'] === 'wide quarter')!;
  assert.equal(cell.styles['grid-row'], 'span 2');
  // `.quarter` comes later at equal specificity, so it wins — as in Chrome.
  assert.equal(cell.styles['grid-column'], 'span 3');
  const dots = Object.values(doc.nodes).find((n) => n.attrs['data-class'] === 'dots')!;
  assert.equal(dots.styles['background-image'], 'radial-gradient(circle,#EE6A1E 0,#EE6A1E 1.5px,transparent 2px)');
  assert.equal(dots.styles['background-size'], '36px 32px');
});

test('custom properties become tokens, var() is kept, and dropped CSS is reported', () => {
  const doc = getDocument(docId)!;
  assert.deepEqual(written.tokensAdded, ['accent']);
  assert.equal(doc.tokens.find((t) => t.name === 'accent')?.values.default, '#d93a0b');
  const pill = Object.values(doc.nodes).find((n) => n.attrs['data-class'] === 'pill')!;
  assert.equal(pill.styles.color, 'var(--accent, red)');
  assert.ok(written.keptAsCss, 'the kept CSS is reported');
  assert.ok(written.warnings.some((w) => w.includes('@media (min-width:1px) inside @media print')), written.warnings.join('\n'));
});

test('get_screenshot matches Chrome rendering the same fragment', { skip: !pw }, async () => {
  const shot = await client.callTool({ name: 'get_screenshot', arguments: { id: wide } });
  const png = (shot as { content: { type: string; data?: string }[] }).content.find((c) => c.type === 'image')!.data!;

  const browser = await getBrowser(pw!);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  try {
    await page.setContent(`<!doctype html><html><head><style>body{margin:0}</style></head><body>${FRAGMENT}</body></html>`);
    const reference = Buffer.from(await page.screenshot({ type: 'png' })).toString('base64');
    const ratio = await page.evaluate(async ([a, b]: string[]) => {
      const load = async (src: string) => {
        const img = new Image();
        img.src = `data:image/png;base64,${src}`;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const ctx = c.getContext('2d')!;
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, c.width, c.height).data;
      };
      const [x, y] = [await load(a!), await load(b!)];
      if (x.length !== y.length) return 1;
      let diff = 0;
      for (let i = 0; i < x.length; i += 4) {
        if (Math.abs(x[i]! - y[i]!) + Math.abs(x[i + 1]! - y[i + 1]!) + Math.abs(x[i + 2]! - y[i + 2]!) > 24) diff++;
      }
      return diff / (x.length / 4);
    }, [png, reference]);
    assert.ok(ratio < 0.002, `${(ratio * 100).toFixed(2)}% of pixels differ from Chrome`);
  } finally {
    await context.close();
  }
});

test('the render lays out like the source: cards in flow, spans, bold, dots, media per artboard', { skip: !pw }, async () => {
  const browser = await getBrowser(pw!);
  const measure = async (artboard: string, width: number) => {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    try {
      await page.setContent(emitStandalone(getDocument(docId)!, artboard));
      return await page.evaluate(() => {
        const q = (c: string) => [...document.querySelectorAll(`[data-class="${c}"]`)] as HTMLElement[];
        const r = (el: Element) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
        const card = q('card')[0]!;
        const after = getComputedStyle(card, '::after');
        return {
          cards: q('card').map(r),
          cardPosition: getComputedStyle(card).position,
          cardTransform: getComputedStyle(card).transform,
          afterBg: after.backgroundColor,
          afterPosition: after.position,
          wide: r(q('wide quarter')[0]!),
          quarters: q('quarter').map(r),
          bold: getComputedStyle(document.querySelector('pre b')!).fontWeight,
          preText: document.querySelector('pre')!.textContent,
          dots: getComputedStyle(q('dots')[0]!).backgroundImage,
          dotsSize: getComputedStyle(q('dots')[0]!).backgroundSize,
          pill: getComputedStyle(q('pill')[0]!).color,
          hasKeyframes: [...document.styleSheets].some((s) => [...s.cssRules].some((x) => x instanceof CSSKeyframesRule)),
        };
      });
    } finally {
      await context.close();
    }
  };

  const desk = await measure(wide, 1440);
  assert.equal(desk.cardPosition, 'relative');
  assert.equal(desk.cardTransform, 'none', 'hover is inert at rest');
  assert.equal(desk.afterPosition, 'absolute');
  assert.equal(desk.afterBg, 'rgba(217, 58, 11, 0.05)');
  assert.deepEqual(desk.cards.map((c) => [c.y, c.w]), [[0, 300], [120, 300]], 'cards stack in flow at 300px');
  assert.equal(desk.wide.x, 0);
  assert.equal(desk.wide.h, 120);
  // Five cells in a 12-column grid: a, b, c fill the first row beside the
  // two-row cell; d wraps under a.
  assert.deepEqual(desk.quarters.map((q) => Math.round(q.y)), [240, 240, 240, 370]);
  assert.ok(desk.quarters.slice(0, 3).every((q, i, all) => i === 0 || q.x > all[i - 1]!.x));
  assert.equal(desk.bold, '700');
  assert.equal(desk.preText, 'Test 3: bold');
  assert.match(desk.dots, /radial-gradient/);
  assert.equal(desk.dotsSize, '36px 32px');
  assert.equal(desk.pill, 'rgb(217, 58, 11)', 'var() resolves through the token');
  assert.ok(desk.hasKeyframes, '@keyframes is kept');

  const phone = await measure(narrow, 390);
  assert.deepEqual(phone.cards.map((c) => c.w), [390, 390], 'the media query fires against the 390 artboard');
});
