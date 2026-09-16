/**
 * Asking the person before doing something irreversible.
 *
 *   node scripts/elicitation-check.mjs [base]
 *
 * `confirm: true` was a model confirming its own destructive act. Where the
 * client can ask a human, the human's answer is the one that counts — including
 * when it contradicts the agent. Where it cannot, nothing may change, because a
 * tool that becomes unusable on half the clients is worse than one that is
 * occasionally too trusting.
 */

import './lib/session.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const BASE = process.argv[2] ?? 'http://localhost:4000';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
};

const doc = (await (await fetch(`${BASE}/api/documents`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Elicitation' }),
})).json()).document;
const code = (await (await fetch(`${BASE}/api/documents/${doc.id}/connections`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'elicit' }),
})).text()).match(/\/mcp\/([A-Z0-9-]+)/)[1];

const connect = async (opts = {}) => {
  const client = new Client({ name: 'elicitation-check', version: '1' }, opts);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/${code}`)));
  return {
    client,
    async call(name, args = {}) {
      const r = await client.callTool({ name, arguments: args });
      const t = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      if (r.isError) throw new Error(t);
      try { return JSON.parse(t); } catch { return t; }
    },
  };
};

const plain = await connect();
const pageOf = async (name) => (await plain.call('create_page', { name, switchTo: false })).pageId;

// --- A client that cannot ask ------------------------------------------------------

const doomed = await pageOf('Doomed');
let refusal = null;
try { await plain.call('delete_page', { pageId: doomed, confirm: false }); } catch (e) { refusal = e.message; }
check('without elicitation the old confirmation still governs', /confirm: true/.test(refusal ?? ''),
  (refusal ?? '').slice(0, 50));
await plain.call('delete_page', { pageId: doomed, confirm: true });
check('and confirming still works', !(await plain.call('list_pages')).pages.some((p) => p.name === 'Doomed'));

// --- A client that asks, and is told no --------------------------------------------

const asked = [];
const saysNo = await connect({ capabilities: { elicitation: {} } });
saysNo.client.setRequestHandler(ElicitRequestSchema, (request) => {
  asked.push(request.params.message);
  return { action: 'decline' };
});

const spared = await pageOf('Spared');
let declined = null;
try { await saysNo.call('delete_page', { pageId: spared, confirm: true }); } catch (e) { declined = e.message; }
check('the person is asked, in words about this document',
  /Spared/.test(asked[0] ?? ''), (asked[0] ?? '').slice(0, 60));
check('and "no" beats the agent\'s own confirm: true', /declined/.test(declined ?? ''),
  (declined ?? '').slice(0, 50));
check('the page is still there',
  (await plain.call('list_pages')).pages.some((p) => p.name === 'Spared'));

// --- A client that asks, and is told yes --------------------------------------------

const saysYes = await connect({ capabilities: { elicitation: {} } });
saysYes.client.setRequestHandler(ElicitRequestSchema, () => ({ action: 'accept', content: {} }));
await saysYes.call('delete_page', { pageId: spared, confirm: false });
check('"yes" is the confirmation, so the agent needs no flag',
  !(await plain.call('list_pages')).pages.some((p) => p.name === 'Spared'));

// --- Deleting a lot of layers --------------------------------------------------------

const board = (await plain.call('get_basic_info')).artboards[0];
await plain.call('write_html', {
  targetId: board.id, mode: 'replace-children',
  html: `<div style="padding:40px">${Array.from({ length: 12 },
    (_, i) => `<p style="margin:0"><strong>Row ${i}</strong> <span>with two spans</span> <em>and an em</em></p>`).join('')}</div>`,
});
const wrapper = (await plain.call('get_children', { id: board.id }))[0];

const asked2 = [];
let stopped = null;
saysNo.client.setRequestHandler(ElicitRequestSchema, (request) => {
  asked2.push(request.params.message);
  return { action: 'decline' };
});
try { await saysNo.call('delete_nodes', { ids: [wrapper.id] }); } catch (e) { stopped = e.message; }
check('deleting a large subtree asks as well', asked2.length === 1, `${asked2.length} question(s)`);
check('and says how much is going', /\d+ layers in all/.test(asked2[0] ?? ''), (asked2[0] ?? '').slice(0, 60));
check('declining leaves them alone', /declined/.test(stopped ?? '')
  && (await plain.call('get_children', { id: board.id })).length === 1);

// A small deletion is not worth interrupting anyone for.
const small = (await plain.call('get_children', { id: wrapper.id }))[0];
asked2.length = 0;
await saysYes.call('delete_nodes', { ids: [small.id] });
check('a small deletion asks nobody anything', asked2.length === 0);

await plain.client.close();
await saysNo.client.close();
await saysYes.client.close();
await fetch(`${BASE}/api/documents/${doc.id}`, { method: 'DELETE' });

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} of ${results.length} checks failed` : `\nall ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
