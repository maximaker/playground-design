/**
 * Builds the Aires design system and dashboard in a new Playground document.
 *
 *   node scripts/agent/build-aires.mjs [base]
 *
 * Two pages: the style guide first, then the dashboard — in that order because
 * the dashboard is assembled out of what the style guide defines. The tokens
 * are real tokens, and every metric card on the dashboard is an instance of the
 * one specimen on the guide, overridden for its number, its words and its tint.
 *
 * Everything goes through the MCP tools except creating the document and giving
 * it to its owner, which are the two things a connection to a document cannot
 * do for itself.
 */

import '../lib/session.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { writeFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'https://playground.thedigitalvitamins.com';
const OWNER = process.env.PLAYGROUND_OWNER ?? 'imaxim@gmail.com';

const api = async (path, init) => {
  const res = await fetch(`${BASE}/api${path}`, {
    ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.status === 204 ? null : res.json();
};

const { document: doc } = await api('/documents', {
  method: 'POST', body: JSON.stringify({ name: 'Aires — design system & dashboard' }),
});
const raw = await (await fetch(`${BASE}/api/documents/${doc.id}/connections`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'aires build' }),
})).text();
const client = new Client({ name: 'aires', version: '1' });
await client.connect(new StreamableHTTPClientTransport(
  new URL(`${BASE}/mcp/${raw.match(/\/mcp\/([A-Z0-9-]+)/)[1]}`)));

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r.isError) throw new Error(`${name}: ${text}`);
  return text;
};
const json = async (name, args) => JSON.parse(await call(name, args));
/** find_nodes answers with an outline; this pulls one id out of it. */
const idOf = (tree, name, type = '') =>
  tree.split('\n').find((l) => l.includes(`"${name}"`) && l.startsWith(type))?.split('#')[1].split(' ')[0] ?? null;
const idsOf = (tree, name, type = '') =>
  tree.split('\n').filter((l) => l.includes(`"${name}"`) && l.startsWith(type)).map((l) => l.split('#')[1].split(' ')[0]);

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

const colour = (name, value) => ({ name, group: 'color', values: { default: value } });
await call('set_tokens', {
  tokens: [
    colour('color.navy.900', '#232E56'), colour('color.navy.800', '#2B3866'),
    colour('color.navy.700', '#3A4A80'), colour('color.navy.200', '#C9D1E8'),
    colour('color.ink', '#111A2E'),
    // Both greys are darker than they look in the reference: at 11-13px the
    // lighter values fail WCAG AA, and 94 of the linter's contrast errors came
    // from these two alone. They sit close together now and are told apart by
    // size, weight and tracking rather than by value.
    colour('color.ink.muted', '#5C6575'), colour('color.ink.faint', '#646D80'),
    colour('color.surface', '#FFFFFF'), colour('color.surface.page', '#F1F3F8'),
    colour('color.surface.sunken', '#F2F4F9'),
    colour('color.line', '#E7EAF1'), colour('color.line.soft', '#DDE2EC'),
    colour('color.positive', '#2E9E68'), colour('color.attention', '#E2643C'), colour('color.info', '#4C6FE7'),
    colour('color.tint.mint', '#E7F5EA'), colour('color.tint.peach', '#FCEDE3'),
    colour('color.tint.sky', '#E6F1FB'), colour('color.tint.rose', '#FAE9F0'),
    colour('color.tint.iris', '#E9ECFC'),
    ...[['radius.sm', '8px'], ['radius.md', '12px'], ['radius.lg', '16px'], ['radius.xl', '28px'], ['radius.pill', '999px']]
      .map(([name, value]) => ({ name, group: 'radius', values: { default: value } })),
    ...[['space.1', '4px'], ['space.2', '8px'], ['space.3', '12px'], ['space.4', '16px'], ['space.5', '24px'],
      ['space.6', '32px'], ['space.7', '48px'], ['space.8', '64px'], ['space.9', '80px']]
      .map(([name, value]) => ({ name, group: 'space', values: { default: value } })),
    { name: 'font.display', group: 'font', values: { default: '"Inter Tight", "Inter", system-ui, sans-serif' } },
    { name: 'font.sans', group: 'font', values: { default: '"Inter", system-ui, sans-serif' } },
    { name: 'shadow.card', group: 'shadow', values: { default: '0 1px 2px rgba(16, 24, 40, 0.04), 0 10px 28px rgba(16, 24, 40, 0.06)' } },
    { name: 'shadow.pill', group: 'shadow', values: { default: '0 1px 3px rgba(16, 24, 40, 0.10), 0 1px 1px rgba(16, 24, 40, 0.04)' } },
    { name: 'shadow.panel', group: 'shadow', values: { default: '0 32px 70px rgba(19, 28, 51, 0.10)' } },
  ],
});

// ---------------------------------------------------------------------------
// Page one: the style guide
// ---------------------------------------------------------------------------

const info = await json('get_basic_info');
await call('rename_page', { pageId: info.pages[0].id, name: 'Style guide' });
const guide = await json('create_artboard', {
  name: 'Design system', width: 1440, height: 4300, x: 0, y: 0,
  styles: { 'background-color': 'var(--color-surface-page)' },
});
// The starter artboard is the wrong shape for a specimen sheet.
for (const a of (await json('get_basic_info')).pages[0].artboards ?? []) {
  const id = a.id ?? a;
  if (id !== guide.id) await call('delete_nodes', { ids: [id] }).catch(() => {});
}

const guideRoot = (await json('write_html', {
  targetId: guide.id, mode: 'replace-children',
  html: `<div style="display:flex;flex-direction:column;gap:72px;padding:64px 80px 96px;width:100%;
    background-color:var(--color-surface-page);font-family:var(--font-sans);color:var(--color-ink)"></div>`,
})).roots[0].id;
const addGuide = (html) => json('write_html', { targetId: guideRoot, mode: 'insert-children', html });

