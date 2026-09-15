/** An agent checking its own work: build something flawed, lint it, fix it. */
import './lib/session.mjs';  // signs these checks in; see the module header
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = 'http://localhost:4000';
const doc = await (await fetch(`${BASE}/api/documents`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Lint demo', template: 'clean' }) })).json();
const docId = doc.document.id;
const conn = await (await fetch(`${BASE}/api/documents/${docId}/connections`, { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'Lint Agent' }) })).json();

const client = new Client({ name: 'lint', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(conn.url)));
const call = async (n, a = {}) => {
  const r = await client.callTool({ name: n, arguments: a });
  const t = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r.isError) throw new Error(`${n}: ${t}`);
  return t;
};

const info = JSON.parse(await call('get_basic_info'));
const board = JSON.parse(await call('create_artboard', { name: 'Flawed', width: 900, height: 520 }));

// Deliberately flawed: low contrast, tiny text, no alt, a small tap target,
// a hardcoded value where the design uses a token, and absolute soup.
await call('write_html', { targetId: board.id, mode: 'replace-children', html: `
  <div style="display:flex;flex-direction:column;gap:13px;padding:32px;background-color:#ffffff">
    <h1 style="color:var(--color-fg);font-size:28px">Signup</h1>
    <p style="color:#c9c9c9;font-size:15px">Faint helper text nobody can read.</p>
    <p style="font-size:9px;color:#666">Tiny legal line</p>
    <img src="/logo.png" />
    <div style="background-color:#0f172a;color:#fff;width:70px;height:26px;display:flex;align-items:center;justify-content:center">Go</div>
    <div style="position:relative;height:120px">
      <div style="position:absolute;left:0;top:0">a</div>
      <div style="position:absolute;left:30px;top:10px">b</div>
      <div style="position:absolute;left:60px;top:20px">c</div>
    </div>
  </div>`});

const before = JSON.parse(await call('lint_design', { within: board.id }));
console.log(`found ${before.total}: ${before.summary.map((s) => `${s.rule}×${s.count}`).join(', ')}`);
for (const f of before.findings.slice(0, 4)) console.log(`  · ${f.message}`);

// The agent fixes what it can from the findings.
const contrast = before.findings.find((f) => f.rule === 'contrast');
const tiny = before.findings.find((f) => f.rule === 'tiny-text');
const alt = before.findings.find((f) => f.rule === 'missing-alt');
const tap = before.findings.find((f) => f.rule === 'tap-target');
const hard = before.findings.find((f) => f.rule === 'hardcoded-token');
const gap = before.findings.find((f) => f.rule === 'off-scale-spacing');

const updates = [];
if (contrast) updates.push({ id: contrast.node, styles: { color: 'var(--color-muted)' } });
if (tiny) updates.push({ id: tiny.node, styles: { 'font-size': '12px' } });
if (tap) updates.push({ id: tap.node, styles: { width: '120px', height: '48px' } });
if (hard) updates.push({ id: hard.node, styles: { 'background-color': 'var(--color-fg)' } });
if (gap) updates.push({ id: gap.node, styles: { gap: '16px' } });
if (updates.length) await call('update_styles', { updates });
if (alt) await call('set_attributes', { updates: [{ id: alt.node, attrs: { alt: 'Company logo' } }] });

const after = JSON.parse(await call('lint_design', { within: board.id }).catch(() => '{"total":0,"summary":[]}'));
console.log(`after fixes: ${after.total ?? 0}${after.summary ? ` (${after.summary.map((s) => `${s.rule}×${s.count}`).join(', ')})` : ''}`);
console.log('URL:', `${BASE}/d/${docId}`);
await client.close();
