/**
 * Working with components in the editor: reaching the original from an
 * instance, inserting one and being able to see where it went, making a
 * variant, and nesting one component inside another.
 *
 *   node scripts/components-ux-check.mjs [base]
 *
 * A component definition belongs to no page, so it is never on the canvas and
 * never in the layer tree. Everything here is about that: the ways to reach a
 * thing you cannot point at.
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
  body: JSON.stringify({ name: 'Components UX' }),
})).json()).document;

const raw = await (await fetch(`${BASE}/api/documents/${doc.id}/connections`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'components ux' }),
})).text();
const client = new Client({ name: 'components-ux', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/${raw.match(/\/mcp\/([A-Z0-9-]+)/)[1]}`)));
const call = async (n, a = {}) => {
  const r = await client.callTool({ name: n, arguments: a });
  const t = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r.isError) throw new Error(`${n}: ${t}`);
  return t;
};

// A card with a tag inside it: the tag becomes a component, then the card does,
// which leaves a component nested inside a component.
const board = JSON.parse(await call('get_basic_info')).artboards[0];
const written = JSON.parse(await call('write_html', {
  targetId: board.id, mode: 'replace-children',
  html: `<div style="padding:40px;display:flex;flex-direction:column;gap:20px;background:#fff">
    <div style="padding:20px;border:1px solid #ddd;border-radius:12px;display:flex;flex-direction:column;gap:8px">
      <strong>Audit</strong>
      <span style="padding:6px 14px;border-radius:999px;background:#1c1c1c;color:#fff;width:fit-content">shipped</span>
    </div>
  </div>`,
}));
const page = written.roots[0].id;
const card = JSON.parse(await call('get_children', { id: page }))[0];
const tagNode = JSON.parse(await call('get_children', { id: card.id }))[1];
const tag = JSON.parse(await call('create_component', { id: tagNode.id, name: 'Tag' }));
const cardCmp = JSON.parse(await call('create_component', { id: card.id, name: 'Card' }));

// --- Nesting -------------------------------------------------------------------

const stored = (await (await fetch(`${BASE}/api/documents/${doc.id}`)).json()).document;
const inside = stored.nodes[stored.components[cardCmp.componentId].root].children
  .map((id) => stored.nodes[id]);
check('a component can contain an instance of another',
  inside.some((n) => n.type === 'instance' && n.componentRef === tag.componentId),
  inside.map((n) => n.type).join(', '));

await call('insert_instance', { componentId: cardCmp.componentId, parentId: page });
await call('update_styles', { updates: [{ id: tag.definitionRoot, styles: { background: '#0d8a72' } }] });
const html = await call('get_html', { id: board.id });
check('editing the inner component reaches every outer instance',
  (html.match(/#0d8a72/g) ?? []).length === 2, `${(html.match(/#0d8a72/g) ?? []).length} tags`);

const listed = JSON.parse(await call('list_components')).components;
check('and the nested use is counted as use',
  listed.find((c) => c.name === 'Tag')?.instances >= 1,
  listed.map((c) => `${c.name} ×${c.instances}`).join(', '));

// --- In the editor ---------------------------------------------------------------

const browser = await chromium.launch({ headless: true });
const errors = [];
const view = await browser.newPage({ viewport: { width: 1500, height: 950 } });
view.on('pageerror', (e) => errors.push(e.message));
await view.goto(`${BASE}/d/${doc.id}`, { waitUntil: 'networkidle' });
await view.waitForSelector('.artboard-frame iframe', { timeout: 30000 });
await view.waitForTimeout(2000);

await view.click('.rail-left .rail-tabs button[aria-label="Components"]');
await view.waitForTimeout(2000);
const tiles = await view.$$eval('.component-tile', (els) => els.map((e) => e.innerText.replace(/\n/g, ' · ')));
check('the panel says where a nested component is used',
  tiles.some((t) => t.includes('in Card')), tiles.join(' | '));

// Inserting: selected, and brought into view.
await view.evaluate(() => window.__playground.store.getState().select([]));
await view.evaluate(() => window.__playground.store.getState().setViewport({ x: -6000, y: -4000 }));
await view.waitForTimeout(300);
// By its name row, not by "contains Card": the Tag tile also says "in Card".
await view.locator('.component-tile', { has: view.locator('.component-name', { hasText: /^Card$/ }) })
  .locator('.component-main').click();
await view.waitForTimeout(1200);
// Measured through the document, not the screen: the point of revealing is
// that the thing was off screen, and an off-screen artboard is not rendered —
// so there is no element to ask.
const afterInsert = await view.evaluate(() => {
  const st = window.__playground.store.getState();
  const doc = st.doc;
  const id = st.selection[0]?.split('::')[0];
  if (!id) return { selected: false };
  let node = doc.nodes[id];
  while (node && node.type !== 'artboard') node = node.parent ? doc.nodes[node.parent] : undefined;
  if (!node) return { selected: true, onScreen: false };
  const x = Number(node.attrs?.['data-x'] ?? 0);
  const y = Number(node.attrs?.['data-y'] ?? 0);
  const w = parseFloat(node.styles?.width ?? '0');
  const h = parseFloat(node.styles?.height ?? '0');
  const stage = document.querySelector('.stage').getBoundingClientRect();
  const vp = st.viewport;
  const left = stage.left + vp.x + x * vp.zoom;
  const top = stage.top + vp.y + y * vp.zoom;
  return {
    selected: true,
    // Overlapping the stage at all is the claim: the artboard may be larger
    // than the window, and "centred" is not the promise — "findable" is.
    onScreen: left < stage.right && left + w * vp.zoom > stage.left
      && top < stage.bottom && top + h * vp.zoom > stage.top,
  };
});
check('inserting selects the new instance', afterInsert.selected);
check('and brings it into view', afterInsert.onScreen, JSON.stringify(afterInsert));

// From an instance back to the component it came from.
await view.click('.rail-right .rail-tabs button[aria-label="Design"]');
await view.waitForTimeout(500);
const goTo = view.locator('button', { hasText: 'Go to component' });
check('an instance offers the way back to its component', (await goTo.count()) >= 1);
await goTo.first().click();
await view.waitForTimeout(800);
const opened = await view.evaluate(() => {
  const st = window.__playground.store.getState();
  const doc = st.doc;
  const id = st.selection[0];
  const def = Object.values(doc.components ?? {}).find((c) => c.root === id);
  return { onDefinition: !!def, name: def?.name };
});
check('following it selects the definition itself', opened.onDefinition, opened.name ?? '(not a definition)');
check('and shows the component panel with its layers',
  (await view.locator('.definition-tree .definition-row').count()) > 0,
  `${await view.locator('.definition-tree .definition-row').count()} layers`);

// Editing a definition layer from that list changes every instance.
await view.locator('.definition-tree .definition-row').first().click();
await view.waitForTimeout(400);
check('selecting a definition layer puts it in the inspector',
  (await view.locator('.rail-right .prop-title').innerText()).length > 0,
  (await view.locator('.rail-right .prop-title').innerText()).replace(/\n/g, ' · '));

// --- Variants ----------------------------------------------------------------------

const addProp = view.locator('.variant-editor button', { hasText: 'Add a property' });
check('the variant editor offers a property to vary by', (await addProp.count()) === 1);

await view.screenshot({ path: '/tmp/components-ux.png' });
check('no runtime errors', errors.length === 0, errors[0] ?? '');
await browser.close();
await client.close();
await fetch(`${BASE}/api/documents/${doc.id}`, { method: 'DELETE' });

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} of ${results.length} checks failed` : `\nall ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