await addGuide(`<style>
.cover{display:flex;flex-direction:column;gap:32px;padding:56px;border-radius:var(--radius-xl);background-color:var(--color-navy-900);width:100%}
.cover-top{display:flex;align-items:center;justify-content:space-between;width:100%}
.logo{display:flex;align-items:center;gap:11px;font-family:var(--font-display);font-size:27px;font-weight:700;letter-spacing:-0.025em;color:#ffffff}
.logo-mark{display:flex;align-items:center}
.logo-dot{width:14px;height:14px;border-radius:var(--radius-pill);border:2px solid #ffffff;margin-right:-6px}
.cover-ver{font-size:11px;font-weight:600;letter-spacing:0.14em;text-transform:uppercase;color:var(--color-navy-200)}
.cover-title{font-family:var(--font-display);font-size:76px;font-weight:800;letter-spacing:-0.035em;line-height:1.0;margin:0;color:#ffffff}
.cover-sub{font-size:17px;line-height:1.6;color:var(--color-navy-200);max-width:620px;margin:0}
.cover-meta{display:flex;gap:72px;padding-top:30px;border-top:1px solid rgba(255,255,255,0.15);width:100%}
.meta-cell{display:flex;flex-direction:column;gap:7px}
.meta-k{font-size:10px;font-weight:600;letter-spacing:0.14em;text-transform:uppercase;color:rgba(255,255,255,0.68)}
.meta-v{font-size:15px;font-weight:600;color:#ffffff}
</style>
<section class="cover">
  <div class="cover-top">
    <div class="logo"><span class="logo-mark"><span class="logo-dot"></span><span class="logo-dot"></span><span class="logo-dot"></span></span>aires.</div>
    <div class="cover-ver">v1.0 · September 2026</div>
  </div>
  <h1 class="cover-title">Design system</h1>
  <p class="cover-sub">The foundations behind the relocation dashboard — colour, type, spacing, and the small set of components they make. Every value here is a token, and the dashboard is built only out of what is on this page.</p>
  <div class="cover-meta">
    <div class="meta-cell"><span class="meta-k">Typeface</span><span class="meta-v">Inter Tight · Inter</span></div>
    <div class="meta-cell"><span class="meta-k">Canvas</span><span class="meta-v">1440 · 80px margin</span></div>
    <div class="meta-cell"><span class="meta-k">Corners</span><span class="meta-v">8 · 12 · 16 · 28</span></div>
    <div class="meta-cell"><span class="meta-k">Components</span><span class="meta-v">9</span></div>
  </div>
</section>`);

const swatch = (name, hex, token, dark = false) => `<div class="sw">
  <div class="sw-chip" style="background-color:var(${token})${dark ? ';border-color:transparent' : ''}"></div>
  <div class="sw-text"><span class="sw-name">${name}</span><span class="sw-hex">${hex}</span><span class="sw-var">${token}</span></div>
</div>`;

await addGuide(`<style>
.sec{display:flex;flex-direction:column;gap:32px;width:100%}
.sec-head{display:flex;flex-direction:column;gap:10px;max-width:620px}
.eyebrow{font-size:11px;font-weight:600;letter-spacing:0.14em;text-transform:uppercase;color:var(--color-ink-faint)}
.sec-h2{font-family:var(--font-display);font-size:40px;font-weight:700;letter-spacing:-0.025em;margin:0;color:var(--color-ink)}
.sec-p{font-size:15px;line-height:1.6;color:var(--color-ink-muted);margin:0}
.sub{font-size:10px;font-weight:600;letter-spacing:0.14em;text-transform:uppercase;color:var(--color-ink-faint);margin:0}
.sw-group{display:flex;flex-direction:column;gap:14px;width:100%}
.sw-row{display:flex;gap:16px;width:100%}
.sw{display:flex;flex-direction:column;gap:12px;flex:1}
.sw-chip{height:104px;border-radius:var(--radius-md);border:1px solid var(--color-line)}
.sw-text{display:flex;flex-direction:column;gap:3px}
.sw-name{font-size:14px;font-weight:600;color:var(--color-ink)}
.sw-hex{font-size:12px;color:var(--color-ink-muted)}
.sw-var{font-size:11px;color:var(--color-ink-faint)}
</style>
<section class="sec">
  <div class="sec-head">
    <span class="eyebrow">01 — Foundations</span>
    <h2 class="sec-h2">Colour</h2>
    <p class="sec-p">Navy carries the chrome and nothing else. The five tints carry meaning on the metric cards and are never used as decoration. Signal colours only ever appear next to a number they describe.</p>
  </div>
  <div class="sw-group"><p class="sub">Chrome</p><div class="sw-row">
    ${swatch('Navy 900', '#232E56', '--color-navy-900', true)}
    ${swatch('Navy 800', '#2B3866', '--color-navy-800', true)}
    ${swatch('Navy 700', '#3A4A80', '--color-navy-700', true)}
    ${swatch('Navy 200', '#C9D1E8', '--color-navy-200')}
    ${swatch('Ink', '#111A2E', '--color-ink', true)}
  </div></div>
  <div class="sw-group"><p class="sub">Surface &amp; text</p><div class="sw-row">
    ${swatch('Surface', '#FFFFFF', '--color-surface')}
    ${swatch('Page', '#F1F3F8', '--color-surface-page')}
    ${swatch('Sunken', '#F2F4F9', '--color-surface-sunken')}
    ${swatch('Muted ink', '#5C6575', '--color-ink-muted', true)}
    ${swatch('Line', '#E7EAF1', '--color-line')}
  </div></div>
  <div class="sw-group"><p class="sub">Card tints</p><div class="sw-row">
    ${swatch('Mint', '#E7F5EA', '--color-tint-mint')}
    ${swatch('Peach', '#FCEDE3', '--color-tint-peach')}
    ${swatch('Sky', '#E6F1FB', '--color-tint-sky')}
    ${swatch('Rose', '#FAE9F0', '--color-tint-rose')}
    ${swatch('Iris', '#E9ECFC', '--color-tint-iris')}
  </div></div>
  <div class="sw-group"><p class="sub">Signal</p><div class="sw-row">
    ${swatch('Positive', '#2E9E68', '--color-positive', true)}
    ${swatch('Attention', '#E2643C', '--color-attention', true)}
    ${swatch('Info', '#4C6FE7', '--color-info', true)}
    <div class="sw"></div><div class="sw"></div>
  </div></div>
</section>`);

