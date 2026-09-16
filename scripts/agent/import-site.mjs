/**
 * Build a Playground document from a live website.
 *
 *   node scripts/agent/import-site.mjs <url> "<document name>" [base]
 *
 * The site is read in a real browser at 1440px, after scrolling it end to end
 * so that anything revealed on scroll has actually revealed — extract before
 * that and half the page is `opacity: 0`, which is a state and not a design.
 *
 * What comes back is not the site's markup. It is a simplified tree with the
 * *computed* styles inlined, which is the only honest way to import a page
 * built with utility classes: the classes are not the design, the values they
 * resolve to are. Colours and radii are then matched back against the site's
 * own custom properties, so the document arrives with real tokens rather than
 * ninety hex codes.
 *
 * The extraction runs inside the browser and goes straight into the document,
 * so no page of HTML passes through anything but this script.
 */

import '../lib/session.mjs';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const SITE = process.argv[2];
const NAME = process.argv[3] ?? 'Imported site';
const BASE = process.argv[4] ?? 'http://localhost:4000';
if (!SITE) { console.error('usage: import-site.mjs <url> "<name>" [base]'); process.exit(1); }

// The same reading the server's import_url does, from the same file: a
// fidelity fix is worth nothing if only one of them has it.
import { extractPage as extractor, readPageVars as readVars } from '@playground/shared';

const api = async (path, init) => {
  const res = await fetch(`${BASE}/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

// --- What is on the site -------------------------------------------------------

await page.goto(SITE, { waitUntil: 'networkidle' });
const vars = await page.evaluate(readVars);
const routes = await page.evaluate(() => [...new Set([...document.querySelectorAll('a[href^="/"]')]
  .map((a) => a.getAttribute('href').split('#')[0])
  .filter((h) => h && !h.startsWith('//')))]);
const pages = ['/', ...routes.filter((r) => r !== '/')];
console.log(`${pages.length} pages: ${pages.join(' ')}`);

/** rgb(...) as the site writes it, so extracted values can be matched. */
const toRgb = (hex) => {
  const m = /^#?([\da-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};

const colours = Object.entries(vars).filter(([, v]) => /^#[\da-f]{6}$/i.test(v.trim()));
const radii = Object.entries(vars).filter(([, v]) => /^\d+px$/.test(v.trim()));
const fonts = Object.entries(vars).filter(([, v]) => /["']/.test(v));

// --- The document --------------------------------------------------------------

const { document: doc } = await api('/documents', {
  method: 'POST', body: JSON.stringify({ name: NAME }),
});
const raw = await (await fetch(`${BASE}/api/documents/${doc.id}/connections`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'site import' }),
})).text();
const client = new Client({ name: 'import-site', version: '1' });
await client.connect(new StreamableHTTPClientTransport(
  new URL(`${BASE}/mcp/${raw.match(/\/mcp\/([A-Z0-9-]+)/)[1]}`)));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r.isError) throw new Error(`${name}: ${text}`);
  return text;
};

await call('set_tokens', {
  tokens: [
    ...colours.map(([name, value]) => ({ name: `color.${name}`, group: 'color', values: { default: value } })),
    ...radii.map(([name, value]) => ({ name: `radius.${name.replace(/^r-/, '')}`, group: 'radius', values: { default: value } })),
    ...fonts.map(([name, value]) => ({ name: `font.${name}`, group: 'font', values: { default: value } })),
  ],
});
console.log(`tokens: ${colours.length} colours, ${radii.length} radii, ${fonts.length} fonts`);

/** Swap the values back for the names the site gave them. */
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

const first = JSON.parse(await call('list_pages')).pages[0];
// A new document arrives with an empty artboard. Left in place it is the first
// frame of the first page — so every thumbnail, publication and presentation
// of this document would open on a blank sheet.
const starter = JSON.parse(await call('get_basic_info')).artboards.map((a) => a.id);
let built = 0;

for (const route of pages) {
  const label = route === '/' ? 'Acasă' : route.replace(/^\//, '');
  const title = label.charAt(0).toUpperCase() + label.slice(1);

  await page.goto(new URL(route, SITE).toString(), { waitUntil: 'networkidle' });
  // Reveal-on-scroll is an animation state: walk the page before reading it.
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 600) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 40));
    }
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 600));
  });
  const shot = await page.evaluate(extractor);

  const pageId = built === 0
    ? (await call('rename_page', { pageId: first.id, name: title }), first.id)
    : JSON.parse(await call('create_page', { name: title })).pageId;

  const board = JSON.parse(await call('create_artboard', {
    name: `${title} — 1440`,
    width: 1440,
    height: Math.min(20000, shot.height),
    x: 0,
    y: 0,
    pageId,
  }));

  // One section per call: a page is 40KB of HTML, and a failure in the middle
  // of a single giant write tells you nothing about where it happened.
  const wrapper = `<div style="${shot.wrapper};background-color:var(--color-cream);font-family:var(--font-sans);color:var(--color-ink)"></div>`;
  const written = JSON.parse(await call('write_html', {
    targetId: board.id, mode: 'replace-children', html: wrapper,
  }));
  const root = written.roots[0].id;

  for (const section of shot.sections) {
    await call('write_html', { targetId: root, mode: 'insert-children', html: tokenise(section) });
  }
  console.log(`${title}: ${shot.sections.length} sections, ${shot.height}px`);
  built++;
}

if (starter.length) await call('delete_nodes', { ids: starter });

console.log(`\ndocument ${doc.id} — ${BASE}/d/${doc.id}`);
const repeated = JSON.parse(await call('find_repeated_shapes', { minCopies: 2, minDepth: 2, limit: 20 }));
console.log(JSON.stringify(repeated.groups.map((g) => ({
  sample: g.sample, copies: g.copies, name: g.name, text: (g.text ?? '').slice(0, 60),
})), null, 1));

await client.close();
await browser.close();
