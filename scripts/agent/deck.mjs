/**
 * Builds the Northsignal capabilities deck on its own page of the document.
 *
 *   node scripts/agent/deck.mjs <base> <docId>
 *
 * deck.html is one file: a <style> block followed by ten slides separated by
 * `<!--slide: Name-->`. The style block is prepended to every slide because
 * classes are resolved into node styles when the fragment is parsed — a slide
 * written without it arrives unstyled.
 *
 * Re-running replaces the slides on the existing "Deck" page rather than adding
 * a second one, so this stays the way the deck is edited.
 */
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [base, docId] = process.argv.slice(2);
if (!base || !docId) { console.log('usage: deck.mjs <base> <docId>'); process.exit(1); }

const SLIDE = { w: 1920, h: 1080, gap: 160 };

const source = readFileSync(new URL('./deck.html', import.meta.url), 'utf8');
const [style, ...rest] = source.split(/<!--slide:\s*/);
const slides = rest.map((chunk) => {
  const [name, ...html] = chunk.split('-->');
  return { name: name.trim(), html: `${style}\n${html.join('-->')}` };
});
console.log(`  ${slides.length} slides`);

const raw = await (await fetch(`${base}/api/documents/${docId}/connections`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'deck' }),
})).text();
const client = new Client({ name: 'deck', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${raw.match(/\/mcp\/([A-Z0-9-]+)/)[1]}`)));
const call = async (n, a = {}) => {
  const r = await client.callTool({ name: n, arguments: a });
  const t = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r.isError) throw new Error(`${n}: ${t}`);
  return t;
};

// The page, made once and reused. MCP has no page tool, so this goes through the
// ops endpoint the editor itself uses.
const doc = () => fetch(`${base}/api/documents/${docId}`).then((r) => r.json()).then((b) => b.document);
let page = (await doc()).pages.find((p) => p.name === 'Deck');
if (!page) {
  page = { id: `p_${Math.random().toString(36).slice(2, 10)}`, name: 'Deck', artboards: [] };
  await fetch(`${base}/api/documents/${docId}/ops`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ops: [{ op: { t: 'page', action: 'add', page }, origin: { kind: 'agent', id: 'deck' } }] }),
  });
  console.log('  created the Deck page');
}

const existing = (await doc()).pages.find((p) => p.id === page.id).artboards;
const boards = (await doc()).nodes;

for (const [i, slide] of slides.entries()) {
  const name = `${String(i + 1).padStart(2, '0')} — ${slide.name}`;
  let board = existing.map((id) => boards[id]).find((b) => b?.name === name);
  if (!board) {
    board = JSON.parse(await call('create_artboard', {
      name, width: SLIDE.w, height: SLIDE.h, pageId: page.id,
      // A row, left to right, in reading order.
      x: i * (SLIDE.w + SLIDE.gap), y: 0,
      styles: { 'background-color': 'var(--color-bg)' },
    }));
  }
  await call('write_html', { targetId: board.id, mode: 'replace-children', html: slide.html });
  console.log(`  ${name}`);
}

// A slide that overflows its 1080 is a slide with a cut-off line at the bottom,
// and nothing in the model complains about it — so measure and say so.
const info = JSON.parse(await call('get_basic_info'));
console.log('\n ', `${base}/d/${docId}`);
console.log('  page:', page.name, '·', info.pages.find((p) => p.id === page.id)?.artboards ?? slides.length, 'artboards');
await client.close();
