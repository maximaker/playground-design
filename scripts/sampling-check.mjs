/**
 * The server asking the client's model for help.
 *
 *   node scripts/sampling-check.mjs [base]
 *
 * The check stands in for the model itself: the client answers the sampling
 * request with a canned reply, which makes the round trip deterministic and
 * lets both paths be asserted — the one where a client offers sampling, and the
 * one where it does not and the tools have to degrade into reporting.
 */

import './lib/session.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CreateMessageRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const BASE = process.argv[2] ?? 'http://localhost:4000';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
};

const doc = (await (await fetch(`${BASE}/api/documents`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Sampling' }),
})).json()).document;
const code = (await (await fetch(`${BASE}/api/documents/${doc.id}/connections`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'sampling' }),
})).text()).match(/\/mcp\/([A-Z0-9-]+)/)[1];

const connect = async (opts = {}) => {
  const client = new Client({ name: 'sampling-check', version: '1' }, opts);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/${code}`)));
  return {
    client,
    async text(name, args = {}) {
      const r = await client.callTool({ name, arguments: args });
      const t = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      if (r.isError) throw new Error(`${name}: ${t}`);
      return t;
    },
    async call(name, args = {}) {
      const t = await this.text(name, args);
      // Not every tool answers in JSON — get_tree_summary draws a tree.
      try { return JSON.parse(t); } catch { return t; }
    },
  };
};

// Three identical cards and three identical stats, so there is something to name.
const plain = await connect();
const board = (await plain.call('get_basic_info')).artboards[0];
const card = (title, body) => `<article style="padding:24px;border:1px solid #ddd;border-radius:12px;display:flex;flex-direction:column;gap:8px">
  <h3 style="margin:0;font-size:18px">${title}</h3><p style="margin:0;color:#555">${body}</p></article>`;
const stat = (n, label) => `<div style="display:flex;flex-direction:column;gap:2px">
  <strong style="font-size:28px">${n}</strong><span style="color:#666">${label}</span></div>`;
await plain.call('write_html', {
  targetId: board.id, mode: 'replace-children',
  html: `<div style="padding:48px;display:flex;flex-direction:column;gap:32px;background:#fff">
    <div style="display:flex;gap:16px">${card('Fast', 'It is quick.')}${card('Safe', 'It is careful.')}${card('Clear', 'It explains itself.')}</div>
    <div style="display:flex;gap:40px">${stat('15+', 'years')}${stat('5', 'products')}${stat('99%', 'uptime')}</div>
  </div>`,
});

// --- A client with no sampling ------------------------------------------------

const without = await plain.call('auto_componentise', { minCopies: 3 });
check('without sampling nothing is invented', (without.made ?? []).length === 0);
check('and it reports the candidates instead of failing',
  (without.candidates ?? []).length >= 2 && /did not answer/.test(without.note ?? ''),
  `${(without.candidates ?? []).length} candidates`);

// --- A client that answers ------------------------------------------------------

let asked = 0;
const smart = await connect({ capabilities: { sampling: {} } });
smart.client.setRequestHandler(CreateMessageRequestSchema, (request) => {
  asked++;
  // Stand in for the model: name by what the shape contains, which is what a
  // model would do with the same description.
  const text = request.params.messages.map((m) => m.content.text).join('\n');
  const shapes = JSON.parse(text.slice(text.indexOf('[')));
  const named = shapes.map((s) => ({
    id: s.id,
    name: /years|products|uptime|15\+|99%/.test(JSON.stringify(s)) ? 'Stat' : 'Feature card',
  }));
  return {
    model: 'check-stub',
    role: 'assistant',
    content: { type: 'text', text: JSON.stringify(named) },
  };
});

const made = await smart.call('auto_componentise', { minCopies: 3 });
check('with sampling the server asks the model', asked > 0, `${asked} request(s)`);
check('and registers what it was told they are called',
  (made.made ?? []).some((m) => m.name === 'Feature card') || (made.made ?? []).some((m) => m.name === 'Stat'),
  JSON.stringify(made.made));

const components = await smart.call('list_components');
check('the components are in the document under those names',
  components.components.length >= 1
  && components.components.every((c) => /Feature card|Stat/.test(c.name)),
  components.components.map((c) => `${c.name} ×${c.instances}`).join(', '));
check('and every copy became an instance',
  components.components.reduce((n, c) => n + c.instances, 0) >= 3,
  components.components.map((c) => c.instances).join('+'));

// --- Naming layers ----------------------------------------------------------------

const before = await smart.text('get_tree_summary', { id: board.id, depth: 3 });
check('an imported page starts full of layers called after their tag',
  /Div/.test(before));

smart.client.setRequestHandler(CreateMessageRequestSchema, (request) => {
  const text = request.params.messages.map((m) => m.content.text).join('\n');
  const layers = JSON.parse(text.slice(text.indexOf('[')));
  return {
    model: 'check-stub',
    role: 'assistant',
    content: { type: 'text', text: JSON.stringify(layers.map((l) => ({ id: l.id, name: 'Feature row' }))) },
  };
});
const renamed = await smart.call('name_layers', { id: board.id });
check('name_layers renames them', renamed.renamed > 0, `${renamed.renamed} renamed`);
const after = await smart.text('get_tree_summary', { id: board.id, depth: 3 });
check('and the tree reads as something', /Feature row/.test(after));

// A layer that already has a name is left alone.
const again = await smart.call('name_layers', { id: board.id });
check('layers that already have names are left alone',
  again.renamed === 0 || /already/.test(again.note ?? ''), JSON.stringify(again).slice(0, 80));

await smart.client.close();
await plain.client.close();
await fetch(`${BASE}/api/documents/${doc.id}`, { method: 'DELETE' });

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} of ${results.length} checks failed` : `\nall ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
