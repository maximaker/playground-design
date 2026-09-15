/**
 * What changed since a checkpoint.
 *
 *   node scripts/changes-check.mjs [base]
 *
 * The question a developer actually has is not what the design is — the spec
 * answers that — but what moved after they started building. The checks are
 * mostly about *not* reporting things: a value nudged and put back, an artboard
 * dragged across the canvas, or the parent of a deleted card, are all
 * differences that nobody needs to hear about.
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
  body: JSON.stringify({ name: 'Changes check' }),
})).json()).document;

const raw = await (await fetch(`${BASE}/api/documents/${doc.id}/connections`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'changes check' }),
})).text();
const client = new Client({ name: 'changes-check', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/${raw.match(/\/mcp\/([A-Z0-9-]+)/)[1]}`)));
const call = async (n, a = {}) => {
  const r = await client.callTool({ name: n, arguments: a });
  const t = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r.isError) throw new Error(`${n}: ${t}`);
  return t;
};

await call('set_tokens', { tokens: [{ name: 'color.brand', group: 'color', values: { default: '#4F46E5' } }] });
const board = JSON.parse(await call('get_basic_info')).artboards[0].id;
const written = JSON.parse(await call('write_html', {
  targetId: board, mode: 'replace-children',
  html: `<div style="padding:40px;display:flex;flex-direction:column;gap:24px">
    <h1 style="margin:0;font-size:48px">Pricing</h1>
    <div style="padding:28px;border-radius:16px;background:#fff">
      <strong>Audit</strong><p style="margin:0">Two weeks.</p>
    </div>
  </div>`,
}));
const root = written.roots[0].id;
const kids = JSON.parse(await call('get_children', { id: root }));
const heading = kids[0].id;
const card = kids[1].id;

// --- No checkpoint, no answer ------------------------------------------------

let noCheckpoint = '';
try { await call('changes_since'); } catch (e) { noCheckpoint = e.message; }
check('without a checkpoint it says to make one', noCheckpoint.includes('mark_checkpoint'),
  noCheckpoint.slice(0, 70));

const cp = JSON.parse(await call('mark_checkpoint', { label: 'Handover v1' }));
check('a checkpoint can be marked', !!cp.checkpoint, `${cp.checkpoint} at rev ${cp.rev}`);

check('nothing has changed yet', JSON.parse(await call('changes_since')).same === true);

// --- The things that should be reported ---------------------------------------

await call('update_styles', { updates: [{ id: card, styles: { padding: '40px' } }] });
await call('set_text_content', { updates: [{ id: heading, text: 'Pricing and plans' }] });
const added = JSON.parse(await call('write_html', {
  targetId: root, html: '<footer style="padding:16px">Small print</footer>',
}));
await call('set_tokens', { tokens: [{ name: 'color.brand', group: 'color', values: { default: '#3730A3' } }] });

const diff = JSON.parse(await call('changes_since'));
check('a changed style is reported with both values',
  diff.nodes.some((n) => n.id === card
    && n.fields.some((f) => f.field === 'styles.padding' && f.before === '28px' && f.after === '40px')),
  JSON.stringify(diff.nodes.find((n) => n.id === card)?.fields?.[0]));
check('changed text too',
  diff.nodes.some((n) => n.id === heading
    && n.fields.some((f) => f.field === 'text' && f.after === 'Pricing and plans')));
check('an addition is reported once, by its root',
  diff.nodes.filter((n) => n.kind === 'added').length === 1,
  `${diff.counts.added} added`);
check('a token that moved is reported separately',
  diff.tokens.some((t) => t.field === 'color.brand' && t.after?.includes('3730A3')));
check('and the changes are grouped by artboard', diff.byArtboard[0]?.changes >= 2,
  diff.byArtboard.map((b) => `${b.name}: ${b.changes}`).join(', '));

// --- The things that should not be --------------------------------------------

await call('update_styles', { updates: [{ id: heading, styles: { 'font-size': '60px' } }] });
await call('update_styles', { updates: [{ id: heading, styles: { 'font-size': '48px' } }] });
const afterNudge = JSON.parse(await call('changes_since'));
check('a value nudged and put back is not a change',
  !afterNudge.nodes.some((n) => n.id === heading && n.fields.some((f) => f.field === 'styles.font-size')),
  'font-size not reported');

await call('set_attributes', { updates: [{ id: board, attrs: { 'data-x': '1200', 'data-y': '300' } }] });
const afterDrag = JSON.parse(await call('changes_since'));
check('dragging an artboard across the canvas is not a change',
  !afterDrag.nodes.some((n) => n.id === board && n.fields.some((f) => f.field.startsWith('attrs.data-'))));

await call('delete_nodes', { ids: [added.roots[0].id] });
const afterDelete = JSON.parse(await call('changes_since'));
check('a deletion is reported without also reporting its parent',
  afterDelete.counts.removed === 0 && afterDelete.counts.added === 0,
  `${afterDelete.counts.added} added, ${afterDelete.counts.removed} removed`);

// Removing something that existed at the checkpoint *is* a change.
await call('delete_nodes', { ids: [card] });
const afterRealDelete = JSON.parse(await call('changes_since'));
check('removing something that was there is reported',
  afterRealDelete.counts.removed === 1
  && !afterRealDelete.nodes.some((n) => n.id === root && n.fields.some((f) => f.field === 'children')),
  `${afterRealDelete.counts.removed} removed, parent quiet`);

const narrowed = JSON.parse(await call('changes_since', { within: heading }));
check('the report can be narrowed to one subtree',
  narrowed.nodes.length === 1 && narrowed.nodes[0].id === heading, `${narrowed.nodes.length} node(s)`);

// --- In the panel ---------------------------------------------------------------

const browser = await chromium.launch({ headless: true });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/d/${doc.id}`, { waitUntil: 'networkidle' });
await page.waitForSelector('.artboard-frame iframe', { timeout: 30000 });
// History lives along the bottom of the canvas now, not in a rail: it is a
// record of what has been done rather than part of what the document is.
await page.click('.history-bar-strip');
await page.waitForTimeout(900);

const compare = page.locator('.history-row button', { hasText: 'Compare' }).first();
check('a saved version offers a comparison', (await compare.count()) === 1);
await compare.click();
await page.waitForTimeout(900);
check('the comparison lists what moved', (await page.locator('.change-row').count()) > 0,
  `${await page.locator('.change-row').count()} rows`);
check('with the old and new values on the row',
  (await page.locator('.change-field code').count()) > 0);

// The panel must follow the document: a comparison one edit stale looks current.
await call('set_text_content', { updates: [{ id: heading, text: 'Pricing, plans and add-ons' }] });
await page.waitForTimeout(1500);
check('and it keeps up as the document changes',
  (await page.locator('.history-bar-body').innerText()).includes('add-ons')
  || (await page.locator('.change-field').allInnerTexts()).some((t) => t.includes('add-ons')),
  'text change appeared');

await page.click('.change-row.is-clickable');
await page.waitForTimeout(500);
check('clicking a change selects that layer',
  (await page.evaluate(() => window.__playground.store.getState().selection.length)) === 1);

await page.screenshot({ path: '/tmp/changes-panel.png' });
check('no runtime errors', errors.length === 0, errors[0] ?? '');

await browser.close();
await client.close();
await fetch(`${BASE}/api/documents/${doc.id}`, { method: 'DELETE' });

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} of ${results.length} checks failed` : `\nall ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
