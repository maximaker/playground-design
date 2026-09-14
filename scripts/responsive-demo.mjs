/** An agent authoring a responsive layout against the document's breakpoints. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { writeFileSync } from 'node:fs';

const BASE = 'http://localhost:4000';
const doc = await (await fetch(`${BASE}/api/documents`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Responsive', template: 'clean' }) })).json();
const docId = doc.document.id;
const conn = await (await fetch(`${BASE}/api/documents/${docId}/connections`, { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'Responsive Agent' }) })).json();
const client = new Client({ name: 'r', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(conn.url)));
const call = async (n, a = {}) => {
  const r = await client.callTool({ name: n, arguments: a });
  const t = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r.isError) throw new Error(`${n}: ${t}`);
  return { text: t, content: r.content };
};

const bps = JSON.parse((await call('get_breakpoints')).text);
console.log('breakpoints:', bps.breakpoints.map((b) => `${b.name}@${b.maxWidth}`).join(' '));

const board = JSON.parse((await call('create_artboard', { name: 'Hero', width: 1280, height: 520 })).text);
const built = JSON.parse((await call('write_html', {
  targetId: board.id, mode: 'replace-children', html: `
  <div style="display:flex;flex-direction:row;gap:32px;padding:64px;align-items:center;background-color:var(--color-bg)">
    <div style="display:flex;flex-direction:column;gap:16px;flex:1">
      <h1 style="font-size:52px;line-height:1.1;margin:0;color:var(--color-fg)">Design and ship from one file</h1>
      <p style="font-size:18px;line-height:1.6;margin:0;color:var(--color-muted)">Real HTML and CSS, all the way through.</p>
    </div>
    <div style="width:360px;height:260px;border-radius:var(--radius-lg);background-color:var(--color-brand)"></div>
  </div>`,
})).text);

const rootId = built.roots[0].id;
const children = JSON.parse((await call('get_children', { id: rootId })).text);
const [copy, art] = children;
const heading = JSON.parse((await call('get_children', { id: copy.id })).text)[0];

// Overrides at the document's own breakpoints, not invented widths.
const md = bps.breakpoints.find((b) => b.name === 'md');
const sm = bps.breakpoints.find((b) => b.name === 'sm');
await call('update_styles', { updates: [
  { id: rootId, styles: { 'flex-direction': 'column', padding: '32px', gap: '32px' }, selector: md.selector },
  { id: art.id, styles: { width: '100%', height: '180px' }, selector: md.selector },
  { id: heading.id, styles: { 'font-size': '34px' }, selector: md.selector },
  { id: heading.id, styles: { 'font-size': '28px' }, selector: sm.selector },
  { id: rootId, styles: { padding: '24px' }, selector: sm.selector },
]});

const shots = await call('preview_at_width', { id: board.id });
const images = shots.content.filter((c) => c.type === 'image');
console.log(shots.content.find((c) => c.type === 'text').text);
images.forEach((img, i) => writeFileSync(`/tmp/bp-${i}.png`, Buffer.from(img.data, 'base64')));
console.log(`saved ${images.length} screenshots`);
console.log('URL:', `${BASE}/d/${docId}`, 'ARTBOARD:', board.id);
await client.close();