await addGuide(`<style>
.sec2{display:flex;flex-direction:column;gap:28px;width:100%}
.sec2-head{display:flex;flex-direction:column;gap:10px;max-width:620px}
.eyebrow2{font-size:11px;font-weight:600;letter-spacing:0.14em;text-transform:uppercase;color:var(--color-ink-faint)}
.h2b{font-family:var(--font-display);font-size:40px;font-weight:700;letter-spacing:-0.025em;margin:0;color:var(--color-ink)}
.pb{font-size:15px;line-height:1.6;color:var(--color-ink-muted);margin:0}
.type-list{display:flex;flex-direction:column;width:100%;border-top:1px solid var(--color-line)}
.type-row{display:flex;gap:48px;align-items:baseline;padding:26px 0;border-bottom:1px solid var(--color-line);width:100%}
.type-meta{width:236px;display:flex;flex-direction:column;gap:5px;flex:none}
.type-name{font-size:14px;font-weight:600;color:var(--color-ink)}
.type-spec{font-size:12px;line-height:1.5;color:var(--color-ink-muted)}
.type-sample{flex:1;min-width:0}
.sp-display{font-family:var(--font-display);font-size:64px;font-weight:800;letter-spacing:-0.035em;line-height:1.05;color:var(--color-ink);margin:0}
.sp-metric{font-family:var(--font-display);font-size:44px;font-weight:700;letter-spacing:-0.025em;line-height:1;color:var(--color-ink);margin:0}
.sp-title{font-family:var(--font-display);font-size:24px;font-weight:700;letter-spacing:-0.02em;color:var(--color-ink);margin:0}
.sp-body{font-size:15px;line-height:1.6;color:var(--color-ink-muted);margin:0;max-width:520px}
.sp-label{font-size:13px;font-weight:500;color:var(--color-ink-muted);margin:0}
.sp-caps{font-size:11px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:var(--color-ink);margin:0}
</style>
<section class="sec2">
  <div class="sec2-head">
    <span class="eyebrow2">02 — Foundations</span>
    <h2 class="h2b">Type</h2>
    <p class="pb">Inter Tight for anything a person reads at a glance — the greeting and every number. Inter for everything they read a word at a time. Two families, six roles, nothing else.</p>
  </div>
  <div class="type-list">
    <div class="type-row"><div class="type-meta"><span class="type-name">Display</span><span class="type-spec">Inter Tight · 64 / 67 · 800<br>tracking −0.035em</span></div>
      <div class="type-sample"><p class="sp-display">Good morning, Helen!</p></div></div>
    <div class="type-row"><div class="type-meta"><span class="type-name">Metric</span><span class="type-spec">Inter Tight · 44 / 44 · 700<br>tracking −0.025em · tabular</span></div>
      <div class="type-sample"><p class="sp-metric">27,907</p></div></div>
    <div class="type-row"><div class="type-meta"><span class="type-name">Title</span><span class="type-spec">Inter Tight · 24 / 32 · 700</span></div>
      <div class="type-sample"><p class="sp-title">Active relocations this quarter</p></div></div>
    <div class="type-row"><div class="type-meta"><span class="type-name">Body</span><span class="type-spec">Inter · 15 / 24 · 400</span></div>
      <div class="type-sample"><p class="sp-body">Exception spend is tracked against the policy each assignment was approved under, so a housing exception shows up here the day it is raised.</p></div></div>
    <div class="type-row"><div class="type-meta"><span class="type-name">Label</span><span class="type-spec">Inter · 13 / 20 · 500 · muted</span></div>
      <div class="type-sample"><p class="sp-label">housing exceptions</p></div></div>
    <div class="type-row"><div class="type-meta"><span class="type-name">Micro caps</span><span class="type-spec">Inter · 11 · 600 · tracking 0.12em<br>buttons, eyebrows, table heads</span></div>
      <div class="type-sample"><p class="sp-caps">Details · Go to tasks · Year-to-date</p></div></div>
  </div>
</section>`);

await addGuide(`<style>
.sec3{display:flex;flex-direction:column;gap:28px;width:100%}
.h2c{font-family:var(--font-display);font-size:40px;font-weight:700;letter-spacing:-0.025em;margin:0;color:var(--color-ink)}
.eyebrow3{font-size:11px;font-weight:600;letter-spacing:0.14em;text-transform:uppercase;color:var(--color-ink-faint)}
.pc{font-size:15px;line-height:1.6;color:var(--color-ink-muted);margin:0;max-width:620px}
.three{display:flex;gap:24px;width:100%;align-items:stretch}
.panel{display:flex;flex-direction:column;gap:20px;flex:1;padding:28px;background-color:var(--color-surface);border-radius:var(--radius-lg);border:1px solid var(--color-line)}
.panel-h{font-size:10px;font-weight:600;letter-spacing:0.14em;text-transform:uppercase;color:var(--color-ink-faint);margin:0}
.rad-row{display:flex;align-items:center;gap:16px}
.rad-chip{width:56px;height:56px;background-color:var(--color-surface-sunken);border:1px solid var(--color-line-soft);flex:none}
.rad-name{font-size:13px;font-weight:600;color:var(--color-ink)}
.rad-val{font-size:12px;color:var(--color-ink-faint)}
.rad-text{display:flex;flex-direction:column;gap:2px}
.el-card{padding:18px;border-radius:var(--radius-md);background-color:var(--color-surface)}
.el-name{font-size:13px;font-weight:600;color:var(--color-ink)}
.el-val{font-size:11px;color:var(--color-ink-faint);margin-top:3px}
.sp-row{display:flex;align-items:center;gap:14px}
.sp-bar{height:12px;border-radius:3px;background-color:var(--color-navy-700)}
.sp-name{font-size:12px;color:var(--color-ink-muted);width:74px;flex:none}
</style>
<section class="sec3">
  <div class="sec2-head">
    <span class="eyebrow3">03 — Foundations</span>
    <h2 class="h2c">Shape, depth and space</h2>
    <p class="pc">One radius per role, three elevations, and an 8px rhythm. A card is 12, a panel is 28, and a control that holds text is a pill.</p>
  </div>
  <div class="three">
    <div class="panel">
      <p class="panel-h">Radius</p>
      <div class="rad-row"><div class="rad-chip" style="border-radius:var(--radius-sm)"></div><div class="rad-text"><span class="rad-name">Small</span><span class="rad-val">8px · buttons, inputs</span></div></div>
      <div class="rad-row"><div class="rad-chip" style="border-radius:var(--radius-md)"></div><div class="rad-text"><span class="rad-name">Medium</span><span class="rad-val">12px · metric cards</span></div></div>
      <div class="rad-row"><div class="rad-chip" style="border-radius:var(--radius-lg)"></div><div class="rad-text"><span class="rad-name">Large</span><span class="rad-val">16px · inner panels</span></div></div>
      <div class="rad-row"><div class="rad-chip" style="border-radius:var(--radius-xl)"></div><div class="rad-text"><span class="rad-name">Extra large</span><span class="rad-val">28px · app shell, sheets</span></div></div>
      <div class="rad-row"><div class="rad-chip" style="border-radius:var(--radius-pill)"></div><div class="rad-text"><span class="rad-name">Pill</span><span class="rad-val">Full · tabs, search, chips</span></div></div>
    </div>
    <div class="panel" style="background-color:var(--color-surface-sunken)">
      <p class="panel-h">Elevation</p>
      <div class="el-card" style="box-shadow:var(--shadow-pill)"><div class="el-name">Pill</div><div class="el-val">The selected tab, lifted off its track</div></div>
      <div class="el-card" style="box-shadow:var(--shadow-card)"><div class="el-name">Card</div><div class="el-val">Anything resting on the page</div></div>
      <div class="el-card" style="box-shadow:var(--shadow-panel)"><div class="el-name">Panel</div><div class="el-val">A surface crossing the navy edge</div></div>
    </div>
    <div class="panel">
      <p class="panel-h">Space</p>
      ${[['1 · 4', 4], ['2 · 8', 8], ['3 · 12', 12], ['4 · 16', 16], ['5 · 24', 24], ['6 · 32', 32], ['7 · 48', 48], ['8 · 64', 64], ['9 · 80', 80]]
        .map(([n, w]) => `<div class="sp-row"><span class="sp-name">${n}</span><div class="sp-bar" style="width:${w}px"></div></div>`).join('')}
    </div>
  </div>
</section>`);

