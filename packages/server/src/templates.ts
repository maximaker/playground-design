/**
 * Starter design systems.
 *
 * A blank canvas is a bad starting point: most design work begins by adapting
 * something, and an agent asked to "build a pricing page" produces far better
 * output when the document already has tokens to reference. Each kit is a token
 * set plus a foundations artboard showing what those tokens look like applied.
 */

import { type Token, type StyleMap } from '@canvas/shared';

export interface Template {
  id: string;
  name: string;
  description: string;
  tokens: Token[];
  /** Artboards to create, in order. */
  artboards: { name: string; width: number; height: number; styles?: StyleMap; html: string }[];
}

const foundationsSheet = (opts: {
  heading: string;
  bodyFont: string;
  headingFont: string;
  radius: string;
  buttonRadius: string;
  shadow: string;
  borderWidth: string;
  letterSpacing?: string;
  uppercaseLabels?: boolean;
}) => `
<style>
  .sheet { display:flex; flex-direction:column; gap:40px; padding:56px;
           background:var(--color-bg); color:var(--color-fg);
           font-family:${opts.bodyFont}; width:100%; }
  .row { display:flex; flex-direction:row; gap:16px; align-items:center; flex-wrap:wrap; }
  .col { display:flex; flex-direction:column; gap:12px; }
  .label { font-size:11px; letter-spacing:.14em; color:var(--color-muted);
           ${opts.uppercaseLabels ? 'text-transform:uppercase;' : ''} }
  .h1 { font-family:${opts.headingFont}; font-size:56px; font-weight:700; line-height:1.08;
        margin:0; letter-spacing:${opts.letterSpacing ?? '-0.02em'}; }
  .h2 { font-family:${opts.headingFont}; font-size:32px; font-weight:600; line-height:1.2; margin:0; }
  .body { font-size:16px; line-height:1.65; color:var(--color-muted); margin:0; max-width:56ch; }
  .swatches { display:flex; flex-direction:row; gap:12px; }
  .swatch { display:flex; flex-direction:column; gap:6px; width:96px; }
  .chip { height:64px; border-radius:${opts.radius}; border:${opts.borderWidth} solid var(--color-border); }
  .chip-name { font-size:11px; color:var(--color-muted); }
  .btn { display:flex; align-items:center; justify-content:center;
         padding:12px 22px; border-radius:${opts.buttonRadius}; font-size:15px; font-weight:600;
         background:var(--color-brand); color:var(--color-on-brand); width:fit-content;
         transition:transform 140ms ease, filter 140ms ease; }
  .btn:hover { transform:translateY(-1px); filter:brightness(1.06); }
  .btn-ghost { background:transparent; color:var(--color-fg);
               border:${opts.borderWidth} solid var(--color-border); }
  .input { padding:12px 14px; border-radius:${opts.radius};
           border:${opts.borderWidth} solid var(--color-border);
           background:var(--color-surface); color:var(--color-fg); font-size:15px; width:280px; }
  .card { display:flex; flex-direction:column; gap:10px; padding:24px; width:280px;
          background:var(--color-surface); border:${opts.borderWidth} solid var(--color-border);
          border-radius:${opts.radius}; box-shadow:${opts.shadow}; }
  .card-title { font-family:${opts.headingFont}; font-size:18px; font-weight:600; margin:0; }
  .card-body { font-size:14px; line-height:1.6; color:var(--color-muted); margin:0; }
</style>
<div class="sheet">
  <div class="col">
    <span class="label">Typography</span>
    <h1 class="h1">${opts.heading}</h1>
    <h2 class="h2">A second level, for section headings</h2>
    <p class="body">Body copy sets the reading rhythm of everything else. This paragraph is here so line height, measure and colour can be judged against real sentences rather than placeholder blocks.</p>
  </div>

  <div class="col">
    <span class="label">Colour</span>
    <div class="swatches">
      <div class="swatch"><div class="chip" style="background:var(--color-brand)"></div><span class="chip-name">brand</span></div>
      <div class="swatch"><div class="chip" style="background:var(--color-fg)"></div><span class="chip-name">fg</span></div>
      <div class="swatch"><div class="chip" style="background:var(--color-muted)"></div><span class="chip-name">muted</span></div>
      <div class="swatch"><div class="chip" style="background:var(--color-surface)"></div><span class="chip-name">surface</span></div>
      <div class="swatch"><div class="chip" style="background:var(--color-bg)"></div><span class="chip-name">bg</span></div>
    </div>
  </div>

  <div class="col">
    <span class="label">Controls</span>
    <div class="row">
      <div class="btn">Primary action</div>
      <div class="btn btn-ghost">Secondary</div>
      <div class="input">Input field</div>
    </div>
  </div>

  <div class="col">
    <span class="label">Surface</span>
    <div class="row">
      <div class="card">
        <h3 class="card-title">Card</h3>
        <p class="card-body">The container everything else sits in. Padding, radius, border and shadow all come from tokens.</p>
      </div>
      <div class="card">
        <h3 class="card-title">Second card</h3>
        <p class="card-body">Two of them, so spacing between repeated elements can be judged.</p>
      </div>
    </div>
  </div>
</div>`;

function tokens(values: Record<string, [string, string]>, extra: Token[] = []): Token[] {
  return [
    ...Object.entries(values).map(([name, [light, dark]]): Token => ({
      name, group: 'color', values: { default: light, dark },
    })),
    ...extra,
  ];
}

const RADII = (sm: string, md: string, lg: string): Token[] => [
  { name: 'radius.sm', group: 'radius', values: { default: sm } },
  { name: 'radius.md', group: 'radius', values: { default: md } },
  { name: 'radius.lg', group: 'radius', values: { default: lg } },
];

