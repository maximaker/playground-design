/**
 * Turn the repeated shapes of a document into named components.
 *
 *   node scripts/agent/name-components.mjs <docId> --list
 *   node scripts/agent/name-components.mjs <docId> <sampleId>=<Name> ...
 *
 * `find_repeated_shapes` can say what repeats; it cannot say what the thing is
 * called. Naming is the part a person (or an agent that has read the page) has
 * to do, so this is two passes: look, then name. Componentising is done one at
 * a time because each one changes the document — a shape that was repeated nine
 * times is, once registered, repeated nowhere.
 */

import '../lib/session.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = process.env.BASE ?? 'http://localhost:4000';
const docId = process.argv[2];
const args = process.argv.slice(3);
if (!docId) { console.error('usage: name-components.mjs <docId> [--list | id=Name ...]'); process.exit(1); }

const raw = await (await fetch(`${BASE}/api/documents/${docId}/connections`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'componentise' }),
})).text();
const client = new Client({ name: 'name-components', version: '1' });
await client.connect(new StreamableHTTPClientTransport(
  new URL(`${BASE}/mcp/${raw.match(/\/mcp\/([A-Z0-9-]+)/)[1]}`)));
const call = async (name, a = {}) => {
  const r = await client.callTool({ name, arguments: a });
  const text = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r.isError) throw new Error(`${name}: ${text}`);
  return text;
};

if (args[0] === '--list' || args.length === 0) {
  const { groups } = JSON.parse(await call('find_repeated_shapes', {
    minCopies: 2, minDepth: Number(process.env.DEPTH ?? 2), limit: 30,
  }));
  for (const g of groups) {
    const children = JSON.parse(await call('get_children', { id: g.sample })).map((c) => c.type + ':' + c.name);
    console.log(`${g.sample}  ×${g.copies}  ${g.name}  [${children.join(', ')}]`);
    console.log(`   ${(g.text ?? '').replace(/\s+/g, ' ').slice(0, 96)}`);
  }
} else {
  for (const pair of args) {
    const [id, ...rest] = pair.split('=');
    const name = rest.join('=');
    try {
      const result = JSON.parse(await call('componentise', { id, name }));
      console.log(`✓ ${name}: ${result.replaced ?? result.instances ?? '?'} instances`);
    } catch (e) {
      console.log(`✗ ${name}: ${e.message.split('\n')[0]}`);
    }
  }
  const { components } = JSON.parse(await call('list_components'));
  console.log('\n' + components.map((c) => `${c.name} ×${c.instances}`).join(', '));
}

await client.close();
