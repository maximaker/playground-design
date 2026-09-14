/**
 * Headless agent session: create a document and build in it with no browser
 * tab open anywhere, then hand back a URL. This is the capability the hosted
 * MCP gateway buys that a localhost-only design tool cannot offer.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = 'http://localhost:4000';

const created = await (await fetch(`${BASE}/api/documents`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Built headlessly' }),
})).json();

const conn = await (await fetch(`${BASE}/api/documents/${created.document.id}/connections`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'Headless Agent' }),
})).json();

const client = new Client({ name: 'headless', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(conn.url)));

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  if (r.isError) throw new Error(`${name}: ${text}`);
  return { text, content: r.content };
};

const info = JSON.parse((await call('get_basic_info')).text);
console.log('liveTabConnected:', info.liveTabConnected, '(should be false)');

const artboard = info.artboards[0].id;
await call('write_html', {
  targetId: artboard, mode: 'replace-children',
  html: `<div style="display:flex;flex-direction:column;gap:24px;padding:64px;height:100%;
                     background:linear-gradient(135deg,#0f172a,#1e1b4b);font-family:Inter,sans-serif;
                     align-items:flex-start;justify-content:center">
           <span style="font-size:13px;letter-spacing:.2em;text-transform:uppercase;color:#a5b4fc">No browser required</span>
           <h1 style="font-size:64px;font-weight:700;color:#fff;margin:0;line-height:1.05;max-width:900px">
             This artboard was built by an agent with nobody watching
           </h1>
           <p style="font-size:20px;color:#c7d2fe;margin:0;max-width:640px;line-height:1.6">
             The MCP gateway works against the stored document, so an agent can create, populate and
             render a design, then hand a human the URL.
           </p>
         </div>`,
});

// Prove the agent can see its own work with no tab anywhere.
const shot = await call('get_screenshot', { id: artboard });
const img = shot.content.find(c => c.type === 'image');
console.log('headless screenshot:', img ? `${Buffer.from(img.data, 'base64').length} bytes` : 'FAILED');

const exported = JSON.parse((await call('export', { ids: [artboard], format: 'png', scale: 2 })).text);
console.log('export url:', exported.exported[0].url, `(${exported.exported[0].bytes} bytes)`);

console.log('\nHand this to a human:', `${BASE}/d/${created.document.id}`);
await client.close();
