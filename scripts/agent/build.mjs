/**
 * Builds the whole Northsignal document from scratch, against whatever server
 * PLAYGROUND_BASE points at.
 *
 * The point of having this is that the design is not trapped in one database.
 * It was authored against localhost; moving it to the deployment should be the
 * same script with a different base URL, not a hand-copied set of steps that
 * quietly diverges from what was actually built.
 *
 *   PLAYGROUND_BASE=https://example.com node scripts/agent/build.mjs
 */
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { session, connect } from './connect.mjs';

const BASE = process.env.PLAYGROUND_BASE ?? 'http://localhost:4000';
const s = await session({ name: 'Northsignal — AI web consulting', template: '', fresh: true });
const { call, close } = await connect(s.url);
const log = (...a) => console.log(' ', ...a);

// --- Tokens ---------------------------------------------------------------

await call('set_tokens', { tokens: [
  { name: 'color.bg',             group: 'color', values: { default: '#EBEBEB', dark: '#131313' } },
  { name: 'color.surface',        group: 'color', values: { default: '#FFFFFF', dark: '#1C1C1C' } },
  { name: 'color.surface-sunken', group: 'color', values: { default: '#F7F7F7', dark: '#232323' } },
  { name: 'color.surface-ink',    group: 'color', values: { default: '#1C1C1C', dark: '#F5F5F5' } },
  { name: 'color.surface-ink-2',  group: 'color', values: { default: '#2B2B2B', dark: '#E4E4E4' } },
  { name: 'color.border',         group: 'color', values: { default: '#ECECEC', dark: '#2C2C2C' } },
  { name: 'color.border-strong',  group: 'color', values: { default: '#DCDCDC', dark: '#3A3A3A' } },
  { name: 'color.border-ink',     group: 'color', values: { default: '#3A3A3A', dark: '#D0D0D0' } },
  { name: 'color.fg',             group: 'color', values: { default: '#171717', dark: '#F5F5F5' } },
  // Both greys are darker than the reference's: its greyed headline sits near
  // 1.7:1, which is fine in a mock-up and not fine in a heading people read.
  { name: 'color.fg-muted',       group: 'color', values: { default: '#666666', dark: '#A0A0A0' } },
  { name: 'color.fg-faint',       group: 'color', values: { default: '#858585', dark: '#6E6E6E' } },
  { name: 'color.on-ink',         group: 'color', values: { default: '#FFFFFF', dark: '#171717' } },
  { name: 'color.on-ink-muted',   group: 'color', values: { default: '#A6A6A6', dark: '#5A5A5A' } },
  { name: 'color.success',        group: 'color', values: { default: '#3D7A38', dark: '#7FBF78' } },
  { name: 'color.success-bg',     group: 'color', values: { default: '#E8F3E2', dark: '#22301F' } },
  { name: 'color.attention',      group: 'color', values: { default: '#E09B33', dark: '#F0B45C' } },
  { name: 'space.1',  group: 'space', values: { default: '4px' } },
  { name: 'space.2',  group: 'space', values: { default: '8px' } },
  { name: 'space.3',  group: 'space', values: { default: '12px' } },
  { name: 'space.4',  group: 'space', values: { default: '16px' } },
  { name: 'space.5',  group: 'space', values: { default: '24px' } },
  { name: 'space.6',  group: 'space', values: { default: '32px' } },
  { name: 'space.7',  group: 'space', values: { default: '48px' } },
  { name: 'space.8',  group: 'space', values: { default: '64px' } },
  { name: 'space.9',  group: 'space', values: { default: '96px' } },
  { name: 'space.10', group: 'space', values: { default: '128px' } },
  { name: 'radius.sm',   group: 'radius', values: { default: '10px' } },
  { name: 'radius.md',   group: 'radius', values: { default: '16px' } },
  { name: 'radius.lg',   group: 'radius', values: { default: '24px' } },
  { name: 'radius.xl',   group: 'radius', values: { default: '32px' } },
  { name: 'radius.pill', group: 'radius', values: { default: '999px' } },
  { name: 'shadow.chip',  group: 'shadow', values: { default: '0 1px 2px rgba(23,23,23,0.08)' } },
  { name: 'shadow.card',  group: 'shadow', values: { default: '0 1px 3px rgba(23,23,23,0.04)' } },
  { name: 'shadow.panel', group: 'shadow', values: { default: '0 24px 60px -20px rgba(23,23,23,0.18)' } },
  { name: 'font.sans', group: 'font', values: { default: "'Inter', system-ui, -apple-system, sans-serif" } },
  { name: 'font.mono', group: 'font', values: { default: "'IBM Plex Mono', ui-monospace, monospace" } },
]});
await call('set_breakpoints', { breakpoints: [
  { name: 'mobile', maxWidth: 640 },
  { name: 'tablet', maxWidth: 900 },
  { name: 'laptop', maxWidth: 1200 },
]});
log('tokens and breakpoints set');

