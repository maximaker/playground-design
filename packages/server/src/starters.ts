/**
 * Page starters: finished pages to edit, not frames to fill.
 *
 * The kits in templates.ts answer "what should it look like"; these answer
 * "what am I making". Someone who is not a designer does not start from a
 * foundations sheet or an empty artboard — they start from a page that already
 * works and change the words. Every starter is written against the kit tokens
 * (`--color-*`, `--radius-*`), so any starter takes on any kit's look.
 */

import { cssVarName } from '@playground/shared';
import { getTemplate, type Template } from './templates.ts';

export interface Starter {
  id: string;
  name: string;
  description: string;
  /** Artboard height at 1440 wide; the page grows past it when published. */
  height: number;
  html: (f: Fonts) => string;
}

interface Fonts { heading: string; body: string }

/** The typefaces each kit's foundations sheet is set in. */
const KIT_FONTS: Record<string, Fonts> = {
  clean: { heading: 'Inter, system-ui, sans-serif', body: 'Inter, system-ui, sans-serif' },
  editorial: { heading: '"Playfair Display", Georgia, serif', body: 'Georgia, "Times New Roman", serif' },
  brutal: { heading: '"Helvetica Neue", Arial, sans-serif', body: '"Helvetica Neue", Arial, sans-serif' },
  soft: { heading: 'Inter, system-ui, sans-serif', body: 'Inter, system-ui, sans-serif' },
};

export const DEFAULT_STYLE = 'clean';

const base = (f: Fonts) => `
  .page { display:flex; flex-direction:column; width:100%; flex:1 1 auto; min-height:100%; background:var(--color-bg);
        color:var(--color-fg); font-family:${f.body}; }
  .wrap { display:flex; flex-direction:column; gap:24px; padding:96px 120px; }
  .nav { display:flex; flex-direction:row; justify-content:space-between; align-items:center; padding:28px 120px; }
  .brand { font-family:${f.heading}; font-weight:700; font-size:20px; }
  .links { display:flex; flex-direction:row; gap:32px; font-size:15px; color:var(--color-muted); }
  .eyebrow { font-size:13px; letter-spacing:.14em; text-transform:uppercase; color:var(--color-brand); font-weight:600; }
  .h1 { font-family:${f.heading}; font-size:72px; line-height:1.04; letter-spacing:-0.02em; font-weight:700; margin:0; max-width:14ch; }
  .h2 { font-family:${f.heading}; font-size:40px; line-height:1.15; font-weight:700; margin:0; }
  .h3 { font-family:${f.heading}; font-size:20px; font-weight:600; margin:0; }
  .lead { font-size:20px; line-height:1.6; color:var(--color-muted); margin:0; max-width:52ch; }
  .text { font-size:16px; line-height:1.65; color:var(--color-muted); margin:0; }
  .row { display:flex; flex-direction:row; gap:16px; align-items:center; flex-wrap:wrap; }
  .grid { display:flex; flex-direction:row; gap:24px; flex-wrap:wrap; }
  .card { display:flex; flex-direction:column; gap:12px; padding:32px; flex:1 1 280px;
          background:var(--color-surface); border:1px solid var(--color-border); border-radius:var(--radius-md); }
  .btn { display:flex; align-items:center; justify-content:center; padding:14px 26px; width:fit-content;
         border-radius:var(--radius-sm); background:var(--color-brand); color:var(--color-on-brand);
         font-size:16px; font-weight:600; text-decoration:none; }
  .btn-ghost { background:transparent; color:var(--color-fg); border:1px solid var(--color-border); }
  .img { background:var(--color-border); border-radius:var(--radius-lg); }
  .foot { display:flex; flex-direction:row; justify-content:space-between; padding:40px 120px;
          border-top:1px solid var(--color-border); font-size:14px; color:var(--color-muted); }
  @media (max-width: 760px) {
    .wrap { padding:56px 24px; } .nav, .foot { padding:20px 24px; }
    .links { display:none; } .h1 { font-size:44px; } .h2 { font-size:30px; } .lead { font-size:18px; }
    .foot { flex-direction:column; gap:8px; }
  }`;