// --- The metric card, as a specimen and then as a component ----------------

const STAT_CSS = `
.stat{display:flex;flex-direction:column;justify-content:space-between;gap:20px;flex:1;min-width:0;padding:22px 20px;border-radius:var(--radius-md);background-color:var(--color-tint-mint)}
.stat-body{display:flex;flex-direction:column;gap:5px}
.stat-num{display:flex;align-items:flex-start;gap:2px;font-family:var(--font-display);font-size:44px;font-weight:700;letter-spacing:-0.03em;line-height:1.02;color:var(--color-ink)}
.stat-cur{font-size:21px;font-weight:700;line-height:1.1;color:var(--color-ink)}
.stat-label{font-size:14.5px;line-height:1.35;color:var(--color-ink-muted)}
.stat-rule{height:1px;width:100%;background-color:rgba(17,26,46,0.10)}
.stat-foot{display:flex;flex-direction:column;gap:14px}
.stat-delta{display:flex;align-items:center;gap:7px;font-size:13px;line-height:1.3}
.tri-up{width:0;height:0;flex:none;border-left:5px solid transparent;border-right:5px solid transparent;border-bottom:8px solid var(--color-positive)}
.dot-alert{display:none;align-items:center;justify-content:center;width:15px;height:15px;flex:none;border-radius:var(--radius-pill);background-color:var(--color-attention);font-size:10px;font-weight:700;color:#ffffff}
.ring-info{display:none;width:14px;height:14px;flex:none;border-radius:var(--radius-pill);border:2px solid var(--color-info)}
.delta-strong{font-weight:700;color:var(--color-ink)}
.delta-text{color:var(--color-ink-muted)}
.stat-btn{display:flex;align-items:center;justify-content:center;height:36px;border-radius:var(--radius-sm);background-color:var(--color-surface);border:1px solid rgba(17,26,46,0.05);font-size:11px;font-weight:600;letter-spacing:0.12em;color:var(--color-ink)}`;

/** The five states the design needs, in the order they appear on the dashboard. */
const CARDS = [
  { tint: 'mint', currency: true, num: '27,907', label: 'housing exceptions', icon: 'tri', strong: '52%', text: 'of exception spend', btn: 'DETAILS' },
  { tint: 'peach', num: '4', label: 'overdue tasks', icon: 'alert', text: 'Take action', btn: 'GO TO TASKS' },
  { tint: 'sky', num: '56', label: 'New initiations', icon: 'tri', strong: '330%', text: 'Year-over-Year', btn: 'DETAILS' },
  { tint: 'rose', num: '18', label: 'Active relocations', icon: 'tri', strong: '1700%', text: 'Year-over-Year', btn: 'DETAILS' },
  { tint: 'iris', num: '16', label: 'Active households', icon: 'ring', strong: '3', text: 'Pending review', btn: 'DETAILS' },
  { tint: 'mint', currency: true, num: '1.24M', label: 'Budget remaining', icon: 'tri', strong: '12%', text: 'under forecast', btn: 'DETAILS' },
];

