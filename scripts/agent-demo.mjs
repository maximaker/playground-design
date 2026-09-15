import './lib/session.mjs';  // signs these checks in; see the module header
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = 'http://localhost:4000';
const docId = process.argv[2];

const conn = await (await fetch(`${BASE}/api/documents/${docId}/connections`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'Demo Agent' }),
})).json();

const client = new Client({ name: 'demo', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(conn.url)));

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  if (r.isError) throw new Error(`${name}: ${text}`);
  return text;
};

const info = JSON.parse(await call('get_basic_info'));
const artboard = info.artboards[0].id;
console.log('artboard:', artboard, `${info.artboards[0].width}x${info.artboards[0].height}`);

await call('start_working_on_nodes', { ids: [artboard], summary: 'Building a pricing page' });

await call('set_tokens', { tokens: [
  { name: 'color.brand', group: 'color', values: { default: '#6366f1', dark: '#818cf8' } },
  { name: 'color.ink', group: 'color', values: { default: '#0f172a', dark: '#f1f5f9' } },
  { name: 'color.muted', group: 'color', values: { default: '#64748b', dark: '#94a3b8' } },
  { name: 'color.surface', group: 'color', values: { default: '#ffffff', dark: '#0f172a' } },
  { name: 'radius.card', group: 'radius', values: { default: '16px' } },
]});

const result = JSON.parse(await call('write_html', {
  targetId: artboard,
  mode: 'replace-children',
  html: `
<style>
  .page { display:flex; flex-direction:column; align-items:center; gap:56px; padding:80px 64px;
          background:var(--color-surface); font-family:Inter, system-ui, sans-serif; width:100%; }
  .head { display:flex; flex-direction:column; align-items:center; gap:16px; max-width:640px; }
  .eyebrow { font-size:13px; font-weight:600; letter-spacing:.12em; text-transform:uppercase; color:var(--color-brand); }
  .title { font-size:56px; font-weight:700; line-height:1.1; color:var(--color-ink); text-align:center; margin:0; }
  .sub { font-size:18px; line-height:1.6; color:var(--color-muted); text-align:center; margin:0; }
  .tiers { display:flex; flex-direction:row; gap:24px; align-items:stretch; }
  .card { display:flex; flex-direction:column; gap:20px; padding:32px; width:300px;
          background:var(--color-surface); border:1px solid #e2e8f0; border-radius:var(--radius-card); }
  .card.featured { border-color:var(--color-brand); box-shadow:0 12px 32px rgba(99,102,241,.18); }
  .tier { font-size:15px; font-weight:600; color:var(--color-ink); }
  .price { font-size:44px; font-weight:700; color:var(--color-ink); }
  .per { font-size:14px; color:var(--color-muted); }
  .feature { font-size:14px; line-height:1.7; color:var(--color-muted); }
  .cta { display:flex; align-items:center; justify-content:center; padding:12px 20px; border-radius:10px;
         background:var(--color-brand); color:#fff; font-size:14px; font-weight:600; transition:transform 150ms ease; }
  .cta:hover { transform:translateY(-1px); }
  .cta.ghost { background:transparent; color:var(--color-ink); border:1px solid #e2e8f0; }
  @media (max-width: 768px) {
    .tiers { flex-direction:column; }
    .title { font-size:36px; }
    .page { padding:48px 24px; }
  }
</style>
<main class="page">
  <div class="head">
    <span class="eyebrow">Pricing</span>
    <h1 class="title">Design and ship from one file</h1>
    <p class="sub">Every plan includes the full canvas, agent access, and unlimited export.</p>
  </div>
  <section class="tiers">
    <div class="card">
      <span class="tier">Starter</span>
      <span class="price">$0</span>
      <span class="per">forever</span>
      <span class="feature">3 documents</span>
      <span class="feature">1 agent connection</span>
      <span class="feature">PNG and HTML export</span>
      <div class="cta ghost">Start free</div>
    </div>
    <div class="card featured">
      <span class="tier">Pro</span>
      <span class="price">$16</span>
      <span class="per">per editor / month</span>
      <span class="feature">Unlimited documents</span>
      <span class="feature">Unlimited agent connections</span>
      <span class="feature">Version history and restore</span>
      <div class="cta">Get Pro</div>
    </div>
    <div class="card">
      <span class="tier">Team</span>
      <span class="price">$32</span>
      <span class="per">per editor / month</span>
      <span class="feature">Shared token libraries</span>
      <span class="feature">Multiplayer editing</span>
      <span class="feature">Priority support</span>
      <div class="cta ghost">Talk to us</div>
    </div>
  </section>
</main>`,
}));
console.log('created', result.totalNodes, 'nodes, warnings:', result.warnings);

// Build the mobile artboard the way the guide describes.
const mobile = JSON.parse(await call('create_artboard', { name: 'Mobile', width: 390, height: 1100 }));
const dup = JSON.parse(await call('duplicate_nodes', {
  ids: [result.roots[0].id], parentId: mobile.id,
}));
console.log('mobile artboard', mobile.id, 'with', Object.keys(dup.duplicated[0].idMap).length, 'cloned nodes');

await call('finish_working_on_nodes', { summary: 'Pricing page + mobile variant' });

const summary = await call('get_tree_summary', { id: artboard, depth: 3 });
console.log('\n--- tree ---\n' + summary);

const jsx = await call('get_jsx', { id: artboard, format: 'tailwind' });
console.log('\n--- jsx (first 700 chars) ---\n' + jsx.slice(0, 700));

const styles = JSON.parse(await call('get_computed_styles', { ids: [result.roots[0].id], properties: ['display','gap','padding'] }));
console.log('\n--- computed ---\n' + JSON.stringify(styles, null, 2).slice(0, 600));

await client.close();