export const STARTERS: Starter[] = [
  {
    id: 'landing',
    name: 'Landing page',
    description: 'Introduce a product, service or idea, with a clear call to action.',
    height: 1610,
    html: (f) => `<style>${base(f)}
  .hero { display:flex; flex-direction:row; gap:64px; align-items:center; padding:64px 120px 96px; }
  .hero-text { display:flex; flex-direction:column; gap:24px; flex:1 1 0; }
  .hero .img { flex:1 1 0; height:440px; }
  .band { display:flex; flex-direction:column; align-items:center; gap:20px; padding:96px 120px;
          background:var(--color-surface); text-align:center; }
  @media (max-width: 760px) { .hero { flex-direction:column; padding:32px 24px 56px; } .hero .img { width:100%; height:240px; } .band { padding:56px 24px; } }
</style>
<div class="page">
  <nav class="nav"><span class="brand">Northwind</span><div class="links"><span>Features</span><span>Pricing</span><span>About</span></div></nav>
  <section class="hero">
    <div class="hero-text">
      <span class="eyebrow">New this spring</span>
      <h1 class="h1">Plan your week in five calm minutes</h1>
      <p class="lead">Northwind turns a messy list into a week you can actually do. No setup, no learning curve.</p>
      <div class="row"><a class="btn" href="#">Get started free</a><a class="btn btn-ghost" href="#">See how it works</a></div>
    </div>
    <div class="img"></div>
  </section>
  <section class="wrap">
    <span class="eyebrow">Why people stay</span>
    <h2 class="h2">Everything you need, nothing you don't</h2>
    <div class="grid">
      <div class="card"><h3 class="h3">One list, sorted</h3><p class="text">Drop everything in. Northwind suggests what fits today and what can wait.</p></div>
      <div class="card"><h3 class="h3">Gentle reminders</h3><p class="text">A nudge at the right moment, never a wall of notifications.</p></div>
      <div class="card"><h3 class="h3">Share with family</h3><p class="text">Groceries, pickups and plans — everyone sees the same week.</p></div>
    </div>
  </section>
  <section class="band">
    <h2 class="h2">Ready for a quieter week?</h2>
    <p class="lead">Free for personal use. Takes a minute to start.</p>
    <a class="btn" href="#">Get started free</a>
  </section>
  <footer class="foot"><span>© Northwind</span><span>hello@northwind.example</span></footer>
</div>`,
  },
  {
    id: 'portfolio',
    name: 'Portfolio',
    description: 'Show your work and who you are, with a way to get in touch.',
    height: 2410,
    html: (f) => `<style>${base(f)}
  .work { display:flex; flex-direction:row; gap:24px; flex-wrap:wrap; }
  .piece { display:flex; flex-direction:column; gap:12px; flex:1 1 520px; }
  .piece .img { height:360px; }
  .about { display:flex; flex-direction:row; gap:64px; align-items:center; }
  .about .img { width:320px; height:320px; flex:0 0 auto; border-radius:999px; }
  @media (max-width: 760px) { .about { flex-direction:column; align-items:flex-start; } .about .img { width:180px; height:180px; } .piece .img { height:220px; } }
</style>
<div class="page">
  <nav class="nav"><span class="brand">Ana Popescu</span><div class="links"><span>Work</span><span>About</span><span>Contact</span></div></nav>
  <section class="wrap">
    <span class="eyebrow">Illustrator &amp; designer</span>
    <h1 class="h1">I draw things that make people smile</h1>
    <p class="lead">Picture books, packaging and the occasional mural. Based in Iași, working everywhere.</p>
  </section>
  <section class="wrap">
    <h2 class="h2">Selected work</h2>
    <div class="work">
      <div class="piece"><div class="img"></div><h3 class="h3">The Little Lighthouse</h3><p class="text">A picture book for ages 3–6.</p></div>
      <div class="piece"><div class="img"></div><h3 class="h3">Morning Tea</h3><p class="text">Packaging for an independent tea shop.</p></div>
      <div class="piece"><div class="img"></div><h3 class="h3">City Garden Mural</h3><p class="text">Twelve metres of flowers on a school wall.</p></div>
      <div class="piece"><div class="img"></div><h3 class="h3">Postcards from Home</h3><p class="text">A personal series of twenty postcards.</p></div>
    </div>
  </section>
  <section class="wrap">
    <div class="about">
      <div class="img"></div>
      <div class="col" style="display:flex; flex-direction:column; gap:20px;">
        <h2 class="h2">Hello, I'm Ana</h2>
        <p class="lead">I've been drawing for as long as I can remember. I love projects with a story behind them.</p>
        <a class="btn" href="mailto:ana@example.com">Say hello</a>
      </div>
    </div>
  </section>
  <footer class="foot"><span>© Ana Popescu</span><span>ana@example.com</span></footer>
</div>`,
  },
  {
    id: 'event',
    name: 'Event',
    description: 'A date, a place, what happens — and a button to sign up.',
    height: 1480,
    html: (f) => `<style>${base(f)}
  .facts { display:flex; flex-direction:row; gap:24px; flex-wrap:wrap; }
  .fact { display:flex; flex-direction:column; gap:6px; flex:1 1 220px; padding:24px;
          border:1px solid var(--color-border); border-radius:var(--radius-md); background:var(--color-surface); }
  .fact strong { font-family:${f.heading}; font-size:22px; }
  .agenda { display:flex; flex-direction:column; }
  .slot { display:flex; flex-direction:row; gap:32px; padding:20px 0; border-bottom:1px solid var(--color-border); }
  .slot .time { width:96px; flex:0 0 auto; font-weight:600; color:var(--color-brand); }
</style>
<div class="page">
  <section class="wrap">
    <span class="eyebrow">Saturday · 14 March</span>
    <h1 class="h1">Spring Pottery Workshop</h1>
    <p class="lead">A relaxed afternoon at the wheel for complete beginners. Clay, tools and tea included — just bring yourself.</p>
    <div class="row"><a class="btn" href="#">Save my place</a><span class="text">12 places · 150 lei</span></div>
  </section>
  <section class="wrap">
    <div class="facts">
      <div class="fact"><span class="text">When</span><strong>14 March, 14:00</strong></div>
      <div class="fact"><span class="text">Where</span><strong>Atelier 9, Iași</strong></div>
      <div class="fact"><span class="text">Who</span><strong>Beginners welcome</strong></div>
    </div>
  </section>
  <section class="wrap">
    <h2 class="h2">The afternoon</h2>
    <div class="agenda">
      <div class="slot"><span class="time">14:00</span><span class="text">Welcome, tea and a short demo</span></div>
      <div class="slot"><span class="time">14:30</span><span class="text">Your first pieces on the wheel</span></div>
      <div class="slot"><span class="time">16:00</span><span class="text">Glazing and decorating</span></div>
      <div class="slot"><span class="time">17:00</span><span class="text">Wrap up — pieces ready to collect in a week</span></div>
    </div>
  </section>
  <footer class="foot"><span>Atelier 9</span><span>Questions? hello@atelier9.example</span></footer>
</div>`,
  },
  {
    id: 'links',
    name: 'Link in bio',
    description: 'One simple page with all your links, for social profiles.',
    height: 900,
    html: (f) => `<style>${base(f)}
  .bio { display:flex; flex-direction:column; align-items:center; gap:20px; padding:96px 24px; text-align:center; }
  .avatar { width:112px; height:112px; border-radius:999px; background:var(--color-border); }
  .stack { display:flex; flex-direction:column; gap:14px; width:100%; max-width:480px; }
  .link { display:flex; justify-content:center; padding:18px 24px; border-radius:var(--radius-md);
          background:var(--color-surface); border:1px solid var(--color-border); color:var(--color-fg);
          font-size:16px; font-weight:600; text-decoration:none; }
  .link-main { background:var(--color-brand); color:var(--color-on-brand); border-color:transparent; }
</style>
<div class="page">
  <section class="bio">
    <div class="avatar"></div>
    <h1 class="h2">Mara Ionescu</h1>
    <p class="text">Baker, writer, weekend hiker. New recipes every Friday.</p>
    <div class="stack">
      <a class="link link-main" href="#">This week's recipe</a>
      <a class="link" href="#">My cookbook</a>
      <a class="link" href="#">Instagram</a>
      <a class="link" href="#">Newsletter</a>
      <a class="link" href="mailto:mara@example.com">Email me</a>
    </div>
  </section>
</div>`,
  },
];

export function getStarter(id: string): Starter | undefined {
  return STARTERS.find((s) => s.id === id);
}

export function starterHtml(starter: Starter, styleId: string): string {
  return starter.html(KIT_FONTS[styleId] ?? KIT_FONTS[DEFAULT_STYLE]!);
}

/**
 * A self-contained preview of a starter in a kit, for the picker on the home
 * screen. Rendered from the same HTML the document will get, so the thumbnail
 * cannot drift from what opens.
 */
export function starterPreview(starter: Starter, kit: Template): string {
  const vars = kit.tokens.map((t) => `${cssVarName(t.name)}:${t.values.default};`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>:root{${vars}}body{margin:0}</style></head><body>${starterHtml(starter, kit.id)}</body></html>`;
}

export function starterSummaries(styleId = DEFAULT_STYLE) {
  const kit = getTemplate(styleId) ?? getTemplate(DEFAULT_STYLE)!;
  return STARTERS.map((s) => ({
    id: s.id, name: s.name, description: s.description, preview: starterPreview(s, kit),
  }));
}
