/**
 * Lints a document with a browser attached, which is the only way the
 * tap-target rule can see anything.
 *
 * Without a live tab the rule falls back to authored sizes and stays quiet —
 * so a build that lints clean on its own says nothing about whether its
 * controls can actually be hit. This opens a tab first and then asks.
 */
import '../lib/session.mjs';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [base, docId] = process.argv.slice(2);

const raw = await (await fetch(`${base}/api/documents/${docId}/connections`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'verify' }),
})).text();
// The setup block in the response contains literal newlines, so the code is
// pulled out by pattern rather than parsed.
const code = raw.match(/\/mcp\/([A-Z0-9-]+)/)[1];

const client = new Client({ name: 'verify', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${code}`)));
const call = async (n, a = {}) =>
  (await client.callTool({ name: n, arguments: a })).content.map((c) => c.text).join('\n');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto(`${base}/d/${docId}`, { waitUntil: 'networkidle' });
await page.waitForSelector('.artboard-frame iframe', { timeout: 30000 });
await page.keyboard.press('Shift+1');
await page.waitForTimeout(4000);

const report = JSON.parse(await call('lint_design'));
console.log('  with a browser attached:', JSON.stringify(report.bySeverity));
for (const g of report.summary) console.log(`    ${g.rule.padEnd(20)} ${String(g.count).padStart(3)}  ${g.severity}`);

const bad = report.findings.filter((f) => f.severity === 'error' || f.severity === 'warning');
for (const f of bad.slice(0, 10)) console.log(`    ! ${f.name}: ${f.message}`);

await browser.close();
await client.close();
process.exit(bad.length ? 1 : 0);
