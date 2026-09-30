/**
 * Draw a diagram over MCP and save what the agent sees.
 *
 *   node scripts/agent/board-picture.mjs <out.png> [base]
 */
import '../lib/session.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { writeFileSync } from 'node:fs';

const OUT = process.argv[2] ?? '/tmp/board.png';
const BASE = process.argv[3] ?? 'http://localhost:4000';
const doc = (await (await fetch(`${BASE}/api/documents`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Board picture' }),
})).json()).document;
const code = (await (await fetch(`${BASE}/api/documents/${doc.id}/connections`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'picture' }),
})).text()).match(/\/mcp\/([A-Z0-9-]+)/)[1];
const client = new Client({ name: 'picture', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/${code}`)));
const r = await client.callTool({ name: 'write_diagram', arguments: { mermaid: `flowchart TD
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
  end`, colors: { H: 'green', D: 'red', start: 'slate' } } });
console.log(r.content[0].text.slice(0, 300));
const pic = await client.callTool({ name: 'get_board', arguments: { image: true } });
const img = pic.content.find((c) => c.type === 'image');
writeFileSync(OUT, Buffer.from(img.data, 'base64'));
console.log(OUT, `${BASE}/d/${doc.id}`);
await client.close();