await addGuide(`<style>
.sec4{display:flex;flex-direction:column;gap:30px;width:100%}
.eyebrow4{font-size:11px;font-weight:600;letter-spacing:0.14em;text-transform:uppercase;color:var(--color-ink-faint)}
.h2d{font-family:var(--font-display);font-size:40px;font-weight:700;letter-spacing:-0.025em;margin:0;color:var(--color-ink)}
.pd{font-size:15px;line-height:1.6;color:var(--color-ink-muted);margin:0;max-width:620px}
.spec{display:flex;flex-direction:column;gap:16px;width:100%}
.spec-h{display:flex;align-items:baseline;gap:12px}
.spec-name{font-size:13px;font-weight:600;color:var(--color-ink)}
.spec-note{font-size:12px;color:var(--color-ink-faint)}
.spec-stage{display:flex;align-items:center;gap:24px;padding:26px;border-radius:var(--radius-lg);background-color:var(--color-surface);border:1px solid var(--color-line);width:100%}
.stage-navy{background-color:var(--color-navy-900);border-color:transparent;padding:0}
.topbar{display:flex;align-items:center;gap:40px;width:100%;padding:20px 32px}
.tb-logo{display:flex;align-items:center;gap:10px;font-family:var(--font-display);font-size:23px;font-weight:700;letter-spacing:-0.025em;color:#ffffff}
.tb-mark{display:flex;align-items:center}
.tb-dot{width:12px;height:12px;border-radius:var(--radius-pill);border:2px solid #ffffff;margin-right:-5px}
.tb-nav{display:flex;align-items:center;gap:30px;flex:1}
.tb-link{font-size:15px;font-weight:500;color:rgba(255,255,255,0.68)}
.tb-link-on{font-size:15px;font-weight:700;color:#ffffff}
.tb-search{display:flex;align-items:center;gap:11px;width:320px;height:42px;padding:0 18px;border-radius:var(--radius-pill);background-color:rgba(255,255,255,0.10)}
.tb-mag{width:13px;height:13px;flex:none;border-radius:var(--radius-pill);border:1.5px solid rgba(255,255,255,0.7)}
.tb-ph{flex:1;font-size:11.5px;font-weight:600;letter-spacing:0.12em;color:rgba(255,255,255,0.7)}
.tb-kbd{font-size:12px;color:rgba(255,255,255,0.7)}
.seg{display:flex;align-items:center;padding:5px;border-radius:var(--radius-pill);background-color:var(--color-surface-sunken)}
.seg-opt{padding:10px 26px;border-radius:var(--radius-pill);font-size:14.5px;font-weight:500;color:var(--color-ink-muted)}
.seg-on{padding:10px 26px;border-radius:var(--radius-pill);background-color:var(--color-surface);box-shadow:var(--shadow-pill);font-size:14.5px;font-weight:700;color:var(--color-ink)}
.btn-primary{display:flex;align-items:center;justify-content:center;height:44px;padding:0 26px;border-radius:var(--radius-pill);background-color:var(--color-navy-900);font-size:11px;font-weight:600;letter-spacing:0.12em;color:#ffffff}
.btn-quiet{display:flex;align-items:center;justify-content:center;height:40px;padding:0 24px;border-radius:var(--radius-sm);background-color:var(--color-surface);border:1px solid var(--color-line-soft);font-size:11px;font-weight:600;letter-spacing:0.12em;color:var(--color-ink)}
.btn-text{display:flex;align-items:center;gap:8px;font-size:11px;font-weight:600;letter-spacing:0.12em;color:var(--color-navy-700)}
.pill-live{display:flex;align-items:center;gap:7px;padding:6px 12px;border-radius:var(--radius-pill);background-color:var(--color-tint-mint);font-size:12px;font-weight:600;color:#1F7A4D}
.pill-hold{display:flex;align-items:center;gap:7px;padding:6px 12px;border-radius:var(--radius-pill);background-color:var(--color-tint-peach);font-size:12px;font-weight:600;color:#B14A23}
.pill-done{display:flex;align-items:center;gap:7px;padding:6px 12px;border-radius:var(--radius-pill);background-color:var(--color-surface-sunken);font-size:12px;font-weight:600;color:var(--color-ink-muted)}
.pill-dot{width:6px;height:6px;border-radius:var(--radius-pill);background-color:currentColor}
.stat-row{display:flex;gap:16px;width:100%}
${STAT_CSS}
</style>
<section class="sec4">
  <div class="sec2-head">
    <span class="eyebrow4">04 — Components</span>
    <h2 class="h2d">Components</h2>
    <p class="pd">Nine pieces cover the whole product. The metric card below is a real component: the dashboard places instances of it and overrides the number, the words and the tint — nothing else.</p>
  </div>
  <div class="spec">
    <div class="spec-h"><span class="spec-name">Top bar</span><span class="spec-note">navy 900 · 82px · search is a pill at 10% white</span></div>
    <div class="spec-stage stage-navy"><div class="topbar">
      <div class="tb-logo"><span class="tb-mark"><span class="tb-dot"></span><span class="tb-dot"></span><span class="tb-dot"></span></span>aires.</div>
      <div class="tb-nav"><span class="tb-link-on">Home</span><span class="tb-link">Initiations</span><span class="tb-link">Tasks</span><span class="tb-link">People</span><span class="tb-link">Budgets</span></div>
      <div class="tb-search"><span class="tb-mag"></span><span class="tb-ph">SEARCH</span><span class="tb-kbd">⌘K</span></div>
    </div></div>
  </div>
  <div class="spec">
    <div class="spec-h"><span class="spec-name">Segmented control</span><span class="spec-note">the selected option is a white pill lifted off a sunken track</span></div>
    <div class="spec-stage">
      <div class="seg"><span class="seg-on">Overview</span><span class="seg-opt">Analytics</span><span class="seg-opt">Documents</span><span class="seg-opt">Reports</span></div>
      <div class="seg"><span class="seg-on">Year-to-Date</span><span class="seg-opt">Last 12 mos</span></div>
    </div>
  </div>
  <div class="spec">
    <div class="spec-h"><span class="spec-name">Buttons &amp; status</span><span class="spec-note">labels are micro caps; a button never carries sentence case</span></div>
    <div class="spec-stage">
      <div class="btn-primary">VIEW REPORT</div><div class="btn-quiet">DETAILS</div><div class="btn-text">GO TO TASKS →</div>
      <div class="pill-live"><span class="pill-dot"></span>In progress</div>
      <div class="pill-hold"><span class="pill-dot"></span>On hold</div>
      <div class="pill-done"><span class="pill-dot"></span>Complete</div>
    </div>
  </div>
  <div class="spec">
    <div class="spec-h"><span class="spec-name">Metric card</span><span class="spec-note">one component · five tints · three signal states</span></div>
    <div class="stat-row">
      <div class="stat">
        <div class="stat-body"><div class="stat-num"><span class="stat-cur">$</span>27,907</div><div class="stat-label">housing exceptions</div></div>
        <div class="stat-rule"></div>
        <div class="stat-foot">
          <div class="stat-delta">
            <span class="tri-up"></span><span class="dot-alert">!</span><span class="ring-info"></span>
            <span class="delta-strong">52%</span><span class="delta-text">of exception spend</span>
          </div>
          <div class="stat-btn">DETAILS</div>
        </div>
      </div>
    </div>
  </div>
</section>`);

const tree = await call('find_nodes', { query: 'stat', within: guide.id, limit: 60 });
const specimenRow = idOf(tree, 'stat-row');
const made = await json('create_component', {
  id: idOf(tree, 'stat', 'frame'), name: 'Metric card',
  description: 'A number, a label, a signal and an action, on one of five tints.',
});
const PART = Object.fromEntries((await json('get_instance', { id: made.instanceId }))
  .overridableParts.map((p) => [p.name, p.defId]));
