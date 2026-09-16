/**
 * Tool groups.
 *
 *   node scripts/toolsets-check.mjs [base]
 *
 * Seventy-seven tools is a lot of context to spend on a session that wanted to
 * change a colour. A client can ask for a smaller surface on the URL, and widen
 * it mid-session — what must not happen is a client that has never heard of any
 * of this losing a tool it used yesterday.
 */

import './lib/session.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

const BASE = process.argv[2] ?? 'http://localhost:4000';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
};

const doc = (await (await fetch(`${BASE}/api/documents`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Toolsets' }),
})).json()).document;
const code = (await (await fetch(`${BASE}/api/documents/${doc.id}/connections`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'toolsets' }),
})).text()).match(/\/mcp\/([A-Z0-9-]+)/)[1];

const connect = async (query = '') => {
  const client = new Client({ name: 'toolsets-check', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/${code}${query}`)));
  return {
    client,
    async names() { return (await client.listTools()).tools.map((t) => t.name); },
    async call(name, args = {}) {
      const r = await client.callTool({ name, arguments: args });
      const t = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      if (r.isError) throw new Error(t);
      try { return JSON.parse(t); } catch { return t; }
    },
  };
};

// --- The default has to stay the default -----------------------------------------

const plain = await connect();
const all = await plain.names();
check('a client that asks for nothing gets everything', all.length > 70, `${all.length} tools`);
check('including the ones a session yesterday depended on',
  ['componentise', 'publish_page', 'get_spec', 'register_code_component'].every((t) => all.includes(t)));

// --- Asking for less ---------------------------------------------------------------

const small = await connect('?tools=core');
const core = await small.names();
check('asking for core gets a fraction of them', core.length < all.length / 2, `${core.length} tools`);
check('and it is the useful fraction',
  ['get_basic_info', 'write_html', 'update_styles', 'get_screenshot', 'lint_design'].every((t) => core.includes(t)),
  core.slice(0, 6).join(', '));
check('the specialist groups are not in it',
  !core.includes('componentise') && !core.includes('publish_page') && !core.includes('register_code_component'));

const sets = await small.call('list_toolsets');
check('list_toolsets says what is off and what is in it',
  sets.sets.components.on === false && sets.sets.components.tools > 5,
  JSON.stringify(sets.active));

// --- Widening mid-session -----------------------------------------------------------

let changed = 0;
small.client.setNotificationHandler(ToolListChangedNotificationSchema, () => { changed++; });
await small.call('use_toolset', { name: 'components' });
const widened = await small.names();
check('use_toolset switches a group on', widened.includes('componentise'), `${widened.length} tools`);
check('and the client is told the list changed, once per tool that moved',
  changed > 0 && changed <= 15, `${changed} notification(s)`);
check('without touching the ones already there', widened.includes('write_html'));
check('and the others stay off', !widened.includes('publish_page'));

const both = await small.call('use_toolset', { name: 'handover' });
check('more than one group can be on at once',
  (await small.names()).includes('publish_page'), JSON.stringify(both.active));

try {
  await small.call('register_code_component', { name: 'x', importPath: 'y', source: 'z' });
  check('a tool in a group that is off says so rather than vanishing', false, 'it ran');
} catch (err) {
  // "disabled" rather than "no such tool": the difference matters to an agent,
  // which should call use_toolset rather than conclude the feature is missing.
  check('a tool in a group that is off says so rather than vanishing',
    /disabled/i.test(err.message), err.message.slice(0, 60));
}

const nonsense = await small.call('use_toolset', { name: 'nope' }).catch((e) => e.message);
check('an unknown group is refused by name', /No toolset/.test(String(nonsense)), String(nonsense).slice(0, 50));

await plain.client.close();
await small.client.close();
await fetch(`${BASE}/api/documents/${doc.id}`, { method: 'DELETE' });

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} of ${results.length} checks failed` : `\nall ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
