/**
 * Importing a live page.
 *
 *   node scripts/import-url-check.mjs [base]
 *
 * Needs the network: the point of the tool is a page it did not write, and the
 * SSRF guard refuses anything that resolves to this machine, so there is no
 * local fixture to point it at. example.com is the stable public page; the
 * multi-page and token claims are checked against a real site and skipped
 * rather than failed if it is unreachable.
 */

import './lib/session.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

const BASE = process.argv[2] ?? 'http://localhost:4000';
const SITE = 'https://bine-in-botosei-de-spital.vercel.app';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
};

const doc = (await (await fetch(`${BASE}/api/documents`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Import check' }),
})).json()).document;
const raw = await (await fetch(`${BASE}/api/documents/${doc.id}/connections`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'import' }),
})).text();
const client = new Client({ name: 'import-check', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/${raw.match(/\/mcp\/([A-Z0-9-]+)/)[1]}`)));
const logs = [];
client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => logs.push(n.params.data));
const call = async (n, a = {}, opts) => {
  const r = await client.callTool({ name: n, arguments: a }, undefined, opts);
  const t = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r.isError) throw new Error(`${n}: ${t}`);
  return t;
};
const state = async () => (await (await fetch(`${BASE}/api/documents/${doc.id}`)).json()).document;

// --- One page -------------------------------------------------------------------

const one = JSON.parse(await call('import_url', { url: 'https://example.com', width: 1200 }));
check('a page comes in as layers', one.imported?.[0]?.sections > 0, JSON.stringify(one.imported?.[0] ?? one));

const after = await state();
const board = after.nodes[one.imported[0].artboard];
check('the artboard is the width it was read at', board?.styles.width === '1200px', board?.styles.width);
check('and as tall as the page really is',
  parseInt(board?.styles.height ?? '0', 10) > 100, board?.styles.height);
check('the text is there, not a screenshot of it',
  JSON.stringify(after.nodes).includes('Example Domain'));

// --- A site ----------------------------------------------------------------------

let reachable = true;
try {
  const head = await fetch(SITE, { method: 'HEAD' });
  reachable = head.ok;
} catch { reachable = false; }

if (!reachable) {
  console.log('  — the reference site is unreachable; skipping the multi-page checks');
} else {
  /*
   * Forty seconds of silence is what this used to be. The caller sends a
   * progress token and gets told which route is being read.
   */
  const progress = [];
  const many = JSON.parse(await call('import_url', {
    url: SITE, width: 1440, routes: ['/', '/contact'],
  }, { onprogress: (p) => progress.push(p) }));
  check('a long import reports its progress', progress.length >= 3, `${progress.length} updates`);
  check('and says what it is doing, not just how far along it is',
    progress.some((p) => /contact/.test(p.message ?? '')),
    (progress.map((p) => p.message).filter(Boolean).slice(-1)[0] ?? '').slice(0, 60));
  check('with a total that does not move', new Set(progress.map((p) => p.total)).size === 1,
    [...new Set(progress.map((p) => p.total))].join(','));
  check('several routes come in as several pages', many.imported?.length === 2,
    (many.imported ?? []).map((p) => `${p.route}→${p.page}`).join(' '));

  const built = await state();
  check('each on a page named after its route',
    built.pages.some((p) => p.name === 'Home') && built.pages.some((p) => p.name === 'Contact'),
    built.pages.map((p) => p.name).join(', '));

  /*
   * The reason to import into this tool rather than screenshot the page: the
   * site's own variables arrive as tokens, and the styles reference them.
   */
  check('the site\'s CSS variables become tokens', many.tokens >= 10, `${many.tokens} tokens`);
  const styles = JSON.stringify(Object.values(built.nodes).map((n) => n.styles));
  check('and the layers reference them by name', /var\(--color-/.test(styles));

  // A utility-class page has no styles of its own to fetch; only a browser can
  // say what those classes resolved to.
  check('computed styles came through, not class names',
    /background-color/.test(styles) && !/tailwind|class=/.test(styles));

  const contact = built.pages.find((p) => p.name === 'Contact');
  const contactBoard = built.nodes[contact.artboards[0]];
  check('the second route is its own artboard, sized to itself',
    !!contactBoard && parseInt(contactBoard.styles.height, 10) > 1000, contactBoard?.styles.height);
}

await fetch(`${BASE}/api/documents/${doc.id}`, { method: 'DELETE' });
await client.close();

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} of ${results.length} checks failed` : `\nall ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