const SPACE: Token[] = [
  { name: 'space.xs', group: 'space', values: { default: '4px' } },
  { name: 'space.sm', group: 'space', values: { default: '8px' } },
  { name: 'space.md', group: 'space', values: { default: '16px' } },
  { name: 'space.lg', group: 'space', values: { default: '32px' } },
  { name: 'space.xl', group: 'space', values: { default: '64px' } },
];

export const TEMPLATES: Template[] = [
  {
    id: 'clean',
    name: 'Clean',
    description: 'Neutral product UI. Restrained colour, generous spacing, soft shadows — the safe default.',
    tokens: [
      ...tokens({
        'color.bg': ['#ffffff', '#0b0b0f'],
        'color.surface': ['#ffffff', '#141419'],
        'color.fg': ['#0f172a', '#f1f5f9'],
        'color.muted': ['#64748b', '#94a3b8'],
        'color.border': ['#e2e8f0', '#27272a'],
        'color.brand': ['#4f46e5', '#818cf8'],
        'color.on-brand': ['#ffffff', '#0b0b0f'],
      }),
      ...RADII('6px', '10px', '16px'),
      ...SPACE,
    ],
    artboards: [{
      name: 'Foundations', width: 1200, height: 860,
      html: foundationsSheet({
        heading: 'Clean, quiet, gets out of the way',
        bodyFont: 'Inter, system-ui, sans-serif',
        headingFont: 'Inter, system-ui, sans-serif',
        radius: 'var(--radius-md)', buttonRadius: 'var(--radius-sm)',
        shadow: '0 1px 2px rgba(15,23,42,.06), 0 8px 24px rgba(15,23,42,.06)',
        borderWidth: '1px', uppercaseLabels: true,
      }),
    }],
  },
  {
    id: 'editorial',
    name: 'Editorial',
    description: 'Serif headlines, warm paper, long-form measure. For content-led work.',
    tokens: [
      ...tokens({
        'color.bg': ['#faf8f5', '#14110d'],
        'color.surface': ['#ffffff', '#1c1813'],
        'color.fg': ['#1c1917', '#f5f0e8'],
        'color.muted': ['#78716c', '#a8a29e'],
        'color.border': ['#e7e2da', '#332c24'],
        'color.brand': ['#9a3412', '#fb923c'],
        'color.on-brand': ['#ffffff', '#14110d'],
      }),
      ...RADII('2px', '4px', '8px'),
      ...SPACE,
    ],
    artboards: [{
      name: 'Foundations', width: 1200, height: 860,
      html: foundationsSheet({
        heading: 'Type first, everything else second',
        bodyFont: 'Georgia, "Times New Roman", serif',
        headingFont: '"Playfair Display", Georgia, serif',
        radius: 'var(--radius-sm)', buttonRadius: 'var(--radius-sm)',
        shadow: 'none', borderWidth: '1px', letterSpacing: '-0.01em',
      }),
    }],
  },
  {
    id: 'brutal',
    name: 'Brutalist',
    description: 'Hard edges, thick borders, no shadows, loud accent. High contrast and unapologetic.',
    tokens: [
      ...tokens({
        'color.bg': ['#fefce8', '#000000'],
        'color.surface': ['#ffffff', '#111111'],
        'color.fg': ['#000000', '#fefce8'],
        'color.muted': ['#3f3f46', '#a1a1aa'],
        'color.border': ['#000000', '#fefce8'],
        'color.brand': ['#dc2626', '#f87171'],
        'color.on-brand': ['#ffffff', '#000000'],
      }),
      ...RADII('0px', '0px', '0px'),
      ...SPACE,
    ],
    artboards: [{
      name: 'Foundations', width: 1200, height: 860,
      html: foundationsSheet({
        heading: 'NO ROUNDED CORNERS. NO APOLOGIES.',
        bodyFont: '"Helvetica Neue", Arial, sans-serif',
        headingFont: '"Helvetica Neue", Arial, sans-serif',
        radius: '0px', buttonRadius: '0px',
        shadow: '6px 6px 0 var(--color-fg)', borderWidth: '3px',
        letterSpacing: '-0.03em', uppercaseLabels: true,
      }),
    }],
  },
  {
    id: 'soft',
    name: 'Soft',
    description: 'Rounded, pastel, airy. Consumer-facing and friendly.',
    tokens: [
      ...tokens({
        'color.bg': ['#fdf4ff', '#170c1b'],
        'color.surface': ['#ffffff', '#221129'],
        'color.fg': ['#3b0764', '#f3e8ff'],
        'color.muted': ['#7e5a95', '#c4a8d4'],
        'color.border': ['#f0ddf7', '#3b1f47'],
        'color.brand': ['#a855f7', '#d8b4fe'],
        'color.on-brand': ['#ffffff', '#170c1b'],
      }),
      ...RADII('12px', '20px', '32px'),
      ...SPACE,
    ],
    artboards: [{
      name: 'Foundations', width: 1200, height: 860,
      html: foundationsSheet({
        heading: 'Soft edges, light touch',
        bodyFont: 'Inter, system-ui, sans-serif',
        headingFont: 'Inter, system-ui, sans-serif',
        radius: 'var(--radius-md)', buttonRadius: 'var(--radius-lg)',
        shadow: '0 10px 30px rgba(168,85,247,.18)',
        borderWidth: '1px',
      }),
    }],
  },
];

export function getTemplate(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

export function templateSummaries(): { id: string; name: string; description: string; tokenCount: number }[] {
  return TEMPLATES.map((t) => ({
    id: t.id, name: t.name, description: t.description, tokenCount: t.tokens.length,
  }));
}