// --- Foundations ----------------------------------------------------------

const info = JSON.parse(await call('get_basic_info'));
const foundations = info.artboards[0];
await call('rename_nodes', { updates: [{ id: foundations.id, name: 'Foundations' }] });
await call('update_styles', { updates: [{ id: foundations.id, styles: {
  width: '1240px', height: '2400px', 'background-color': 'var(--color-bg)', display: 'block', padding: '0',
} }] });
await call('write_html', {
  targetId: foundations.id, mode: 'replace-children',
  html: readFileSync(new URL('./foundations.html', import.meta.url), 'utf8'),
});
log('foundations written');

// --- Landing --------------------------------------------------------------

const page = readFileSync(new URL('./page.html', import.meta.url), 'utf8');
const desktop = JSON.parse(await call('create_artboard', {
  name: 'Landing — 1440', width: 1440, height: 3600, x: 1400, y: 0,
  styles: { 'background-color': 'var(--color-bg)', display: 'block', padding: '0' },
}));
await call('write_html', { targetId: desktop.id, mode: 'replace-children', html: page });
const pageRoot = JSON.parse(await call('get_children', { id: desktop.id }))[0];
log('landing written');

// The copies carry the same nodes and therefore the same media variants; each
// artboard is its own document, so they lay themselves out at their own width.
for (const [name, width, x] of [['Landing — 900 tablet', 900, 2960], ['Landing — 390 phone', 390, 3980]]) {
  const board = JSON.parse(await call('create_artboard', {
    name, width, height: 4600, x, y: 0,
    styles: { 'background-color': 'var(--color-bg)', display: 'block', padding: '0' },
  }));
  await call('duplicate_nodes', { ids: [pageRoot.id], parentId: board.id });
  log('copied to', name);
}

// --- Trim every artboard to the height its own content needs --------------

const browser = await chromium.launch({ headless: true });
const tab = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await tab.goto(`${BASE}/d/${s.docId}`, { waitUntil: 'networkidle' });
await tab.waitForSelector('.artboard-frame iframe', { timeout: 30000 });
await tab.keyboard.press('Shift+1');
await tab.waitForTimeout(4000);
const heights = await tab.evaluate(() => {
  const out = {};
  for (const f of document.querySelectorAll('.artboard-frame iframe')) {
    // Classes are resolved into node styles at parse time and are not kept in
    // the DOM, so the page is found by position: artboard root → its child.
    const el = f.contentDocument?.body?.firstElementChild?.firstElementChild;
    if (el) out[f.title] = Math.ceil(el.getBoundingClientRect().height);
  }
  return out;
});
await browser.close();

const boards = JSON.parse(await call('get_basic_info')).artboards;
const fit = boards.filter((b) => heights[b.name])
  .map((b) => ({ id: b.id, styles: { height: `${heights[b.name]}px` } }));
if (fit.length) await call('update_styles', { updates: fit });

/*
 * Read the heights back rather than trusting the call returned cleanly.
 *
 * This step silently failed to land on one deployment and the script reported
 * success anyway, because it logged the heights it had *measured* rather than
 * the ones the document ended up with. The phone artboard was left more than a
 * thousand pixels short and quietly clipped the bottom of the page — and
 * because clipped nodes cannot be measured, the linter could not see the
 * problem either and also reported clean.
 */
const applied = JSON.parse(await call('get_basic_info')).artboards;
const unfitted = applied.filter((b) => heights[b.name] && b.height !== heights[b.name]);
if (unfitted.length) {
  console.log('\n  Artboard heights did not take:');
  for (const b of unfitted) console.log(`    ${b.name}: ${b.height}, expected ${heights[b.name]}`);
  process.exit(1);
}
log('artboards fitted:', applied.map((b) => `${b.name} ${b.width}×${b.height}`).join(' | '));

// --- Check the result rather than assume it -------------------------------

const lint = JSON.parse(await call('lint_design'));
log('lint:', JSON.stringify(lint.bySeverity));
console.log(`\n  ${BASE}/d/${s.docId}`);
if (lint.bySeverity.error) {
  console.log('\n  Errors remain — not clean.');
  process.exit(1);
}
await close();
