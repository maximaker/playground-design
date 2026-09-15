import { session, connect } from './connect.mjs';
const s = await session();
const { call, close } = await connect(s.url);
const info = JSON.parse(await call('get_basic_info'));
const board = info.artboards.find((a) => a.name === 'Foundations');
const sheet = JSON.parse(await call('get_children', { id: board.id }))[0].id;

await call('write_html', { targetId: sheet, mode: 'insert-children', html: `
<style>
  .rule2 { height: 1px; background: var(--color-border-strong); }
  .eyebrow2 { font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.12em;
              text-transform: uppercase; color: var(--color-fg-muted); }
  .spec { display: flex; flex-direction: column; gap: 10px; align-items: flex-start; }
  .spec-label { font-family: var(--font-mono); font-size: 11px; color: var(--color-fg-muted); }
  .box { width: 108px; height: 76px; background: var(--color-surface);
         border: 1px solid var(--color-border-strong); }

  /* Tags: neutral by default, tinted only to carry a status. */
  .tag { display: inline-flex; align-items: center; padding: 5px 11px;
         border-radius: var(--radius-pill); background: var(--color-surface-sunken);
         border: 1px solid var(--color-border); color: var(--color-fg-muted);
         font-size: 12px; line-height: 1.2; }
  .tag-good { background: var(--color-success-bg); border-color: transparent; color: var(--color-success); }

  /* One solid button, one outline, both fully rounded. Nothing else. */
  .btn { display: inline-flex; align-items: center; gap: 8px; padding: 11px 20px;
         border-radius: var(--radius-pill); font-size: 14px; font-weight: 500;
         line-height: 1.2; border: 1px solid transparent; }
  .btn-solid { background: var(--color-surface-ink); color: var(--color-on-ink); }
  .btn-ghost { background: var(--color-surface); color: var(--color-fg);
               border-color: var(--color-border-strong); }

  /* The segmented control from the reference: an inset track, a raised chip,
     and a dot that marks the live one without adding a second colour. */
  .seg { display: inline-flex; flex-direction: row; align-items: center; gap: 4px; padding: 4px;
         background: var(--color-surface-sunken); border: 1px solid var(--color-border);
         border-radius: var(--radius-pill); }
  .seg-item { display: inline-flex; align-items: center; gap: 7px; padding: 7px 15px;
              border-radius: var(--radius-pill); font-size: 13px; color: var(--color-fg-muted); }
  .seg-item.is-on { background: var(--color-surface); color: var(--color-fg);
                    box-shadow: var(--shadow-chip); }
  .dot { width: 6px; height: 6px; border-radius: var(--radius-pill); background: var(--color-attention); }
</style>

<div class="rule2"></div>

<div style="display:flex;flex-direction:column;gap:24px">
  <span class="eyebrow2">03 — Shape and depth</span>
  <div style="display:flex;flex-direction:row;flex-wrap:wrap;gap:32px;padding:32px;background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-lg)">
    <div class="spec"><div class="box" style="border-radius:var(--radius-sm)"></div><span class="spec-label">radius.sm · 10</span></div>
    <div class="spec"><div class="box" style="border-radius:var(--radius-md)"></div><span class="spec-label">radius.md · 16</span></div>
    <div class="spec"><div class="box" style="border-radius:var(--radius-lg)"></div><span class="spec-label">radius.lg · 24</span></div>
    <div class="spec"><div class="box" style="border-radius:var(--radius-xl)"></div><span class="spec-label">radius.xl · 32</span></div>
    <div class="spec"><div class="box" style="border-radius:var(--radius-pill);width:140px"></div><span class="spec-label">radius.pill</span></div>
    <div class="spec"><div class="box" style="border-color:transparent;border-radius:var(--radius-md);box-shadow:var(--shadow-chip)"></div><span class="spec-label">shadow.chip</span></div>
    <div class="spec"><div class="box" style="border-color:transparent;border-radius:var(--radius-md);box-shadow:var(--shadow-panel)"></div><span class="spec-label">shadow.panel</span></div>
  </div>
</div>

<div class="rule2"></div>

<div style="display:flex;flex-direction:column;gap:24px">
  <span class="eyebrow2">04 — Components</span>

  <div style="display:flex;flex-direction:row;flex-wrap:wrap;gap:16px">
    <div style="display:flex;flex-direction:column;gap:14px;flex:1 1 300px;padding:24px;background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-lg)">
      <span class="spec-label">Tags</span>
      <div style="display:flex;flex-direction:row;flex-wrap:wrap;gap:8px">
        <span class="tag">retrieval</span>
        <span class="tag tag-good">shipped</span>
        <span class="tag">evals</span>
        <span class="tag">6 weeks</span>
      </div>
    </div>

    <div style="display:flex;flex-direction:column;gap:14px;flex:1 1 300px;padding:24px;background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-lg)">
      <span class="spec-label">Buttons</span>
      <div style="display:flex;flex-direction:row;flex-wrap:wrap;gap:10px;align-items:center">
        <span class="btn btn-solid">Book a review</span>
        <span class="btn btn-ghost">See the work →</span>
      </div>
    </div>

    <div style="display:flex;flex-direction:column;gap:14px;flex:1 1 300px;padding:24px;background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-lg)">
      <span class="spec-label">Segmented control</span>
      <div class="seg">
        <span class="seg-item is-on"><span class="dot"></span>Audit</span>
        <span class="seg-item">Build</span>
        <span class="seg-item">Operate</span>
      </div>
    </div>
  </div>

  <div style="display:flex;flex-direction:row;gap:16px">
    <div style="display:flex;flex-direction:column;justify-content:space-between;gap:28px;flex:1 1 0;min-width:0;padding:28px;background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-lg)">
      <div style="display:flex;flex-direction:column;gap:12px">
        <h3 style="margin:0;font-size:19px;line-height:1.35;letter-spacing:-0.01em;font-weight:600">Light card — the state of things</h3>
        <p style="margin:0;font-size:14px;line-height:1.65;color:var(--color-fg-muted)">Carries the problem, the evidence and the tags. Hairline border, no shadow: it is the calm half of the pair.</p>
        <div style="display:flex;flex-direction:row;flex-wrap:wrap;gap:8px">
          <span class="tag">RAG</span><span class="tag tag-good">audited</span><span class="tag">latency</span>
        </div>
      </div>
      <div style="display:flex;flex-direction:row;align-items:center;justify-content:space-between;gap:16px">
        <span style="font-size:13px;color:var(--color-fg-muted)"><span style="color:var(--color-fg)">(27)</span> findings</span>
        <span style="font-size:13px;color:var(--color-fg);text-decoration:underline">Read more</span>
      </div>
    </div>

    <div style="display:flex;flex-direction:column;justify-content:space-between;gap:28px;flex:1 1 0;min-width:0;padding:28px;background:var(--color-surface-ink);border-radius:var(--radius-lg)">
      <div style="display:flex;flex-direction:column;gap:12px">
        <h3 style="margin:0;font-size:19px;line-height:1.35;letter-spacing:-0.01em;font-weight:600;color:var(--color-on-ink)">Ink card — what we do about it</h3>
        <p style="margin:0;font-size:14px;line-height:1.65;color:var(--color-on-ink-muted)">The emphatic half. One per screen, at most. It takes the resolution, the commitment, the price.</p>
      </div>
      <div style="display:flex;flex-direction:column;gap:18px">
        <span style="font-size:13px;color:var(--color-on-ink-muted)">Fixed scope, six weeks</span>
        <div style="display:flex;flex-direction:row;flex-wrap:wrap;gap:10px;align-items:center">
          <span class="btn" style="background:var(--color-surface-ink-2);color:var(--color-on-ink);border-color:var(--color-border-ink)">
            <span style="width:8px;height:8px;border-radius:999px;background:var(--color-success);display:inline-block"></span>In production
          </span>
          <span class="btn btn-ghost">Start an audit →</span>
        </div>
      </div>
    </div>
  </div>
</div>
`});

console.log('foundations complete');
await close();
