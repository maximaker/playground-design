/**
 * Re-measures every artboard and sets its height to what its content needs.
 *
 * Split out of build.mjs because it is worth running on its own: an artboard
 * left at a guessed height either clips its content or trails blank space, and
 * on the phone copy that is over a thousand pixels of page simply cut off.
 */
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [mcpUrl, base, docId] = process.argv.slice(2);
const client = new Client({ name: 'refit', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));
const call = async (n, a = {}) => {
  const r = await client.callTool({ name: n, arguments: a });
  const t = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r.isError) throw new Error(`${n}: ${t}`);
  return t;
};

const before = JSON.parse(await call('get_basic_info')).artboards;
console.log('  before:', before.map((a) => `${a.name} ${a.width}×${a.height}`).join(' | '));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto(`${base}/d/${docId}`, { waitUntil: 'networkidle' });
await page.waitForSelector('.artboard-frame iframe', { timeout: 30000 });
await page.keyboard.press('Shift+1');
await page.waitForTimeout(4000);
const heights = await page.evaluate(() => {
  const out = {};
  for (const f of document.querySelectorAll('.artboard-frame iframe')) {
    const el = f.contentDocument?.body?.firstElementChild?.firstElementChild;
    if (el) out[f.title] = Math.ceil(el.getBoundingClientRect().height);
  }
  return out;
});
await browser.close();
console.log('  measured:', JSON.stringify(heights));

const updates = before
  .filter((b) => heights[b.name] && heights[b.name] !== b.height)
  .map((b) => ({ id: b.id, styles: { height: `${heights[b.name]}px` } }));

if (!updates.length) { console.log('  nothing to change'); await client.close(); process.exit(0); }
await call('update_styles', { updates });

// Read it back from the server rather than trusting the call returned cleanly.
const after = JSON.parse(await call('get_basic_info')).artboards;
console.log('  after :', after.map((a) => `${a.name} ${a.width}×${a.height}`).join(' | '));
const wrong = after.filter((a) => heights[a.name] && a.height !== heights[a.name]);
console.log(wrong.length ? `  ${wrong.length} did not take` : '  all heights applied');
await client.close();
process.exit(wrong.length ? 1 : 0);