const P = {
  root: PART['Metric card'], cur: PART.$, num: PART['27,907'], label: PART['housing exceptions'],
  strong: PART['52%'], text: PART['of exception spend'], btn: PART.DETAILS, alert: PART['!'],
};
// The two empty spans — the triangle and the info ring — have no text to be
// named after, so they are taken in the order they appear in the delta row.
const blanks = (await json('get_instance', { id: made.instanceId })).overridableParts
  .filter((p) => p.type === 'text' && !p.text).map((p) => p.defId);
[P.tri, P.ring] = blanks;

const overridesFor = (instanceId, s, width) => [
  { instanceId, defId: P.root, styles: { 'background-color': `var(--color-tint-${s.tint})`, ...(width ? { width, flex: 'none' } : {}) } },
  { instanceId, defId: P.cur, styles: { display: s.currency ? 'block' : 'none' } },
  { instanceId, defId: P.num, text: s.num },
  { instanceId, defId: P.label, text: s.label, styles: { 'white-space': 'nowrap' } },
  { instanceId, defId: P.tri, styles: { display: s.icon === 'tri' ? 'block' : 'none' } },
  { instanceId, defId: P.alert, styles: { display: s.icon === 'alert' ? 'flex' : 'none' } },
  { instanceId, defId: P.ring, styles: { display: s.icon === 'ring' ? 'block' : 'none' } },
  { instanceId, defId: P.strong, text: s.strong ?? '', styles: { display: s.strong ? 'block' : 'none' } },
  { instanceId, defId: P.text, text: s.text, styles: s.icon === 'alert'
    ? { color: 'var(--color-attention)', 'font-weight': '600', 'white-space': 'nowrap' }
    : { color: 'var(--color-ink-muted)', 'font-weight': '400', 'white-space': 'nowrap' } },
  { instanceId, defId: P.btn, text: s.btn },
];

// The other four specimens are instances too, so the guide shows the component
// in every state rather than four look-alikes.
await json('insert_instance', { componentId: made.componentId, parentId: specimenRow, count: 4 });
const guideInstances = idsOf(await call('find_nodes', { query: 'Metric card', within: guide.id, limit: 20 }), 'Metric card', 'instance');
await call('set_override', { updates: guideInstances.slice(1).flatMap((id, i) => overridesFor(id, CARDS[i + 1])) });

// ---------------------------------------------------------------------------
// Page two: the dashboard
// ---------------------------------------------------------------------------

const dashPage = await json('create_page', { name: 'Dashboard', switchTo: true });
const dash = await json('create_artboard', {
  name: 'Home — desktop', width: 1440, height: 1960, x: 1640, y: 0,
  styles: { 'background-color': '#EDF1EC' }, pageId: dashPage.id,
});
const shell = (await json('write_html', {
  targetId: dash.id, mode: 'replace-children',
  html: `<div style="display:flex;flex-direction:column;width:100%;height:100%;margin:20px 20px 0;
    border-radius:var(--radius-xl) var(--radius-xl) 0 0;overflow:hidden;background-color:var(--color-surface-page);
    font-family:var(--font-sans);color:var(--color-ink);box-shadow:var(--shadow-panel)"></div>`,
})).roots[0].id;
const addDash = (html, target) => json('write_html', { targetId: target, mode: 'insert-children', html });

await addDash(`<style>
.d-top{display:flex;flex-direction:column;width:100%;background-color:var(--color-navy-900);padding-bottom:124px}
.d-nav{display:flex;align-items:center;gap:44px;width:100%;padding:26px 78px}
.d-logo{display:flex;align-items:center;gap:10px;font-family:var(--font-display);font-size:24px;font-weight:700;letter-spacing:-0.025em;color:#ffffff}
.d-mark{display:flex;align-items:center}
.d-dot{width:13px;height:13px;border-radius:var(--radius-pill);border:2px solid #ffffff;margin-right:-5px}
.d-links{display:flex;align-items:center;gap:32px;flex:1}
.d-link{font-size:15.5px;font-weight:500;color:rgba(255,255,255,0.68)}
.d-link-on{font-size:15.5px;font-weight:700;color:#ffffff}
.d-search{display:flex;align-items:center;gap:12px;width:318px;height:44px;padding:0 18px;border-radius:var(--radius-pill);background-color:rgba(255,255,255,0.10)}
.d-mag{width:13px;height:13px;flex:none;border-radius:var(--radius-pill);border:1.5px solid rgba(255,255,255,0.7)}
.d-ph{flex:1;font-size:11.5px;font-weight:600;letter-spacing:0.12em;color:rgba(255,255,255,0.7)}
.d-kbd{font-size:12.5px;color:rgba(255,255,255,0.7)}
.d-hero{display:flex;flex-direction:column;gap:14px;padding:76px 78px 0}
.d-greet{font-family:var(--font-display);font-size:70px;font-weight:800;letter-spacing:-0.035em;line-height:1.0;margin:0;color:#ffffff}
</style>
<div class="d-top">
  <div class="d-nav">
    <div class="d-logo"><span class="d-mark"><span class="d-dot"></span><span class="d-dot"></span><span class="d-dot"></span></span>aires.</div>
    <div class="d-links"><span class="d-link-on">Home</span><span class="d-link">Initiations</span><span class="d-link">Tasks</span><span class="d-link">People</span><span class="d-link">Budgets</span></div>
    <div class="d-search"><span class="d-mag"></span><span class="d-ph">SEARCH</span><span class="d-kbd">⌘K</span></div>
  </div>
  <div class="d-hero"><h1 class="d-greet">Good morning, Helen!</h1></div>
</div>`, shell);

// The panels start above the navy edge and overlap it, which is the move the
// whole layout turns on.
const body = (await addDash(`<div style="display:flex;flex-direction:column;gap:26px;width:100%;
  padding:0 78px 44px;margin-top:-78px"></div>`, shell)).roots[0].id;

await addDash(`<style>
.d-panel{display:flex;width:100%;padding:33px 34px;border-radius:24px;background-color:var(--color-surface);box-shadow:var(--shadow-card);align-items:center;justify-content:space-between}
.d-seg{display:flex;align-items:center;padding:5px;border-radius:var(--radius-pill);background-color:var(--color-surface-sunken)}
.d-opt{padding:12px 28px;border-radius:var(--radius-pill);font-size:15px;font-weight:500;color:var(--color-ink-muted)}
.d-on{padding:12px 28px;border-radius:var(--radius-pill);background-color:var(--color-surface);box-shadow:var(--shadow-pill);font-size:15px;font-weight:700;color:var(--color-ink)}
</style>
<div class="d-panel">
  <div class="d-seg"><span class="d-on">Overview</span><span class="d-opt">Analytics</span><span class="d-opt">Documents</span><span class="d-opt">Reports</span></div>
  <div class="d-seg"><span class="d-on">Year-to-Date</span><span class="d-opt">Last 12 mos</span></div>
</div>`, body);

