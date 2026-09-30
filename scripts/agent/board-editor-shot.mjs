/**
 * The sample diagram, open in the editor, photographed.
 *
 *   node scripts/agent/board-editor-shot.mjs <out.png> [base]
 */
import '../lib/session.mjs';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const OUT = process.argv[2] ?? '/tmp/board-editor.png';
const BASE = process.argv[3] ?? 'http://localhost:4000';
const doc = (await (await fetch(`${BASE}/api/documents`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Board in the editor' }),
})).json()).document;
const code = (await (await fetch(`${BASE}/api/documents/${doc.id}/connections`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'shot' }),
})).text()).match(/\/mcp\/([A-Z0-9-]+)/)[1];
const client = new Client({ name: 'shot', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/${code}`)));
const { document: d } = await (await fetch(`${BASE}/api/documents/${doc.id}`)).json();
const screen = d.nodes[d.pages[0].artboards[0]].name;
await client.callTool({ name: 'write_diagram', arguments: { direction: 'LR',
  nodes: [
    { id: 'land', label: 'Landing', artboard: screen },
    { id: 'signup', label: 'Sign up' }, { id: 'verify', label: 'Email verified?', kind: 'diamond' },
    { id: 'resend', label: 'Resend link', color: 'yellow' }, { id: 'dash', label: 'Dashboard', kind: 'ellipse', color: 'green' },
  ],
  edges: [
    { from: 'land', to: 'signup', label: 'Get started' }, { from: 'signup', to: 'verify' },
    { from: 'verify', to: 'dash', label: 'yes' }, { from: 'verify', to: 'resend', label: 'no' },
    { from: 'resend', to: 'verify', dashed: true },
  ],
  groups: [{ label: 'Onboarding', members: ['signup', 'verify', 'resend'] }],
} });
await client.close();

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(`${BASE}/d/${doc.id}`, { waitUntil: 'networkidle' });
await page.waitForSelector('.artboard-frame iframe', { timeout: 20000 });
await page.waitForTimeout(800);
await page.keyboard.press('1');
await page.waitForTimeout(700);
// Select one connector so the chrome is in the picture too.
await page.evaluate(() => {
  const s = window.__playground.store.getState();
  const c = (s.doc.pages[0].board ?? []).find((i) => i.type === 'connector' && i.label === 'yes');
  if (c) s.selectBoard([c.id]);
});
await page.waitForTimeout(300);
await page.screenshot({ path: OUT });
await browser.close();
console.log(OUT, `${BASE}/d/${doc.id}`);
