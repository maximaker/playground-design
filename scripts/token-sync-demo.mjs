/** An agent reconciling a design's tokens with the codebase it belongs to. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = 'http://localhost:4000';
const doc = await (await fetch(`${BASE}/api/documents`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Token sync', template: 'clean' }) })).json();
const docId = doc.document.id;
const conn = await (await fetch(`${BASE}/api/documents/${docId}/connections`, { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'Token Agent' }) })).json();
const client = new Client({ name: 't', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(conn.url)));
const call = async (n, a = {}) => {
  const r = await client.callTool({ name: n, arguments: a });
  const t = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r.isError) throw new Error(`${n}: ${t}`);
  return t;
};

// What the repo's stylesheet says — the brand has moved on and there is a new token.
const repoCss = `
:root {
  --color-brand: #6366f1;
  --color-bg: #ffffff;
  --color-fg: #0f172a;
  --color-danger: #dc2626;
  --space-md: 16px;
}
:root[data-theme="dark"] { --color-brand: #a5b4fc; --color-bg: #0b0b0f; }
`;

console.log('--- drift:');
console.log(await call('check_token_drift', { css: repoCss }));

console.log('\n--- dry run:');
const dry = JSON.parse(await call('sync_tokens_from_code', { css: repoCss, dryRun: true }));
console.log(`would add ${dry.wouldAdd.length}, change ${dry.wouldChange.length}, keep ${dry.onlyInDesign.length} design-only`);

console.log('\n--- applying:');
console.log(await call('sync_tokens_from_code', { css: repoCss }));

console.log('\n--- back out as Tailwind:');
console.log((await call('export_tokens', { format: 'tailwind' })).split('\n').slice(0, 10).join('\n'));

console.log('\n--- re-check:');
console.log(await call('check_token_drift', { css: repoCss }));
console.log('URL:', `${BASE}/d/${docId}`);
await client.close();
