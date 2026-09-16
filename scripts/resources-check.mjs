/**
 * The document as resources.
 *
 *   node scripts/resources-check.mjs [base]
 *
 * Tools are verbs and this server had only verbs. A page, a component, a spec
 * and a guide are nouns — things to point at. The part worth checking hardest
 * is the subscription: a Playground document is edited by two parties at once,
 * and a client watching a page should be told when the other one moves
 * something rather than finding out by writing over it.
 */

import './lib/session.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

const BASE = process.argv[2] ?? 'http://localhost:4000';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
};

const doc = (await (await fetch(`${BASE}/api/documents`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Resources' }),
})).json()).document;
const code = (await (await fetch(`${BASE}/api/documents/${doc.id}/connections`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'resources' }),
})).text()).match(/\/mcp\/([A-Z0-9-]+)/)[1];

const client = new Client({ name: 'resources-check', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/${code}`)));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const t = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r.isError) throw new Error(t);
  try { return JSON.parse(t); } catch { return t; }
};

const board = (await call('get_basic_info')).artboards[0];
await call('write_html', {
  targetId: board.id, mode: 'replace-children',
  html: `<div style="padding:40px;background:#fff"><h1 style="margin:0">A page of things</h1>
    <p style="color:#555">With a paragraph under it.</p></div>`,
});

// --- Reading -----------------------------------------------------------------------

const listed = await client.listResources();
check('the document is a resource', listed.resources.some((r) => r.uri === 'playground://document'),
  listed.resources.map((r) => r.uri).join(' '));
check('and so is every page', listed.resources.some((r) => r.uri.startsWith('playground://page/')));
check('and every guide', listed.resources.some((r) => r.uri.startsWith('playground://guide/')));

const templates = await client.listResourceTemplates();
check('a spec can be asked for by node id',
  templates.resourceTemplates.some((t) => t.uriTemplate.includes('spec/{nodeId}')),
  templates.resourceTemplates.map((t) => t.uriTemplate).join(' '));

const summary = JSON.parse((await client.readResource({ uri: 'playground://document' })).contents[0].text);
check('reading the document gives what get_basic_info gives',
  !!summary.documentName && Array.isArray(summary.artboards) && Array.isArray(summary.pages),
  `${summary.documentName}, ${summary.artboards?.length} artboard(s)`);

const pageUri = listed.resources.find((r) => r.uri.startsWith('playground://page/')).uri;
const html = (await client.readResource({ uri: pageUri })).contents[0];
check('a page reads as the HTML it really is',
  html.mimeType === 'text/html' && /A page of things/.test(html.text), html.mimeType);

const guide = (await client.readResource({ uri: 'playground://guide/layout' })).contents[0];
check('a guide reads as prose', guide.mimeType === 'text/markdown' && guide.text.length > 200);

const spec = JSON.parse((await client.readResource({ uri: `playground://spec/${board.id}` })).contents[0].text);
check('a spec reads for any node', spec.id === board.id && Array.isArray(spec.groups));

let refused = null;
try { await client.readResource({ uri: 'playground://page/Nope' }); } catch (e) { refused = e.message; }
check('a resource that does not exist says which one', /No page/.test(refused ?? ''), (refused ?? '').slice(0, 40));

// --- Watching ----------------------------------------------------------------------

const updates = [];
client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => updates.push(n.params.uri));
await client.subscribeResource({ uri: pageUri });

// Someone else edits the document — the REST path a human's browser uses.
await fetch(`${BASE}/api/documents/${doc.id}/ops`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    ops: [{
      op: { t: 'rename', updates: [{ id: board.id, name: 'Renamed by someone else' }] },
      origin: { kind: 'human', id: 'other', label: 'Someone else' },
    }],
  }),
});
await new Promise((r) => setTimeout(r, 1200));
check('a subscriber is told when the other party edits', updates.includes(pageUri),
  updates.join(', ') || 'nothing arrived');

await client.unsubscribeResource({ uri: pageUri });
updates.length = 0;
await fetch(`${BASE}/api/documents/${doc.id}/ops`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    ops: [{
      op: { t: 'rename', updates: [{ id: board.id, name: 'Renamed again' }] },
      origin: { kind: 'human', id: 'other' },
    }],
  }),
});
await new Promise((r) => setTimeout(r, 900));
check('and stops being told once it unsubscribes', updates.length === 0, updates.join(', '));

await client.close();
await fetch(`${BASE}/api/documents/${doc.id}`, { method: 'DELETE' });

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} of ${results.length} checks failed` : `\nall ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
