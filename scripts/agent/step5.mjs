import { session, connect } from './connect.mjs';
const s = await session();
const { call, close } = await connect(s.url);

const board = JSON.parse(await call('create_artboard', {
  name: 'Landing — 1440', width: 1440, height: 5200, x: 1400, y: 0,
  styles: { 'background-color': 'var(--color-bg)', display: 'block', padding: '0' },
}));

/**
 * Written as one fragment with a <style> block: the @media rules become real
 * node variants, so the layout responds inside the artboard rather than being
 * three separate mock-ups that drift apart.
 */
await call('write_html', { targetId: board.id, mode: 'replace-children', html: `
<style>
  .page { font-family: var(--font-sans); color: var(--color-fg); background: var(--color-bg);
          display: flex; flex-direction: column; align-items: center; gap: 0; }
  .wrap { width: 100%; max-width: 1240px; padding-left: 40px; padding-right: 40px;
          display: flex; flex-direction: column; }

  .eyebrow { font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.12em;
             text-transform: uppercase; color: var(--color-fg-muted); }
  .muted { color: var(--color-fg-muted); }

  .btn { display: inline-flex; align-items: center; gap: 8px; padding: 13px 22px;
         border-radius: var(--radius-pill); font-size: 14px; font-weight: 500; line-height: 1.2;
         border: 1px solid transparent; }
  .btn-solid { background: var(--color-surface-ink); color: var(--color-on-ink); }
  .btn-ghost { background: var(--color-surface); color: var(--color-fg); border-color: var(--color-border-strong); }
  .tag { display: inline-flex; align-items: center; padding: 5px 11px; border-radius: var(--radius-pill);
         background: var(--color-surface-sunken); border: 1px solid var(--color-border);
         color: var(--color-fg-muted); font-size: 12px; line-height: 1.2; }
  .tag-good { background: var(--color-success-bg); border-color: transparent; color: var(--color-success); }

  /* --- Nav ------------------------------------------------------------- */
  .nav { width: 100%; display: flex; flex-direction: row; align-items: center;
         justify-content: space-between; gap: 24px; padding-top: 28px; padding-bottom: 28px; }
  .nav-links { display: flex; flex-direction: row; align-items: center; gap: 28px; }
  .nav-link { font-size: 14px; color: var(--color-fg-muted); }
  .brand { display: flex; flex-direction: row; align-items: center; gap: 10px;
           font-size: 16px; font-weight: 600; letter-spacing: -0.01em; }
  .brand-mark { width: 22px; height: 22px; border-radius: 7px; background: var(--color-surface-ink);
                display: flex; align-items: center; justify-content: center; }
  .brand-dot { width: 7px; height: 7px; border-radius: 999px; background: var(--color-attention); }

  /* --- Hero ------------------------------------------------------------ */
  .hero { padding-top: 88px; padding-bottom: 72px; gap: 32px; align-items: flex-start; }
  .hero h1 { margin: 0; font-size: 68px; line-height: 1.04; letter-spacing: -0.035em;
             font-weight: 600; max-width: 940px; }
  .hero p { margin: 0; font-size: 18px; line-height: 1.6; color: var(--color-fg-muted); max-width: 560px; }
  .hero-actions { display: flex; flex-direction: row; align-items: center; flex-wrap: wrap; gap: 12px; }
  .hero-meta { display: flex; flex-direction: row; flex-wrap: wrap; gap: 28px; padding-top: 16px; }
  .hero-meta span { font-size: 13px; color: var(--color-fg-muted); }

  /* --- The panel: the reference's own layout, at page scale ------------- */
  .panel { width: 100%; background: var(--color-surface); border-radius: var(--radius-xl);
           box-shadow: var(--shadow-panel); padding: 24px;
           display: flex; flex-direction: column; gap: 20px; }
  .panel-head { display: flex; flex-direction: row; align-items: flex-start;
                justify-content: space-between; gap: 32px; padding: 12px 12px 0; }
  .panel-head h2 { margin: 0; font-size: 26px; line-height: 1.25; letter-spacing: -0.02em;
                   font-weight: 600; max-width: 460px; }
  .seg { display: inline-flex; flex-direction: row; align-items: center; gap: 4px; padding: 4px;
         background: var(--color-surface-sunken); border: 1px solid var(--color-border);
         border-radius: var(--radius-pill); }
  .seg-item { display: inline-flex; align-items: center; gap: 7px; padding: 8px 16px;
              border-radius: var(--radius-pill); font-size: 13px; color: var(--color-fg-muted); }
  .seg-on { background: var(--color-surface); color: var(--color-fg); box-shadow: var(--shadow-chip); }
  .dot { width: 6px; height: 6px; border-radius: 999px; background: var(--color-attention); }

  .pair { display: flex; flex-direction: row; gap: 16px; }
  .pair > div { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column;
                justify-content: space-between; gap: 40px; padding: 32px; border-radius: var(--radius-lg); }
  .card-light { background: var(--color-surface); border: 1px solid var(--color-border); }
  .card-ink { background: var(--color-surface-ink); }
  .pair h3 { margin: 0; font-size: 22px; line-height: 1.3; letter-spacing: -0.015em; font-weight: 600; }
  .pair p { margin: 0; font-size: 15px; line-height: 1.65; }
  .card-foot { display: flex; flex-direction: row; align-items: center; justify-content: space-between; gap: 16px; }

  /* --- Sections -------------------------------------------------------- */
  .section { padding-top: 104px; padding-bottom: 0; gap: 40px; }
  .section-head { display: flex; flex-direction: row; align-items: flex-end;
                  justify-content: space-between; gap: 40px; }
  .section-head h2 { margin: 0; font-size: 38px; line-height: 1.15; letter-spacing: -0.025em;
                     font-weight: 600; max-width: 620px; }
  .section-head p { margin: 0; font-size: 15px; line-height: 1.65; color: var(--color-fg-muted); max-width: 320px; }

  .grid-3 { display: flex; flex-direction: row; flex-wrap: wrap; gap: 16px; }
  .svc { flex: 1 1 320px; min-width: 0; display: flex; flex-direction: column; gap: 20px;
         padding: 28px; background: var(--color-surface); border: 1px solid var(--color-border);
         border-radius: var(--radius-lg); }
  .svc h3 { margin: 0; font-size: 19px; line-height: 1.35; letter-spacing: -0.01em; font-weight: 600; }
  .svc p { margin: 0; font-size: 14px; line-height: 1.65; color: var(--color-fg-muted); }
  .svc-num { font-family: var(--font-mono); font-size: 11px; color: var(--color-fg-faint); }
  .tags { display: flex; flex-direction: row; flex-wrap: wrap; gap: 8px; }

  .stats { display: flex; flex-direction: row; flex-wrap: wrap; gap: 16px; }
  .stat { flex: 1 1 200px; min-width: 0; display: flex; flex-direction: column; gap: 6px;
          padding: 28px; background: var(--color-surface); border: 1px solid var(--color-border);
          border-radius: var(--radius-lg); }
  .stat strong { font-size: 40px; line-height: 1.1; letter-spacing: -0.03em; font-weight: 600; }
  .stat span { font-size: 13px; color: var(--color-fg-muted); line-height: 1.5; }

  .steps { display: flex; flex-direction: row; gap: 16px; }
  .step { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 14px;
          padding: 28px; border-radius: var(--radius-lg); background: var(--color-surface);
          border: 1px solid var(--color-border); }
  .step-n { display: inline-flex; align-items: center; justify-content: center;
            width: 28px; height: 28px; border-radius: 999px; background: var(--color-surface-sunken);
            border: 1px solid var(--color-border); font-family: var(--font-mono); font-size: 12px;
            color: var(--color-fg-muted); }
  .step h3 { margin: 0; font-size: 17px; line-height: 1.35; font-weight: 600; letter-spacing: -0.01em; }
  .step p { margin: 0; font-size: 14px; line-height: 1.65; color: var(--color-fg-muted); }

  .quote { display: flex; flex-direction: column; gap: 28px; padding: 56px;
           background: var(--color-surface); border: 1px solid var(--color-border);
           border-radius: var(--radius-xl); }
  .quote blockquote { margin: 0; font-size: 28px; line-height: 1.4; letter-spacing: -0.02em;
                      font-weight: 500; max-width: 820px; }
  .quote-by { display: flex; flex-direction: row; align-items: center; gap: 14px; }
  .avatar { width: 40px; height: 40px; border-radius: 999px; background: var(--color-surface-sunken);
            border: 1px solid var(--color-border); display: flex; align-items: center;
            justify-content: center; font-size: 13px; font-weight: 600; color: var(--color-fg-muted); }

  .cta { display: flex; flex-direction: row; align-items: center; justify-content: space-between;
         gap: 40px; padding: 64px; background: var(--color-surface-ink);
         border-radius: var(--radius-xl); }
  .cta h2 { margin: 0; font-size: 42px; line-height: 1.12; letter-spacing: -0.03em;
            font-weight: 600; color: var(--color-on-ink); max-width: 560px; }
  .cta p { margin: 0; font-size: 15px; line-height: 1.65; color: var(--color-on-ink-muted); max-width: 420px; }

  .footer { display: flex; flex-direction: row; align-items: flex-start; justify-content: space-between;
            gap: 40px; padding-top: 64px; padding-bottom: 64px; margin-top: 104px;
            border-top: 1px solid var(--color-border-strong); }
  .footer-col { display: flex; flex-direction: column; gap: 10px; }
  .footer a, .footer span { font-size: 13px; color: var(--color-fg-muted); }

  /* --- Responsive ------------------------------------------------------ */
  @media (max-width: 1200px) {
    .hero h1 { font-size: 56px; }
    .section-head h2 { font-size: 32px; }
    .cta h2 { font-size: 34px; }
    .quote blockquote { font-size: 24px; }
  }
  @media (max-width: 900px) {
    .wrap { padding-left: 28px; padding-right: 28px; }
    .hero { padding-top: 56px; padding-bottom: 48px; }
    .hero h1 { font-size: 42px; }
    .hero p { font-size: 16px; }
    .nav-links { display: none; }
    .panel-head { flex-direction: column; gap: 20px; }
    .pair { flex-direction: column; }
    .steps { flex-direction: column; }
    .section { padding-top: 72px; }
    .section-head { flex-direction: column; align-items: flex-start; gap: 16px; }
    .cta { flex-direction: column; align-items: flex-start; gap: 28px; padding: 40px; }
    .quote { padding: 36px; }
    .footer { flex-direction: column; gap: 32px; margin-top: 72px; }
  }
  @media (max-width: 640px) {
    .wrap { padding-left: 20px; padding-right: 20px; }
    .hero h1 { font-size: 34px; letter-spacing: -0.025em; }
    .hero-meta { flex-direction: column; gap: 10px; }
    .panel { padding: 12px; }
    .panel-head { padding: 8px 8px 0; }
    .panel-head h2 { font-size: 21px; }
    .pair > div { padding: 24px; gap: 28px; }
    .section-head h2 { font-size: 27px; }
    .svc { flex: 1 1 100%; }
    .stat { flex: 1 1 100%; }
    .cta h2 { font-size: 28px; }
    .cta { padding: 28px; }
    .quote blockquote { font-size: 20px; }
    .quote { padding: 28px; }
  }
</style>

<div class="page">
  <div class="wrap nav">
    <div class="brand"><span class="brand-mark"><span class="brand-dot"></span></span>Northsignal</div>
    <div class="nav-links">
      <a class="nav-link" href="#work">Work</a>
      <a class="nav-link" href="#services">Services</a>
      <a class="nav-link" href="#process">Process</a>
      <a class="nav-link" href="#about">About</a>
    </div>
    <a class="btn btn-solid" href="#book">Book a review</a>
  </div>

  <div class="wrap hero">
    <span class="eyebrow">AI web consulting</span>
    <h1><span style="color:var(--color-fg-faint)">Most AI projects stall at the demo</span> — ours ship to production</h1>
    <p>We audit what you have, build the part that actually works, and stay on until it survives real traffic. Fixed scope. Six weeks. No pilots that go nowhere.</p>
    <div class="hero-actions">
      <a class="btn btn-solid" href="#book">Book a review</a>
      <a class="btn btn-ghost" href="#work">See the work →</a>
    </div>
    <div class="hero-meta">
      <span><span style="color:var(--color-fg)">(38)</span> systems shipped</span>
      <span><span style="color:var(--color-fg)">(11)</span> audits this quarter</span>
      <span><span style="color:var(--color-fg)">92%</span> still in production after a year</span>
    </div>
  </div>
</div>
`});

console.log(JSON.stringify({ board: board.id }));
await close();
