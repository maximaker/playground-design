import { session, connect } from './connect.mjs';
const s = await session();
const { call, close } = await connect(s.url);
const info = JSON.parse(await call('get_basic_info'));
const board = info.artboards.find((a) => a.name === 'Landing — 1440');
const page = JSON.parse(await call('get_children', { id: board.id }))[0].id;

await call('write_html', { targetId: page, mode: 'insert-children', html: `
<div class="wrap" style="padding-top:24px">
  <div class="panel">
    <div class="panel-head">
      <h2><span style="color:var(--color-fg-faint)">Smarter systems spot problems</span> — and solve them</h2>
      <div class="seg">
        <span class="seg-item seg-on"><span class="dot"></span>Audit</span>
        <span class="seg-item">Build</span>
        <span class="seg-item">Operate</span>
      </div>
    </div>

    <div class="pair">
      <div class="card-light">
        <div style="display:flex;flex-direction:column;gap:16px">
          <h3>Retrieval (v2.8.5) returns stale documents</h3>
          <p class="muted">Embeddings drifted three releases ago and nothing caught it. Support answers cite policies that were withdrawn in March, and the model sounds confident doing it.</p>
          <div class="tags">
            <span class="tag">v2.8.5</span>
            <span class="tag tag-good">Audited</span>
            <span class="tag">retrieval</span>
            <span class="tag">no evals</span>
          </div>
        </div>
        <div class="card-foot">
          <span style="font-size:13px;color:var(--color-fg-muted)"><span style="color:var(--color-fg)">(27)</span> findings</span>
          <a href="#work" style="font-size:13px;color:var(--color-fg);text-decoration:underline">Read the audit</a>
        </div>
      </div>

      <div class="card-ink">
        <div style="display:flex;flex-direction:column;gap:16px">
          <h3 style="color:var(--color-on-ink)">A system that notices before your customers do</h3>
          <p style="color:var(--color-on-ink-muted)">Golden-set evals in CI, drift alerts on every index rebuild, and a retrieval layer that shows its sources. Nothing ships without a test that would have caught this.</p>
        </div>
        <div style="display:flex;flex-direction:column;gap:20px">
          <span style="font-size:13px;color:var(--color-on-ink-muted)">v2.8.6 — verified against 1,400 graded answers</span>
          <div style="display:flex;flex-direction:row;flex-wrap:wrap;gap:10px;align-items:center">
            <span class="btn" style="background:var(--color-surface-ink-2);color:var(--color-on-ink);border-color:var(--color-border-ink)">
              <span style="width:8px;height:8px;border-radius:999px;background:var(--color-success);display:inline-block"></span>In production
            </span>
            <a class="btn btn-ghost" href="#book">Start an audit →</a>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>

<div class="wrap section" id="services">
  <div class="section-head">
    <h2>Three ways in, depending on how far along you are</h2>
    <p>Every engagement starts with an audit. If there is nothing to audit yet, it starts with a week of scoping instead.</p>
  </div>
  <div class="grid-3">
    <div class="svc">
      <span class="svc-num">01</span>
      <h3>Audit</h3>
      <p>Two weeks inside your stack. We grade retrieval, prompts, latency, cost and failure modes against a set we build from your real traffic — then hand you the findings whether or not you hire us for the rest.</p>
      <div class="tags"><span class="tag">2 weeks</span><span class="tag">fixed fee</span><span class="tag tag-good">no lock-in</span></div>
    </div>
    <div class="svc">
      <span class="svc-num">02</span>
      <h3>Build</h3>
      <p>Six weeks to a system in front of real users. Evals in CI from day one, sources on every answer, and a rollback that works. We write the code your team will own, in the stack your team already uses.</p>
      <div class="tags"><span class="tag">6 weeks</span><span class="tag">your repo</span><span class="tag">evals in CI</span></div>
    </div>
    <div class="svc">
      <span class="svc-num">03</span>
      <h3>Operate</h3>
      <p>The unglamorous part. Drift alerts, cost ceilings, a weekly read on what the model got wrong and why. Month to month, cancel whenever — we would rather you graduate off it.</p>
      <div class="tags"><span class="tag">monthly</span><span class="tag">on call</span><span class="tag">cancel anytime</span></div>
    </div>
  </div>
</div>

<div class="wrap section" id="process">
  <div class="section-head">
    <h2><span style="color:var(--color-fg-faint)">No discovery phase.</span> We are in the code in week one</h2>
    <p>The whole engagement is four moves. You can stop after any of them.</p>
  </div>
  <div class="steps">
    <div class="step"><span class="step-n">1</span><h3>Read the traffic</h3><p>Real queries, real failures. We build the graded set from what your users actually ask, not from what the demo covered.</p></div>
    <div class="step"><span class="step-n">2</span><h3>Grade it</h3><p>A number for retrieval, a number for answers, a number for cost. You get the baseline before anyone argues about a fix.</p></div>
    <div class="step"><span class="step-n">3</span><h3>Ship the fix</h3><p>Smallest change that moves the number. In your repo, behind your review, with the test that proves it.</p></div>
    <div class="step"><span class="step-n">4</span><h3>Hand it over</h3><p>Runbook, alerts, and a team that can do the next one without us. That is the point.</p></div>
  </div>
</div>

<div class="wrap section">
  <div class="stats">
    <div class="stat"><strong>38</strong><span>systems shipped to production since 2021</span></div>
    <div class="stat"><strong>92%</strong><span>still running a year later, unchanged or improved</span></div>
    <div class="stat"><strong>6wks</strong><span>median time from first call to real traffic</span></div>
    <div class="stat"><strong>0</strong><span>engagements that ended at a pilot</span></div>
  </div>
</div>

<div class="wrap section">
  <div class="quote">
    <blockquote>“They spent the first week telling us which half of our AI roadmap to delete. That conversation was worth more than the build — and then they did the build.”</blockquote>
    <div class="quote-by">
      <span class="avatar">HR</span>
      <div style="display:flex;flex-direction:column;gap:2px">
        <span style="font-size:14px;font-weight:600">Hana Reyes</span>
        <span style="font-size:13px;color:var(--color-fg-muted)">VP Engineering, Cadence Health</span>
      </div>
    </div>
  </div>
</div>

<div class="wrap section" id="book">
  <div class="cta">
    <div style="display:flex;flex-direction:column;gap:16px">
      <h2>Start with the audit. Keep the findings either way.</h2>
      <p>Two weeks, fixed fee, and a written grade on what you have. If the answer is “do not build this”, we will say so.</p>
    </div>
    <div style="display:flex;flex-direction:column;gap:12px;flex:0 0 auto">
      <a class="btn btn-ghost" href="#book" style="justify-content:center">Book a review →</a>
      <span style="font-size:13px;color:var(--color-on-ink-muted);text-align:center">Replies within a working day</span>
    </div>
  </div>
</div>

<div class="wrap">
  <div class="footer">
    <div class="footer-col" style="gap:14px">
      <div class="brand"><span class="brand-mark"><span class="brand-dot"></span></span>Northsignal</div>
      <span style="max-width:280px;line-height:1.6">AI web consulting. Audits, builds and the boring part afterwards.</span>
    </div>
    <div class="footer-col"><span style="color:var(--color-fg)">Services</span><a href="#services">Audit</a><a href="#services">Build</a><a href="#services">Operate</a></div>
    <div class="footer-col"><span style="color:var(--color-fg)">Company</span><a href="#about">About</a><a href="#work">Work</a><a href="#book">Contact</a></div>
    <div class="footer-col"><span style="color:var(--color-fg)">Elsewhere</span><a href="#">hello@northsignal.co</a><a href="#">LinkedIn</a><a href="#">GitHub</a></div>
  </div>
</div>
`});

console.log('landing written');
await close();
