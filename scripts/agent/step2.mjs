import { session, connect } from './connect.mjs';
const s = await session();
const { call, close } = await connect(s.url);

const info = JSON.parse(await call('get_basic_info'));
const blank = info.artboards[0];

await call('rename_nodes', { updates: [{ id: blank.id, name: 'Foundations' }] });
await call('update_styles', { updates: [{ id: blank.id, styles: {
  width: '1240px', height: '2040px', 'background-color': 'var(--color-bg)',
  display: 'block', padding: '0',
} }] });

const swatch = (name, token, hex, note, onDark) => `
  <div class="swatch">
    <div class="chip" style="background:var(${token});${onDark ? 'border-color:transparent' : ''}"></div>
    <div class="swatch-meta">
      <strong>${name}</strong>
      <span class="mono">${hex}</span>
      <span class="note">${note}</span>
    </div>
  </div>`;

await call('write_html', { targetId: blank.id, mode: 'replace-children', html: `
<style>
  .sheet { font-family: var(--font-sans); color: var(--color-fg); }
  .section { display: flex; flex-direction: column; gap: var(--space-5); }
  .rule { height: 1px; background: var(--color-border-strong); }
  .eyebrow { font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.12em;
             text-transform: uppercase; color: var(--color-fg-muted); }
  .swatch-grid { display: flex; flex-direction: row; flex-wrap: wrap; gap: var(--space-4); }
  .swatch { display: flex; flex-direction: row; align-items: center; gap: var(--space-3);
            width: 268px; padding: var(--space-3); background: var(--color-surface);
            border: 1px solid var(--color-border); border-radius: var(--radius-md); }
  .chip { width: 40px; height: 40px; border-radius: var(--radius-sm);
          border: 1px solid var(--color-border-strong); }
  .swatch-meta { display: flex; flex-direction: column; gap: 2px; }
  .swatch-meta strong { font-size: 13px; font-weight: 600; }
  .mono { font-family: var(--font-mono); font-size: 11px; color: var(--color-fg-muted); }
  .note { font-size: 11px; color: var(--color-fg-faint); }
  .card { background: var(--color-surface); border: 1px solid var(--color-border);
          border-radius: var(--radius-lg); padding: var(--space-6); box-shadow: var(--shadow-card); }
</style>

<div class="sheet" style="display:flex;flex-direction:column;gap:64px;padding:80px 72px;background:var(--color-bg)">

  <div style="display:flex;flex-direction:row;align-items:flex-end;justify-content:space-between;gap:32px">
    <div style="display:flex;flex-direction:column;gap:12px;max-width:620px">
      <span class="eyebrow">Design system v1.0</span>
      <h1 style="margin:0;font-size:40px;line-height:1.15;letter-spacing:-0.02em;font-weight:600">
        <span style="color:var(--color-fg-faint)">A quiet system that</span> gets loud on purpose
      </h1>
      <p style="margin:0;font-size:15px;line-height:1.65;color:var(--color-fg-muted)">
        Near-neutral surfaces, hairline borders, and one near-black panel reserved for the thing that
        matters most on a screen. Two accent hues only: green means verified, amber means live.
      </p>
    </div>
    <div style="display:flex;flex-direction:column;gap:6px;text-align:right">
      <span class="mono">Northsignal</span>
      <span class="note">AI web consulting</span>
    </div>
  </div>

  <div class="rule"></div>

  <div class="section">
    <span class="eyebrow">01 — Colour</span>
    <div class="swatch-grid">
      ${swatch('bg', '--color-bg', '#EBEBEB', 'The page itself')}
      ${swatch('surface', '--color-surface', '#FFFFFF', 'Panels and cards')}
      ${swatch('surface-sunken', '--color-surface-sunken', '#F7F7F7', 'Inset tracks, tags')}
      ${swatch('surface-ink', '--color-surface-ink', '#1C1C1C', 'Emphasis — use once')}
      ${swatch('surface-ink-2', '--color-surface-ink-2', '#2B2B2B', 'Raised, on ink')}
      ${swatch('border', '--color-border', '#ECECEC', 'Hairline, default')}
      ${swatch('border-strong', '--color-border-strong', '#DCDCDC', 'Dividers')}
      ${swatch('fg', '--color-fg', '#171717', 'Body and headings')}
      ${swatch('fg-muted', '--color-fg-muted', '#7C7C7C', 'Supporting copy')}
      ${swatch('fg-faint', '--color-fg-faint', '#B4B4B4', 'The quiet half of a headline')}
      ${swatch('success', '--color-success', '#3D7A38', 'Verified, shipped')}
      ${swatch('attention', '--color-attention', '#E09B33', 'Live, in progress')}
    </div>
  </div>

  <div class="rule"></div>

  <div class="section">
    <span class="eyebrow">02 — Type</span>
    <div class="card" style="display:flex;flex-direction:column;gap:28px">
      <div style="display:flex;flex-direction:row;align-items:baseline;gap:24px">
        <span class="mono" style="width:150px;flex:0 0 auto">display / 64 / 600</span>
        <span style="font-size:64px;line-height:1.05;letter-spacing:-0.03em;font-weight:600">Ships to production</span>
      </div>
      <div style="display:flex;flex-direction:row;align-items:baseline;gap:24px">
        <span class="mono" style="width:150px;flex:0 0 auto">h2 / 34 / 600</span>
        <span style="font-size:34px;line-height:1.2;letter-spacing:-0.02em;font-weight:600">Section heading</span>
      </div>
      <div style="display:flex;flex-direction:row;align-items:baseline;gap:24px">
        <span class="mono" style="width:150px;flex:0 0 auto">h3 / 19 / 600</span>
        <span style="font-size:19px;line-height:1.35;letter-spacing:-0.01em;font-weight:600">Card title, two lines at most</span>
      </div>
      <div style="display:flex;flex-direction:row;align-items:baseline;gap:24px">
        <span class="mono" style="width:150px;flex:0 0 auto">body / 15 / 1.65</span>
        <span style="font-size:15px;line-height:1.65;color:var(--color-fg-muted);max-width:520px">Supporting copy sits at fifteen pixels with generous leading. Measure is capped near sixty characters so a paragraph never runs the width of a card.</span>
      </div>
      <div style="display:flex;flex-direction:row;align-items:baseline;gap:24px">
        <span class="mono" style="width:150px;flex:0 0 auto">small / 13</span>
        <span style="font-size:13px;line-height:1.6;color:var(--color-fg-muted)">Captions, tags and footnotes</span>
      </div>
      <div style="display:flex;flex-direction:row;align-items:baseline;gap:24px">
        <span class="mono" style="width:150px;flex:0 0 auto">mono / 11 / .12em</span>
        <span class="mono" style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase">Eyebrows and counters</span>
      </div>
    </div>
  </div>

</div>
`});

console.log('foundations part 1 written');
await close();
