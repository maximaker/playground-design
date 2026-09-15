/**
 * The tools an agent needs that were missing: pages, and componentising.
 *
 *   node scripts/agent-pack-check.mjs [base]
 *
 * The page half is mostly about one bug. Every page-shaped tool fell back to
 * `pages[0]`, so an agent that made a second page kept being shown the first —
 * no error, just the wrong document. The checks here are the ones that would
 * have caught it: make a page, put something on it, and read it back.
 */

import './lib/session.mjs';
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
  body: JSON.stringify({ name: 'Agent pack' }),
})).json()).document;

const raw = await (await fetch(`${BASE}/api/documents/${doc.id}/connections`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'agent pack' }),
})).text();
const client = new Client({ name: 'agent-pack', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/${raw.match(/\/mcp\/([A-Z0-9-]+)/)[1]}`)));
const call = async (n, a = {}) => {
  const r = await client.callTool({ name: n, arguments: a });
  const t = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r.isError) throw new Error(`${n}: ${t}`);
  return t;
};
const tools = (await client.listTools()).tools.map((t) => t.name);

// --- Pages ------------------------------------------------------------------

for (const name of ['list_pages', 'create_page', 'set_current_page', 'rename_page', 'delete_page']) {
  check(`${name} exists`, tools.includes(name));
}

const first = JSON.parse(await call('list_pages'));
check('the document starts on one page', first.pages.length === 1 && first.pages[0].current);

const deck = JSON.parse(await call('create_page', { name: 'Deck' }));
check('creating a page switches to it', deck.current === true);

const board = JSON.parse(await call('create_artboard', { name: 'Slide 1', width: 1920, height: 1080 }));
await call('write_html', {
  targetId: board.id, mode: 'replace-children',
  html: '<h1 style="padding:60px;font-size:80px">On the deck page</h1>',
});

const listed = JSON.parse(await call('list_pages'));
const deckPage = listed.pages.find((p) => p.name === 'Deck');
check('the new artboard lands on the new page',
  deckPage?.artboards === 1 && listed.pages[0].artboards === 1,
  listed.pages.map((p) => `${p.name}:${p.artboards}`).join(' '));
check('and the session is still on it', listed.currentPage === deckPage?.id);

// The bug in one line: with no id, the tree must describe the current page.
const tree = await call('get_tree_summary', { depth: 2 });
check('get_tree_summary reads the current page, not the first',
  tree.includes('Slide 1') && !tree.includes('Desktop'), tree.split('\n')[0]);

const info = JSON.parse(await call('get_basic_info'));
check('so does get_basic_info', info.artboards.length === 1 && info.artboards[0].name === 'Slide 1',
  info.artboards.map((a) => a.name).join(', '));

await call('set_current_page', { pageId: listed.pages[0].id });
check('switching back switches what is read',
  (await call('get_tree_summary', { depth: 1 })).includes('Desktop'));

await call('rename_page', { pageId: deckPage.id, name: 'Capabilities deck' });
check('a page can be renamed',
  JSON.parse(await call('list_pages')).pages.some((p) => p.name === 'Capabilities deck'));

let refused = '';
try { await call('delete_page', { pageId: deckPage.id, confirm: false }); }
catch (e) { refused = e.message; }
check('deleting a page with artboards needs confirming', refused.includes('confirm'), refused.slice(0, 80));

const deleted = JSON.parse(await call('delete_page', { pageId: deckPage.id, confirm: true }));
check('and takes its artboards with it', deleted.artboardsRemoved === 1, JSON.stringify(deleted));

let lastPage = '';
try { await call('delete_page', { pageId: listed.pages[0].id, confirm: true }); }
catch (e) { lastPage = e.message; }
check('the last page cannot be deleted', lastPage.includes('only page'), lastPage.slice(0, 60));

// --- Componentising -----------------------------------------------------------

const artboard = JSON.parse(await call('get_basic_info')).artboards[0];
const card = (title, body, href) =>
  `<div style="display:flex;flex-direction:column;gap:12px;padding:28px;border:1px solid #ececec;border-radius:20px;background:#fff">
     <strong style="font-size:18px">${title}</strong>
     <p style="margin:0;color:#666">${body}</p>
     <a href="${href}" style="color:#4f46e5;text-decoration:none">Read more</a>
   </div>`;
await call('write_html', {
  targetId: artboard.id, mode: 'replace-children',
  html: `<div style="display:flex;flex-direction:row;gap:20px;padding:40px;background:#fafafa">
    ${card('Audit', 'Two weeks of looking.', '#audit')}
    ${card('Build', 'Six weeks of shipping.', '#build')}
    ${card('Operate', 'Ninety days on call.', '#operate')}
  </div>`,
});

const before = await call('get_html', { id: artboard.id });
const found = JSON.parse(await call('find_repeated_shapes', { minCopies: 3, minDepth: 2 }));
check('find_repeated_shapes spots the three identical cards',
  found.groups[0]?.copies === 3, JSON.stringify(found.groups[0] ?? {}).slice(0, 90));
check('and shows text so the group is recognisable', !!found.groups[0]?.text, found.groups[0]?.text);

const dry = JSON.parse(await call('componentise', {
  id: found.groups[0].sample, name: 'Service card', dryRun: true,
}));
check('a dry run reports without changing anything',
  dry.wouldReplace === 2 && (await call('list_components')).includes('no components'),
  `${dry.wouldReplace} copies`);

const made = JSON.parse(await call('componentise', { id: found.groups[0].sample, name: 'Service card' }));
check('componentising replaces every copy', made.instances === 3, JSON.stringify(made).slice(0, 80));

const after = await call('get_html', { id: artboard.id });
const strip = (html) => html.replace(/ class="c-[^"]*"/g, '');
check('and the artboard renders identically', strip(before) === strip(after),
  `${before.length} → ${after.length} chars`);
check('each instance keeps its own text',
  ['Audit', 'Build', 'Operate'].every((t) => after.includes(`>${t}<`)));
check('and its own link', ['#audit', '#build', '#operate'].every((h) => after.includes(h)));

const again = JSON.parse(await call('find_repeated_shapes', { minCopies: 3, minDepth: 2 }));
check('the repeat stops being reported once it is a component',
  !again.groups.some((g) => g.copies === 3 && !g.alreadyComponent), `${again.total} group(s) left`);

await client.close();
await fetch(`${BASE}/api/documents/${doc.id}`, { method: 'DELETE' });

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} of ${results.length} checks failed` : `\nall ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