// Five cards fill the panel and the sixth is clipped by its edge: the row is a
// scroller, and that is what the design shows.
const cardsPanel = (await addDash(`<div style="display:flex;width:100%;margin-top:44px;padding:36px 34px;border-radius:24px;
  overflow:hidden;background-color:var(--color-surface);box-shadow:var(--shadow-card)">
  <div style="display:flex;gap:16px;width:100%;overflow:hidden"></div>
</div>`, body)).roots[0].id;
const cardsRow = (await json('get_node_info', { id: cardsPanel })).children[0].id;
await json('insert_instance', { componentId: made.componentId, parentId: cardsRow, count: 6 });
const dashInstances = idsOf(await call('find_nodes', { query: 'Metric card', within: dash.id, limit: 20 }), 'Metric card', 'instance');
await call('set_override', { updates: dashInstances.flatMap((id, i) => overridesFor(id, CARDS[i], '218px')) });

// --- Spend, the attention queue, and the table -----------------------------

const PILLS = `
.p-live{display:flex;align-items:center;gap:6px;padding:5px 11px;flex:none;border-radius:var(--radius-pill);background-color:var(--color-tint-mint);font-size:11.5px;font-weight:600;color:#1F7A4D}
.p-hold{display:flex;align-items:center;gap:6px;padding:5px 11px;flex:none;border-radius:var(--radius-pill);background-color:var(--color-tint-peach);font-size:11.5px;font-weight:600;color:#B14A23}
.p-wait{display:flex;align-items:center;gap:6px;padding:5px 11px;flex:none;border-radius:var(--radius-pill);background-color:var(--color-tint-iris);font-size:11.5px;font-weight:600;color:#3C56B8}
.p-dot{width:6px;height:6px;flex:none;border-radius:var(--radius-pill);background-color:currentColor}`;

const BARS = [['Jan', 58], ['Feb', 71], ['Mar', 64], ['Apr', 88], ['May', 76], ['Jun', 94],
  ['Jul', 82], ['Aug', 61], ['Sep', 100], ['Oct', 47], ['Nov', 36], ['Dec', 28]];
const bar = ([month, pct], i) => `<div class="bar-col">
  <div class="bar-track"><div class="bar" style="height:${pct}%${i === 8 ? ';background-color:var(--color-info)' : ''}"></div></div>
  <span class="bar-month"${i === 8 ? ' style="color:var(--color-ink);font-weight:600"' : ''}>${month}</span>
</div>`;
const person = (initials, tint, name, meta, pill, cls) => `<div class="att-row">
  <div class="att-av" style="background-color:var(--color-tint-${tint})">${initials}</div>
  <div class="att-text"><span class="att-name">${name}</span><span class="att-meta">${meta}</span></div>
  <div class="${cls}"><span class="p-dot"></span>${pill}</div>
</div>`;

await addDash(`<style>
.d-row2{display:flex;gap:26px;width:100%;align-items:stretch}
.d-big{display:flex;flex-direction:column;gap:26px;flex:2;min-width:0;padding:30px 34px;border-radius:24px;background-color:var(--color-surface);box-shadow:var(--shadow-card)}
.d-side{display:flex;flex-direction:column;gap:20px;flex:1;min-width:0;padding:30px;border-radius:24px;background-color:var(--color-surface);box-shadow:var(--shadow-card)}
.ph-row{display:flex;align-items:flex-start;justify-content:space-between;width:100%;gap:20px}
.ph-text{display:flex;flex-direction:column;gap:5px}
.ph-title{font-family:var(--font-display);font-size:22px;font-weight:700;letter-spacing:-0.02em;color:var(--color-ink);margin:0}
.ph-sub{font-size:13.5px;color:var(--color-ink-muted);margin:0}
.mini-seg{display:flex;align-items:center;padding:4px;border-radius:var(--radius-pill);background-color:var(--color-surface-sunken);flex:none}
.mini-on{padding:8px 18px;border-radius:var(--radius-pill);background-color:var(--color-surface);box-shadow:var(--shadow-pill);font-size:12.5px;font-weight:700;color:var(--color-ink)}
.mini-opt{padding:8px 18px;border-radius:var(--radius-pill);font-size:12.5px;font-weight:500;color:var(--color-ink-muted)}
.chart{display:flex;align-items:flex-end;gap:14px;width:100%}
.bar-col{display:flex;flex-direction:column;align-items:center;gap:11px;flex:1;min-width:0}
.bar-track{display:flex;align-items:flex-end;width:100%;height:172px;border-radius:var(--radius-sm);background-color:var(--color-surface-sunken)}
.bar{width:100%;border-radius:var(--radius-sm);background-color:var(--color-navy-700)}
.bar-month{font-size:11.5px;color:var(--color-ink-faint)}
.legend{display:flex;align-items:center;gap:24px;padding-top:22px;border-top:1px solid var(--color-line);width:100%}
.leg{display:flex;align-items:center;gap:9px;font-size:12.5px;color:var(--color-ink-muted)}
.leg-key{width:11px;height:11px;border-radius:3px;background-color:var(--color-navy-700)}
.leg-spacer{flex:1}
.leg-total{font-size:12.5px;color:var(--color-ink-muted)}
.leg-strong{font-family:var(--font-display);font-size:19px;font-weight:700;letter-spacing:-0.02em;color:var(--color-ink)}
.att-row{display:flex;align-items:center;gap:13px;width:100%;padding:11px 0;border-bottom:1px solid var(--color-line)}
.att-av{display:flex;align-items:center;justify-content:center;width:38px;height:38px;flex:none;border-radius:var(--radius-pill);font-size:12.5px;font-weight:700;color:var(--color-ink)}
.att-text{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}
.att-name{font-size:14px;font-weight:600;color:var(--color-ink)}
.att-meta{font-size:12.5px;color:var(--color-ink-muted)}
.side-foot{display:flex;align-items:center;justify-content:center;height:40px;width:100%;border-radius:var(--radius-sm);border:1px solid var(--color-line-soft);font-size:11px;font-weight:600;letter-spacing:0.12em;color:var(--color-ink)}
${PILLS}
</style>
<div class="d-row2">
  <div class="d-big">
    <div class="ph-row">
      <div class="ph-text"><h3 class="ph-title">Relocation spend</h3><p class="ph-sub">Committed against approved budget, by month</p></div>
      <div class="mini-seg"><span class="mini-on">Monthly</span><span class="mini-opt">Quarterly</span></div>
    </div>
    <div class="chart">${BARS.map(bar).join('')}</div>
    <div class="legend">
      <div class="leg"><span class="leg-key"></span>Committed</div>
      <div class="leg"><span class="leg-key" style="background-color:var(--color-info)"></span>September · current</div>
      <div class="leg-spacer"></div>
      <span class="leg-total">Year to date</span><span class="leg-strong">$4.31M</span>
    </div>
  </div>
  <div class="d-side">
    <div class="ph-row"><div class="ph-text"><h3 class="ph-title">Needs you</h3><p class="ph-sub">Four people are waiting on a decision</p></div></div>
    ${person('MK', 'sky', 'Marcus Keane', 'Housing exception · Zurich', 'Waiting', 'p-wait')}
    ${person('AO', 'rose', 'Adaeze Okafor', 'Lease break · Dublin', 'On hold', 'p-hold')}
    ${person('LP', 'mint', 'Lena Petrova', 'School search · Boston', 'In progress', 'p-live')}
    ${person('TS', 'peach', 'Tomás Silva', 'Temp housing · Lisbon', 'Waiting', 'p-wait')}
    <div class="side-foot">OPEN THE QUEUE</div>
  </div>
</div>`, body);

