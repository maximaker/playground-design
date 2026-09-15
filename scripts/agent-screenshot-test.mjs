import './lib/session.mjs';  // signs these checks in; see the module header
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { writeFileSync } from 'node:fs';

const BASE = 'http://localhost:4000';
const docId = process.argv[2];
const conn = await (await fetch(`${BASE}/api/documents/${docId}/connections`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'Screenshot Agent' }),
})).json();

const client = new Client({ name: 'shot', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(conn.url)));

const info = JSON.parse((await client.callTool({ name: 'get_basic_info', arguments: {} }))
  .content.map(c => c.text).join(''));
console.log('liveTabConnected:', info.liveTabConnected);

const res = await client.callTool({ name: 'get_screenshot', arguments: { id: info.artboards[0].id, scale: 1 } });
const img = res.content.find(c => c.type === 'image');
if (img) {
  writeFileSync('/tmp/agent-shot.png', Buffer.from(img.data, 'base64'));
  console.log('screenshot ok:', img.mimeType, Buffer.from(img.data, 'base64').length, 'bytes -> /tmp/agent-shot.png');
} else {
  console.log('screenshot failed:', res.content.map(c => c.text).join(''));
}

const sel = await client.callTool({ name: 'set_selection', arguments: { ids: [info.artboards[1].id] } });
console.log('set_selection:', sel.content.map(c => c.text).join(''));

await client.close();
