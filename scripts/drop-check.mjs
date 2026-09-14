/**
 * Dropping an image onto the canvas.
 *
 * Playwright cannot drag a file from the OS, so the drop is synthesised with a
 * real DataTransfer built inside the page. That is a fair test of everything
 * this feature owns — the handlers, the upload, the placement — and the part it
 * cannot cover (the browser producing the event) is not ours.
 *
 * The two placements are different decisions and both are checked: onto a
 * container the image goes inside it; onto empty canvas it gets an artboard of
 * its own, because dropping a screenshot to work from is why people drag an
 * image in at all.
 */

import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://localhost:4000';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
};

const doc = await (await fetch(`${BASE}/api/documents`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Drop check', template: 'clean' }),
})).json();
const docId = doc.document.id;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/d/${docId}`, { waitUntil: 'networkidle' });
await page.waitForSelector('.artboard-frame iframe', { timeout: 20000 });
await page.waitForTimeout(1200);

/** A real 120×80 PNG, so natural size is something to assert against. */
const PNG_120x80 = await (async () => {
  const b = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 120; c.height = 80;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#4f46e5';
    ctx.fillRect(0, 0, 120, 80);
    return c.toDataURL('image/png');
  });
  return b;
})();

const dropAt = (x, y, dataUrl, name) => page.evaluate(async ([px, py, url, filename]) => {
  const blob = await (await fetch(url)).blob();
  const file = new File([blob], filename, { type: 'image/png' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const canvas = document.querySelector('.canvas');
  const opts = { bubbles: true, cancelable: true, clientX: px, clientY: py, dataTransfer: dt };
  canvas.dispatchEvent(new DragEvent('dragover', opts));
  canvas.dispatchEvent(new DragEvent('drop', opts));
}, [x, y, dataUrl, name]);

const state = () => page.evaluate(() => {
  const s = window.__playground.store.getState();
  return {
    images: Object.values(s.doc.nodes).filter((n) => n.type === 'image')
      .map((n) => ({ id: n.id, parent: n.parent, name: n.name, w: n.styles.width, h: n.styles.height })),
    artboards: s.doc.pages[0].artboards.length,
  };
});

// --- The affordance appears only for a file drag --------------------------

const board = await page.evaluate(() => {
  const r = document.querySelector('.artboard-frame').getBoundingClientRect();
  const c = document.querySelector('.canvas').getBoundingClientRect();
  return {
    inside: { x: Math.round(Math.max(c.left + 40, r.left + 100)), y: Math.round(Math.max(c.top + 40, r.top + 100)) },
    empty: { x: Math.round(c.left + 60), y: Math.round(c.bottom - 80) },
  };
});

await page.evaluate(([x, y]) => {
  const dt = new DataTransfer();
  dt.setData('text/plain', 'a layer being dragged, not a file');
  document.querySelector('.canvas').dispatchEvent(
    new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }),
  );
}, [board.inside.x, board.inside.y]);
await page.waitForTimeout(200);
check('a drag with no files is ignored', await page.locator('.canvas-dropzone').count() === 0);

// --- Dropped on a container: it goes inside ------------------------------

const before = await state();
await dropAt(board.inside.x, board.inside.y, PNG_120x80, 'inside.png');
await page.waitForTimeout(1800);
const afterInside = await state();

const added = afterInside.images.filter((i) => !before.images.some((b) => b.id === i.id));
check('the image is added', added.length === 1, `${added.length} added`);
check('at its natural size', added[0]?.w === '120px' && added[0]?.h === '80px',
  `${added[0]?.w} × ${added[0]?.h}`);
check('inside the container it was dropped on', !!added[0]?.parent, added[0]?.parent ?? 'none');
check('no new artboard was made', afterInside.artboards === before.artboards,
  `${before.artboards} -> ${afterInside.artboards}`);

// --- Dropped on empty canvas: it gets an artboard ------------------------

await dropAt(board.empty.x, board.empty.y, PNG_120x80, 'screenshot.png');
await page.waitForTimeout(2200);
const afterEmpty = await state();

check('dropping on empty canvas makes an artboard',
  afterEmpty.artboards === afterInside.artboards + 1,
  `${afterInside.artboards} -> ${afterEmpty.artboards}`);

const onCanvas = await page.evaluate(() => {
  const s = window.__playground.store.getState();
  const id = s.doc.pages[0].artboards[s.doc.pages[0].artboards.length - 1];
  const n = s.doc.nodes[id];
  return { name: n.name, w: n.styles.width, h: n.styles.height, children: n.children.length };
});
check('the artboard is the size of the image', onCanvas.w === '120px' && onCanvas.h === '80px',
  `${onCanvas.w} × ${onCanvas.h}`);
check('and is named after the file', onCanvas.name === 'screenshot', onCanvas.name);
check('with the image inside it', onCanvas.children === 1, String(onCanvas.children));

// --- A viewer cannot drop -------------------------------------------------

const made = await (await fetch(`${BASE}/api/documents/${docId}/shares`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'View' }),
})).json();

const viewer = await browser.newPage({ viewport: { width: 1500, height: 950 } });
viewer.on('pageerror', (e) => errors.push(`viewer: ${e.message}`));
await viewer.goto(`${BASE}/s/${made.share.token}`, { waitUntil: 'networkidle' });
await viewer.waitForSelector('.artboard-frame iframe', { timeout: 20000 });
await viewer.waitForTimeout(1500);

const viewerBefore = await viewer.evaluate(() =>
  Object.values(window.__playground.store.getState().doc.nodes).filter((n) => n.type === 'image').length);
await viewer.evaluate(async ([url]) => {
  const blob = await (await fetch(url)).blob();
  const dt = new DataTransfer();
  dt.items.add(new File([blob], 'nope.png', { type: 'image/png' }));
  const c = document.querySelector('.canvas');
  const r = c.getBoundingClientRect();
  const opts = { bubbles: true, cancelable: true, clientX: r.left + 200, clientY: r.top + 200, dataTransfer: dt };
  c.dispatchEvent(new DragEvent('dragover', opts));
  c.dispatchEvent(new DragEvent('drop', opts));
}, [PNG_120x80]);
await viewer.waitForTimeout(1500);
const viewerAfter = await viewer.evaluate(() =>
  Object.values(window.__playground.store.getState().doc.nodes).filter((n) => n.type === 'image').length);
check('a view-only link cannot drop images', viewerBefore === viewerAfter,
  `${viewerBefore} -> ${viewerAfter}`);

check('no runtime errors', errors.length === 0, errors[0] ?? '');

await browser.close();
await fetch(`${BASE}/api/documents/${docId}`, { method: 'DELETE' });

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} of ${results.length} checks failed` : `\nall ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
