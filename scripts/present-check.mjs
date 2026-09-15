/**
 * Presentation mode.
 *
 *   node scripts/present-check.mjs [base]
 *
 * The claim worth checking is not that a big picture appears. It is that a
 * presented frame is still a real browser viewport: scaled with a transform,
 * so a 1440px design shown at 40% is the desktop layout made small rather than
 * the mobile layout — and that a comment left while presenting is the same
 * comment, in the same place, as one left on the canvas.
 */

import './lib/session.mjs';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = process.argv[2] ?? 'http://localhost:4000';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
};

const doc = (await (await fetch(`${BASE}/api/documents`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Presentation' }),
})).json()).document;
const raw = await (await fetch(`${BASE}/api/documents/${doc.id}/connections`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'present' }),
})).text();
const client = new Client({ name: 'present', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/${raw.match(/\/mcp\/([A-Z0-9-]+)/)[1]}`)));
const call = async (n, a = {}) => {
  const r = await client.callTool({ name: n, arguments: a });
  const t = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r.isError) throw new Error(`${n}: ${t}`);
  return t;
};

// Three frames, and one of them responds to its own width — the thing a
// screenshot in a slide deck cannot do.
const first = JSON.parse(await call('get_basic_info')).artboards[0];
await call('write_html', {
  targetId: first.id, mode: 'replace-children',
  html: `<div style="padding:60px;background:#fff;font:600 48px/1.1 Inter,sans-serif">Frame one</div>`,
});
const wide = JSON.parse(await call('create_artboard', { name: 'Wide', width: 1440, height: 900, x: 1700, y: 0 }));
await call('write_html', {
  targetId: wide.id, mode: 'replace-children',
  html: `<div id="probe" style="padding:60px;background:#fff">
    <h1 style="font:600 56px/1 Inter,sans-serif;margin:0">Responsive</h1>
    <style>@media (max-width: 800px) { #probe h1 { font-size: 20px } }</style>
  </div>`,
});
const third = JSON.parse(await call('create_artboard', { name: 'Third', width: 900, height: 700, x: 3400, y: 0 }));
await call('write_html', {
  targetId: third.id, mode: 'replace-children',
  html: `<div style="padding:60px;background:#fff;font:600 40px/1.1 Inter,sans-serif">Frame three</div>`,
});

const browser = await chromium.launch({ headless: true });
const errors = [];
const view = await browser.newPage({ viewport: { width: 1280, height: 820 } });
view.on('pageerror', (e) => errors.push(e.message));
await view.goto(`${BASE}/d/${doc.id}`, { waitUntil: 'networkidle' });
await view.waitForSelector('.artboard-frame iframe', { timeout: 30000 });
await view.waitForTimeout(2200);

// --- Getting in and out --------------------------------------------------------

await view.mouse.click(640, 400);
await view.keyboard.press('p');
await view.waitForTimeout(1200);
check('P starts presenting', (await view.locator('.present').count()) === 1);
check('and the editor chrome is gone behind it',
  !(await view.locator('.rail-left').isVisible().catch(() => false))
  || (await view.evaluate(() => {
    const present = document.querySelector('.present');
    const rail = document.querySelector('.rail-left');
    return !!present && !!rail
      && Number(getComputedStyle(present).zIndex) > Number(getComputedStyle(rail).zIndex);
  })));

check('the frame is named in the bar',
  (await view.locator('.present-title').innerText()).includes('Desktop'),
  (await view.locator('.present-title').innerText()).replace(/\n/g, ' '));

// --- Moving through the deck ----------------------------------------------------

const counter = () => view.locator('.present-counter').innerText();
check('the counter says where you are', (await counter()).trim() === '1 / 3', await counter());

await view.keyboard.press('ArrowRight');
await view.waitForTimeout(800);
check('arrow right goes to the next frame', (await counter()).trim() === '2 / 3');
await view.keyboard.press(' ');
await view.waitForTimeout(800);
check('and space does the same', (await counter()).trim() === '3 / 3');
await view.keyboard.press('ArrowRight');
await view.waitForTimeout(500);
check('the end of the deck is the end, not a wrap', (await counter()).trim() === '3 / 3');
await view.keyboard.press('Home');
await view.waitForTimeout(700);
check('Home returns to the first', (await counter()).trim() === '1 / 3');

// A click advances, the way it does in every presentation tool.
await view.mouse.click(640, 300);
await view.waitForTimeout(700);
check('clicking the design advances', (await counter()).trim() === '2 / 3');

// --- A frame is still a viewport -------------------------------------------------

const probe = await view.evaluate(() => {
  const frame = document.querySelector('.present-frame iframe');
  const inner = document.querySelector('.present-frame-inner');
  const h1 = frame?.contentDocument?.querySelector('h1');
  return {
    frameWidth: frame?.getBoundingClientRect().width,
    declaredWidth: Number(frame?.style.width.replace('px', '')),
    transform: getComputedStyle(inner).transform,
    fontSize: h1 ? getComputedStyle(h1).fontSize : null,
  };
});
check('the frame is scaled by transform, not by shrinking the viewport',
  probe.declaredWidth === 1440 && probe.transform !== 'none',
  JSON.stringify(probe));
check('so a 1440px design shown small is still the 1440px design',
  probe.fontSize === '56px', `h1 is ${probe.fontSize} at ${Math.round(probe.frameWidth)}px on screen`);

// Fill width is the other half of that: the design responding to the window.
await view.locator('.present-scaling button', { hasText: 'Fill width' }).click();
await view.waitForTimeout(800);
const filled = await view.evaluate(() => {
  const frame = document.querySelector('.present-frame iframe');
  return Math.round(frame.getBoundingClientRect().width);
});
check('fill width uses the whole window', Math.abs(filled - 1280) < 4, `${filled}px`);
await view.locator('.present-scaling button', { hasText: 'Fit' }).first().click();
await view.waitForTimeout(600);

// --- Scrolling and zooming ---------------------------------------------------------

await view.locator('.present-scaling button', { hasText: 'Actual size' }).click();
await view.waitForTimeout(700);
const actual = await view.evaluate(() => {
  const stage = document.querySelector('.present-stage');
  const frame = document.querySelector('.present-frame iframe');
  return {
    scrollable: stage.scrollHeight > stage.clientHeight || stage.scrollWidth > stage.clientWidth,
    onScreen: Math.round(frame.getBoundingClientRect().width),
    // A scrollbar would take width from the content box; none of ours do.
    bar: stage.offsetWidth - stage.clientWidth,
  };
});
check('at actual size the frame is 1:1 and the stage scrolls',
  actual.onScreen === 1440 && actual.scrollable, JSON.stringify(actual));
check('and no scrollbar is drawn for it', actual.bar === 0, `${actual.bar}px of furniture`);

// The bug that came out of this: clicking a frame moves focus into its iframe
// document, and from then on the arrows belonged to that window.
await view.mouse.move(640, 400);
await view.evaluate(() => {
  document.querySelector('.present-frame iframe').contentDocument.body.focus();
});
await view.keyboard.press('ArrowRight');
await view.waitForTimeout(700);
check('the arrows still work after the frame has taken focus',
  (await counter()).trim() === '3 / 3', await counter());
await view.keyboard.press('ArrowLeft');
await view.waitForTimeout(600);

// ⌘-wheel zooms the presentation rather than the window.
await view.mouse.move(640, 400);
await view.keyboard.down('Meta');
await view.mouse.wheel(0, -240);
await view.keyboard.up('Meta');
await view.waitForTimeout(600);
const zoomed = await view.evaluate(() => {
  const el = document.querySelector('.present-zoom');
  const frame = document.querySelector('.present-frame iframe');
  return { readout: el?.textContent, width: Math.round(frame.getBoundingClientRect().width) };
});
check('⌘-wheel zooms the frame and says by how much',
  !!zoomed.readout && zoomed.width > 1440, JSON.stringify(zoomed));
await view.locator('.present-zoom').click();
await view.waitForTimeout(500);
check('and the readout puts it back', (await view.locator('.present-zoom').count()) === 0);

await view.locator('.present-scaling button', { hasText: 'Fit' }).first().click();
await view.waitForTimeout(600);

// --- The bar gets out of the way ---------------------------------------------------

await view.mouse.move(640, 410);
await view.waitForTimeout(200);
check('the bar is there when the pointer moves',
  !(await view.evaluate(() => document.querySelector('.present').classList.contains('is-idle'))));
await view.waitForTimeout(3200);
check('and fades out of the way when it stops',
  await view.evaluate(() => document.querySelector('.present').classList.contains('is-idle')));
await view.mouse.move(600, 400);
await view.waitForTimeout(200);

// --- Comments ----------------------------------------------------------------------

// The bar hides itself after a few idle seconds, so wake it before reaching
// for one of its buttons — the same thing a person does with the mouse.
const bar = async (label) => {
  await view.mouse.move(640, 700);
  await view.waitForTimeout(250);
  await view.locator(`.present-bar button[aria-label="${label}"]`).click();
  await view.waitForTimeout(500);
};

await bar('Comments');
await view.mouse.click(500, 300);
await view.waitForTimeout(500);
const drafts = await view.locator('.comment-pin.is-draft').count();
const at = (await counter()).trim();
check('with comments on, a click opens a composer instead of advancing',
  drafts === 1 && at === '2 / 3', `${drafts} draft(s), on ${at}`);

await view.keyboard.type('Does this heading need to be this large?');
await view.keyboard.press('Enter');
await view.waitForTimeout(800);
const stored = await view.evaluate(() => {
  const st = window.__playground.store.getState();
  const c = (st.doc.comments ?? [])[0];
  const board = st.doc.nodes[st.present ? st.doc.pages.find((p) => p.id === st.present.pageId).artboards[1] : ''];
  return c && board ? {
    text: c.text,
    inside: c.x >= Number(board.attrs['data-x'] ?? 0)
      && c.x <= Number(board.attrs['data-x'] ?? 0) + parseFloat(board.styles.width),
  } : null;
});
check('the comment is stored on the document', !!stored?.text, stored?.text ?? '(none)');
check('and lands inside the frame it was left on, in canvas coordinates',
  !!stored?.inside, JSON.stringify(stored));

// Escape now has nothing to cancel — the comment is posted — so it would
// leave the presentation; the toggle is the way back to plain viewing.
await bar('Comments');
check('turning comments off leaves the pins behind',
  (await view.locator('.comment-pin').count()) === 0);

// --- The link ----------------------------------------------------------------------

const url = view.url();
check('the presentation is in the URL', /present=.+&frame=2/.test(url), url);

await view.reload({ waitUntil: 'networkidle' });
await view.waitForTimeout(2500);
check('so a reload — or someone else opening the link — resumes it',
  (await view.locator('.present').count()) === 1 && (await counter()).trim() === '2 / 3',
  await counter().catch(() => 'not presenting'));

await view.mouse.move(640, 700);
await view.waitForTimeout(300);
await view.screenshot({ path: '/tmp/present-check.png' });

await view.keyboard.press('Escape');
await view.waitForTimeout(600);
check('Escape leaves', (await view.locator('.present').count()) === 0);
check('and the URL is clean again', !/present=/.test(view.url()), view.url());

// --- A viewer on a share link ---------------------------------------------------------

const share = await (await fetch(`${BASE}/api/documents/${doc.id}/shares`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
})).json().catch(() => null);
if (share?.share?.token || share?.token) {
  const token = share.share?.token ?? share.token;
  const guest = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  await guest.goto(`${BASE}/s/${token}`, { waitUntil: 'networkidle' });
  await guest.waitForTimeout(2500);
  const presentButton = guest.locator('button', { hasText: 'Present' });
  check('a share-link viewer can present too', (await presentButton.count()) >= 1);
  if (await presentButton.count()) {
    await presentButton.first().click();
    await guest.waitForTimeout(1500);
    check('and it shows the same deck',
      (await guest.locator('.present-counter').innerText()).includes('/ 3'),
      await guest.locator('.present-counter').innerText().catch(() => 'none'));
  }
  await guest.close();
}

check('no runtime errors', errors.length === 0, errors[0] ?? '');
await browser.close();
await client.close();
await fetch(`${BASE}/api/documents/${doc.id}`, { method: 'DELETE' });

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} of ${results.length} checks failed` : `\nall ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
