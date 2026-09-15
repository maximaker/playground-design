import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const open = async (url) => {
  const c = new Client({ name: 'diff', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(url)));
  return { c, call: async (n, a = {}) => {
    const r = await c.callTool({ name: n, arguments: a });
    return r.content.filter(x => x.type === 'text').map(x => x.text).join('\n');
  } };
};
const [liveUrl, localUrl] = process.argv.slice(2);
const out = {};
for (const [name, url] of [['live', liveUrl], ['pristine', localUrl]]) {
  const s = await open(url);
  const info = JSON.parse(await s.call('get_basic_info'));
  const b = info.artboards.find(a => a.name === 'Landing — 1440');
  out[name] = await s.call('get_html', { id: b.id });
  await s.c.close();
}
import { writeFileSync } from 'node:fs';
writeFileSync('/tmp/live.html', out.live);
writeFileSync('/tmp/pristine.html', out.pristine);
console.log('  live    :', out.live.length, 'chars');
console.log('  pristine:', out.pristine.length, 'chars');
