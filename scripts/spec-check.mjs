/**
 * The handover spec: derived measurements, and typed notes for what CSS cannot
 * say.
 *
 *   node scripts/spec-check.mjs [base]
 *
 * The claim this makes is that a spec here cannot be out of date, so the check
 * proves the two halves of that: the numbers come from the document (change the
 * padding, the spec changes with it, with nobody re-publishing anything), and
 * the notes are the only stored part.
 */

import { signedOutPage } from './lib/session.mjs';
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
  body: JSON.stringify({ name: 'Spec check' }),
})).json()).document;

const raw = await (await fetch(`${BASE}/api/documents/${doc.id}/connections`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'spec check' }),
})).text();
const client = new Client({ name: 'spec-check', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/${raw.match(/\/mcp\/([A-Z0-9-]+)/)[1]}`)));
const call = async (n, a = {}) => {
  const r = await client.callTool({ name: n, arguments: a });
  const t = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r.isError) throw new Error(`${n}: ${t}`);
  return t;
};

await call('set_tokens', { tokens: [
  { name: 'color.brand', group: 'color', values: { default: '#4F46E5', dark: '#818CF8' } },
  { name: 'space.card', group: 'space', values: { default: '28px' } },
]});

const board = JSON.parse(await call('get_basic_info')).artboards[0];
const written = JSON.parse(await call('write_html', {
  targetId: board.id, mode: 'replace-children',
  html: `<style>
    .cta { display:inline-flex; align-items:center; padding:var(--space-card); width:fit-content;
           background:var(--color-brand); color:#fff; border-radius:999px; }
    .cta:hover { background:#3730a3; }
    @media (max-width: 600px) { .cta { padding: 12px; } }
  </style>
  <div style="padding:40px"><a class="cta" href="/book">Book a review</a></div>`,
}));
const cta = JSON.parse(await call('get_children', { id: written.roots[0].id }))[0];

// --- The derived half -------------------------------------------------------

const spec = JSON.parse(await call('get_spec', { id: cta.id }));
check('a spec reports a measured size, not the authored one',
  spec.box?.height > 0 && spec.box?.width > 0, `${spec.box?.width} × ${spec.box?.height}`);
const authoredWidth = spec.groups.flatMap((g) => g.entries).find((e) => e.label === 'width');
check('while still quoting what is authored', authoredWidth?.value.value === 'fit-content');

const padding = spec.groups.flatMap((g) => g.entries).find((e) => e.label === 'padding');
check('a token reference is resolved to its name and value',
  padding?.value.token === 'space.card' && padding?.value.resolved === '28px',
  JSON.stringify(padding?.value));

const bg = spec.groups.flatMap((g) => g.entries).find((e) => e.label === 'background');
check('and colours the same way', bg?.value.token === 'color.brand', JSON.stringify(bg?.value));

const dark = JSON.parse(await call('get_spec', { id: cta.id, theme: 'dark', measure: false }));
const darkBg = dark.groups.flatMap((g) => g.entries).find((e) => e.label === 'background');
check('another theme resolves to that theme\'s value', darkBg?.value.resolved === '#818CF8',
  darkBg?.value.resolved);

check('hover and breakpoint rules are listed in words',
  spec.variants.some((v) => v.when === 'on hover')
  && spec.variants.some((v) => v.when === 'up to 600px wide'),
  spec.variants.map((v) => v.when).join(', '));

check('the code to build it comes with it',
  spec.html?.includes('Book a review') && spec.jsx?.includes('Book a review'));

// The whole claim in one assertion: change the design, the spec changes.
await call('update_styles', { updates: [{ id: cta.id, styles: { padding: '40px' } }] });
const after = JSON.parse(await call('get_spec', { id: cta.id }));
const newPadding = after.groups.flatMap((g) => g.entries).find((e) => e.label === 'padding');
check('editing the design changes the spec, with nothing to re-publish',
  newPadding?.value.value === '40px' && after.box.height !== spec.box.height,
  `${spec.box.height} → ${after.box.height}`);

// --- The stored half ----------------------------------------------------------

await call('annotate', {
  id: cta.id, kind: 'behaviour',
  text: 'Opens the booking modal. Disabled while the request is in flight.',
});
await call('annotate', { id: cta.id, kind: 'data', text: 'Href comes from settings.bookingUrl.' });

const noted = JSON.parse(await call('get_spec', { id: cta.id, measure: false }));
check('typed notes are kept, with their kinds',
  noted.notes.length === 2 && noted.notes.some((n) => n.kind === 'behaviour')
  && noted.notes.some((n) => n.kind === 'data'),
  noted.notes.map((n) => n.kind).join(', '));

const parent = JSON.parse(await call('get_spec', { id: written.roots[0].id, measure: false }));
check('a note on a child appears in the parent spec, saying where it is',
  parent.notes.length === 2 && parent.notes.every((n) => n.on?.name === 'Book a review'),
  parent.notes.map((n) => n.on?.name).join(', '));

const artboardSpec = JSON.parse(await call('get_spec', { id: board.id, measure: false }));
check('and in the whole screen\'s spec', artboardSpec.notes.length === 2);

// --- In the panel ---------------------------------------------------------------

const browser = await chromium.launch({ headless: true });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/d/${doc.id}`, { waitUntil: 'networkidle' });
await page.waitForSelector('.artboard-frame iframe', { timeout: 30000 });
await page.click('.rail-left .rail-tabs button[aria-label="Spec"]');
await page.waitForTimeout(1200);
check('the panel asks for a selection before it has one',
  (await page.locator('.spec').count()) === 0 && (await page.locator('.panel-empty').count()) > 0);

await page.evaluate((id) => window.__playground.store.getState().select([id]), cta.id);
await page.waitForTimeout(900);
const groups = await page.$$eval('.spec-section header button', (els) =>
  els.map((e) => e.textContent?.replace(/\d+$/, '').trim() ?? ''));
check('selecting a layer fills it in', groups.includes('Layout') && groups.includes('Notes'),
  groups.join(', '));
// The header is the Properties panel's, which is the point: the spec should not
// look like a different application sitting in the same rail.
const header = await page.locator('.spec .prop-header').innerText();
check('the measured size is in the header', header.includes('×'), header.replace(/\n/g, ' · '));
// `background`, not `padding`: the edit above deliberately replaced the padding
// token with a literal, so asserting on it here would be asserting on the
// previous state.
const shownTokens = await page.$$eval('.spec-token', (els) => els.map((e) => e.textContent ?? ''));
check('tokens are shown by name, not as hexes',
  shownTokens.some((t) => t.includes('color.brand')), shownTokens.join(' | ').slice(0, 90));

// Adding a note from the panel must land in the document an agent reads.
await page.click('.spec button:has-text("Add a note")');
await page.waitForTimeout(300);
await page.selectOption('.spec-add select', 'constraint');
await page.fill('.spec-add textarea', 'Must clear 44px on touch.');
await page.click('.spec-add-actions .button.primary');
await page.waitForTimeout(800);
const fromPanel = JSON.parse(await call('get_spec', { id: cta.id, measure: false }));
check('a note added in the panel reaches the agent\'s spec',
  fromPanel.notes.some((n) => n.kind === 'constraint' && n.text.includes('44px')),
  fromPanel.notes.map((n) => n.kind).join(', '));

await page.screenshot({ path: '/tmp/spec-panel.png' });
await page.close();

// --- The person the spec is for --------------------------------------------------
//
// A developer has a view-only link and no account. If the spec is not readable
// there, it is not a handover feature.

const share = await (await fetch(`${BASE}/api/documents/${doc.id}/shares`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'handover' }),
})).json();

const viewer = await signedOutPage(browser, { viewport: { width: 1400, height: 900 } });
viewer.on('pageerror', (e) => errors.push(e.message));
await viewer.goto(share.url, { waitUntil: 'networkidle' });
await viewer.waitForSelector('.artboard-frame iframe', { timeout: 30000 });
const specTab = viewer.locator('.rail-left .rail-tabs button[aria-label="Spec"]');
check('a view-only visitor gets the spec panel', (await specTab.count()) === 1);
await specTab.click();
await viewer.evaluate((id) => window.__playground.store.getState().select([id]), cta.id);
await viewer.waitForTimeout(900);
check('and can read the spec and the notes',
  (await viewer.$$eval('.spec-section header button', (els) => els.map((e) => e.textContent ?? '')))
    .some((t) => t.includes('Notes'))
  && (await viewer.locator('.spec-notes li').count()) > 0);
check('but cannot add one', (await viewer.locator('.spec-add').count()) === 0);
await viewer.close();

check('no runtime errors', errors.length === 0, errors[0] ?? '');
await browser.close();
await client.close();
await fetch(`${BASE}/api/documents/${doc.id}`, { method: 'DELETE' });

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} of ${results.length} checks failed` : `\nall ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
