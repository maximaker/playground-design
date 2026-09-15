import { session, connect } from './connect.mjs';
const s = await session();
const { call, close } = await connect(s.url);

/**
 * The reference's greyed headline half sits around 1.7:1 — fine in a mockup,
 * not something to ship as a heading people have to read. Both greys move just
 * far enough to clear WCAG AA for the sizes they are actually used at, and the
 * two-tone effect survives: #858585 against #171717 still reads as two voices.
 */
await call('set_tokens', { tokens: [
  { name: 'color.fg-muted', group: 'color', values: { default: '#666666', dark: '#A0A0A0' } },
  { name: 'color.fg-faint', group: 'color', values: { default: '#858585', dark: '#6E6E6E' } },
]});
console.log('palette tightened');
await close();
