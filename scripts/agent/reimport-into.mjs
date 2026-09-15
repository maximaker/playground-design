/**
 * Re-import a site into a document that already exists.
 *
 *   node scripts/agent/reimport-into.mjs <url> <docId> [base]
 *
 * For when the fidelity fixes are in the extractor rather than in the data: the
 * document keeps its id, its link and its history, and its pages are rebuilt
 * from the site as it is now. A named version is saved first, so the state
 * before the rebuild is a click away rather than a promise.
 *
 * Components are rebuilt too, because replacing a page's contents leaves every
 * instance behind as an ordinary layer. The names are not rediscovered — they
 * are matched to the shapes by a line of their text, so the library that comes
 * out is the same library, not a fresh set of "Component 1..14".
 */

import '../lib/session.mjs';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { extractor, readVars } from './extract.mjs';

const SITE = process.argv[2];
const DOC = process.argv[3];
const BASE = process.argv[4] ?? 'https://playground.thedigitalvitamins.com';
if (!SITE || !DOC) { console.error('usage: reimport-into.mjs <url> <docId> [base]'); process.exit(1); }

/** Which shape is called what, keyed by a line of its own text. */
const NAMES = [
  ['Am fost și de partea', 'Reason card'],
  ['ani de practică', 'Stat'],
  ['15+', 'Stat'],
  ['Trebuie ca diagnosticul', 'FAQ item'],
  ['Putem participa doar noi', 'FAQ item'],
  ['O oră care limpezește', 'Step card'],
  ['Sesiunea 1', 'Session card'],
  ['Workshop 01', 'Workshop card'],
  ['Numele tău', 'Form field'],
  ['30 de minute despre cum', 'Bullet list'],
  ['Cum vă pot ajuta', 'Section intro'],
  ['Întrebări', 'Section header'],
  ['imagine provizorie', 'Portrait photo'],
  ['provizorie', 'Photo placeholder'],
  ['Boala nu se întâmplă', 'Quote band'],
  ['Bine în botoșei de spital', 'Closing CTA'],
];

const api = async (path, init) => {
  const res = await fetch(`${BASE}/api${path}`, {
    ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? null : res.json();
};

const { document: before } = await api(`/documents/${DOC}`);
console.log(`${before.name}: ${before.pages.length} pages, ${Object.keys(before.nodes).length} nodes`);

await api(`/documents/${DOC}/snapshots`, {
  method: 'POST', body: JSON.stringify({ label: `Before re-import ${new Date().toISOString().slice(0, 16)}` }),
});
console.log('saved a version to come back to');

const raw = await (await fetch(`${BASE}/api/documents/${DOC}/connections`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'site re-import' }),
})).text();
const client = new Client({ name: 'reimport', version: '1' });
await client.connect(new StreamableHTTPClientTransport(
  new URL(`${BASE}/mcp/${raw.match(/\/mcp\/([A-Z0-9-]+)/)[1]}`)));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r.isError) throw new Error(`${name}: ${text}`);
  return text;
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(SITE, { waitUntil: 'networkidle' });
const vars = await page.evaluate(readVars);

const toRgb = (hex) => {
  const m = /^#?([\da-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};
const colours = Object.entries(vars).filter(([, v]) => /^#[\da-f]{6}$/i.test(v.trim()));
const radii = Object.entries(vars).filter(([, v]) => /^\d+px$/.test(v.trim()));
const tokenise = (html) => {
  let out = html;
  for (const [name, value] of colours) {
    const rgb = toRgb(value);
    if (rgb) out = out.split(rgb).join(`var(--color-${name})`);
    out = out.split(value.toLowerCase()).join(`var(--color-${name})`);
  }
  for (const [name, value] of radii) {
    out = out.replace(new RegExp(`border-radius:${value}(?=[;"])`, 'g'), `border-radius:var(--radius-${name.replace(/^r-/, '')})`);
  }
  return out;
};

// --- The pages ------------------------------------------------------------------

for (const docPage of before.pages) {
  const board = docPage.artboards[0];
  if (!board) { console.log(`${docPage.name}: no artboard, skipped`); continue; }
  const route = docPage.name === 'Acasă' ? '/' : `/${docPage.name.toLowerCase()}`;

  await page.goto(new URL(route, SITE).toString(), { waitUntil: 'networkidle' });
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 600) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 40));
    }
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 600));
  });
  const shot = await page.evaluate(extractor);

  const wrapper = `<div style="${shot.wrapper};background-color:var(--color-cream);font-family:var(--font-sans);color:var(--color-ink)"></div>`;
  const written = JSON.parse(await call('write_html', {
    targetId: board, mode: 'replace-children', html: wrapper,
  }));
  const root = written.roots[0].id;
  for (const section of shot.sections) {
    await call('write_html', { targetId: root, mode: 'insert-children', html: tokenise(section) });
  }
  await call('update_styles', { updates: [{ id: board, styles: { height: `${Math.min(20000, shot.height)}px` } }] });
  console.log(`${docPage.name}: ${shot.sections.length} sections, ${shot.height}px`);
}

// --- The library ----------------------------------------------------------------

// Replacing a page's contents leaves its instances behind as ordinary layers,
// so the old definitions are unused. Removed through the op layer, which is
// what the editor's own delete button sends — MCP has no tool for it.
const { components } = JSON.parse(await call('list_components'));
if (components.length) {
  const doc = (await api(`/documents/${DOC}`)).document;
  const ops = [];
  for (const c of components) {
    ops.push({ op: { t: 'component', action: 'remove', component: { id: c.id } }, origin: { kind: 'agent', id: 'reimport', label: 'site re-import' } });
    const root = doc.components?.[c.id]?.root;
    if (root) ops.push({ op: { t: 'remove', ids: [root] }, origin: { kind: 'agent', id: 'reimport', label: 'site re-import' } });
  }
  await api(`/documents/${DOC}/ops`, { method: 'POST', body: JSON.stringify({ ops }) });
  console.log(`removed ${components.length} stale component(s)`);
}

/*
 * Looked up again for each one, not once at the start.
 *
 * Registering a component rewrites every copy of it, so the ids in a list taken
 * beforehand go stale — and a shape that was the third-largest group becomes
 * the largest once the ones above it are gone. Asking again each time costs a
 * round trip and gets the right answer.
 */
const made = new Set();
for (const [needle, name] of NAMES) {
  if (made.has(name)) continue;
  const { groups } = JSON.parse(await call('find_repeated_shapes', { minCopies: 2, minDepth: 2, limit: 40 }));
  // The biggest matching group, so "FAQ item" is the seven of them and not a
  // pair that happens to share the first line.
  const group = groups
    .filter((g) => (g.text ?? '').includes(needle) && !g.alreadyComponent)
    .sort((a, b) => b.copies - a.copies)[0];
  if (!group) continue;
  try {
    await call('componentise', { id: group.sample, name });
    made.add(name);
  } catch (e) {
    console.log(`  ${name}: ${e.message.split('\n')[0].slice(0, 90)}`);
  }
}
const after = JSON.parse(await call('list_components')).components;
console.log(`components: ${after.map((c) => `${c.name} ×${c.instances}`).join(', ')}`);
console.log(`\n${BASE}/d/${DOC}`);

await client.close();
await browser.close();
