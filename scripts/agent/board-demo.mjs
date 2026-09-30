/**
 * A demo of the board on a live instance: a user flow and a pipeline, owned
 * by the person it is for.
 *
 *   node scripts/agent/board-demo.mjs [base] [ownerEmail]
 */
import '../lib/session.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = process.argv[2] ?? 'https://playground.thedigitalvitamins.com';
const OWNER = process.argv[3] ?? 'imaxim@gmail.com';
const doc = (await (await fetch(`${BASE}/api/documents`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Diagrams — board demo' }),
})).json()).document;
const code = (await (await fetch(`${BASE}/api/documents/${doc.id}/connections`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'board demo' }),
})).text()).match(/\/mcp\/([A-Z0-9-]+)/)[1];
const client = new Client({ name: 'demo', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/${code}`)));
const { tools } = await client.listTools();
if (!tools.some((t) => t.name === 'write_diagram')) { console.log('NOT DEPLOYED YET'); process.exit(2); }
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const t = r.content.map((c) => c.text).join('');
  if (r.isError) throw new Error(t);
  return JSON.parse(t);
};

const first = await call('write_diagram', { mermaid: `flowchart TD
  start([Invite accepted]) --> A[Create account]
  A --> B{Email verified?}
  B -- yes --> C[Pick a workspace]
  B -- no --> D[Resend link]
  D -.-> B
  C --> E{Has a team?}
  E -- yes --> F[Join team]
  E -- no --> G[Create team]
  F --> H((Dashboard))
  G --> H
  subgraph Onboarding
    A
    B
    D
  end`, colors: { start: 'slate', H: 'green', D: 'red' } });

await call('write_diagram', { route: 'curved', mermaid: `flowchart LR
  T([Schedule trigger]) --> R[HTTP API request] --> K{order_total > 100}
  K -- yes --> P[Premium follow-up]
  K -- no --> S[Standard follow-up]
  P --> X((Done))
  S --> X`, colors: { T: 'slate', X: 'green' }, x: first.bounds.x, y: first.bounds.y + first.bounds.height + 160 });

await client.close();
await fetch(`${BASE}/api/documents/${doc.id}/invites`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: OWNER, role: 'owner' }),
});
console.log(`${BASE}/d/${doc.id}`);