const row = (name, initials, tint, dest, stage, budget, pill, cls) => `<div class="t-row">
  <div class="t-person"><div class="t-av" style="background-color:var(--color-tint-${tint})">${initials}</div><span class="t-name">${name}</span></div>
  <span class="t-cell">${dest}</span><span class="t-cell">${stage}</span><span class="t-cell t-num">${budget}</span>
  <div class="t-status"><div class="${cls}"><span class="p-dot"></span>${pill}</div></div>
</div>`;

await addDash(`<style>
.d-table{display:flex;flex-direction:column;gap:22px;width:100%;padding:30px 34px 14px;border-radius:24px;background-color:var(--color-surface);box-shadow:var(--shadow-card)}
.t-head-row{display:flex;align-items:center;justify-content:space-between;width:100%}
.t-title{font-family:var(--font-display);font-size:22px;font-weight:700;letter-spacing:-0.02em;color:var(--color-ink);margin:0}
.t-actions{display:flex;align-items:center;gap:10px}
.t-chip{padding:9px 16px;border-radius:var(--radius-pill);background-color:var(--color-surface-sunken);font-size:12.5px;font-weight:600;color:var(--color-ink-muted)}
.t-chip-on{padding:9px 16px;border-radius:var(--radius-pill);background-color:var(--color-navy-900);font-size:12.5px;font-weight:600;color:#ffffff}
.t-cols{display:flex;align-items:center;width:100%;padding:0 0 12px;border-bottom:1px solid var(--color-line)}
.t-col{font-size:10px;font-weight:600;letter-spacing:0.14em;text-transform:uppercase;color:var(--color-ink-faint)}
.t-row{display:flex;align-items:center;width:100%;padding:15px 0;border-bottom:1px solid var(--color-line)}
.t-person{display:flex;align-items:center;gap:12px;flex:2;min-width:0}
.t-av{display:flex;align-items:center;justify-content:center;width:34px;height:34px;flex:none;border-radius:var(--radius-pill);font-size:11.5px;font-weight:700;color:var(--color-ink)}
.t-name{font-size:14.5px;font-weight:600;color:var(--color-ink)}
.t-cell{flex:2;min-width:0;font-size:14px;color:var(--color-ink-muted)}
.t-num{flex:1;font-size:14px;font-weight:600;color:var(--color-ink)}
.t-status{flex:1;display:flex;justify-content:flex-end}
${PILLS}
</style>
<div class="d-table">
  <div class="t-head-row">
    <h3 class="t-title">Active initiations</h3>
    <div class="t-actions"><span class="t-chip-on">All 56</span><span class="t-chip">Assignments</span><span class="t-chip">Households</span><span class="t-chip">Exceptions</span></div>
  </div>
  <div class="t-cols">
    <span class="t-col" style="flex:2">Employee</span><span class="t-col" style="flex:2">Destination</span>
    <span class="t-col" style="flex:2">Stage</span><span class="t-col" style="flex:1">Budget</span>
    <span class="t-col" style="flex:1;text-align:right">Status</span>
  </div>
  ${row('Marcus Keane', 'MK', 'sky', 'Zurich, CH', 'Housing search', '$84,200', 'In progress', 'p-live')}
  ${row('Adaeze Okafor', 'AO', 'rose', 'Dublin, IE', 'Lease break', '$31,450', 'On hold', 'p-hold')}
  ${row('Lena Petrova', 'LP', 'mint', 'Boston, US', 'School search', '$52,900', 'In progress', 'p-live')}
  ${row('Tomás Silva', 'TS', 'peach', 'Lisbon, PT', 'Temporary housing', '$18,300', 'Waiting', 'p-wait')}
  ${row('Yuki Tanaka', 'YT', 'iris', 'Singapore, SG', 'Visa & immigration', '$96,750', 'In progress', 'p-live')}
</div>`, body);

// ---------------------------------------------------------------------------

const lint = JSON.parse(await call('lint_design', {}));
console.log(`lint: ${JSON.stringify(lint.bySeverity)}`);
const shot = async (id, file) => {
  const r = await client.callTool({ name: 'get_screenshot', arguments: { id } });
  const img = r.content.find((c) => c.type === 'image');
  if (img) writeFileSync(file, Buffer.from(img.data, 'base64'));
};
await shot(guide.id, '/tmp/aires-guide.png');
await shot(dash.id, '/tmp/aires-dashboard.png');

await api(`/documents/${doc.id}/invites`, {
  method: 'POST', body: JSON.stringify({ email: OWNER, role: 'owner' }),
}).catch((e) => console.log('owner:', e.message.slice(0, 120)));

console.log(`${BASE}/d/${doc.id}`);
await client.close();
