import { session, connect } from './connect.mjs';
const s = await session({ name: 'Northsignal — AI web consulting', template: '', fresh: true });
const { call, close } = await connect(s.url);

/**
 * Tokens read off the reference: a warm near-neutral palette, one near-black
 * surface used for emphasis, and exactly two accent hues — green for verified,
 * amber for live. Colour is not doing the work; type and surface are.
 */
await call('set_tokens', { tokens: [
  { name: 'color.bg',            group: 'color', values: { default: '#EBEBEB', dark: '#131313' } },
  { name: 'color.surface',       group: 'color', values: { default: '#FFFFFF', dark: '#1C1C1C' } },
  { name: 'color.surface-sunken',group: 'color', values: { default: '#F7F7F7', dark: '#232323' } },
  { name: 'color.surface-ink',   group: 'color', values: { default: '#1C1C1C', dark: '#F5F5F5' } },
  { name: 'color.surface-ink-2', group: 'color', values: { default: '#2B2B2B', dark: '#E4E4E4' } },
  { name: 'color.border',        group: 'color', values: { default: '#ECECEC', dark: '#2C2C2C' } },
  { name: 'color.border-strong', group: 'color', values: { default: '#DCDCDC', dark: '#3A3A3A' } },
  { name: 'color.border-ink',    group: 'color', values: { default: '#3A3A3A', dark: '#D0D0D0' } },
  { name: 'color.fg',            group: 'color', values: { default: '#171717', dark: '#F5F5F5' } },
  { name: 'color.fg-muted',      group: 'color', values: { default: '#7C7C7C', dark: '#A0A0A0' } },
  { name: 'color.fg-faint',      group: 'color', values: { default: '#B4B4B4', dark: '#6E6E6E' } },
  { name: 'color.on-ink',        group: 'color', values: { default: '#FFFFFF', dark: '#171717' } },
  { name: 'color.on-ink-muted',  group: 'color', values: { default: '#A6A6A6', dark: '#5A5A5A' } },
  { name: 'color.success',       group: 'color', values: { default: '#3D7A38', dark: '#7FBF78' } },
  { name: 'color.success-bg',    group: 'color', values: { default: '#E8F3E2', dark: '#22301F' } },
  { name: 'color.attention',     group: 'color', values: { default: '#E09B33', dark: '#F0B45C' } },

  { name: 'space.1',  group: 'space', values: { default: '4px' } },
  { name: 'space.2',  group: 'space', values: { default: '8px' } },
  { name: 'space.3',  group: 'space', values: { default: '12px' } },
  { name: 'space.4',  group: 'space', values: { default: '16px' } },
  { name: 'space.5',  group: 'space', values: { default: '24px' } },
  { name: 'space.6',  group: 'space', values: { default: '32px' } },
  { name: 'space.7',  group: 'space', values: { default: '48px' } },
  { name: 'space.8',  group: 'space', values: { default: '64px' } },
  { name: 'space.9',  group: 'space', values: { default: '96px' } },
  { name: 'space.10', group: 'space', values: { default: '128px' } },

  { name: 'radius.sm',   group: 'radius', values: { default: '10px' } },
  { name: 'radius.md',   group: 'radius', values: { default: '16px' } },
  { name: 'radius.lg',   group: 'radius', values: { default: '24px' } },
  { name: 'radius.xl',   group: 'radius', values: { default: '32px' } },
  { name: 'radius.pill', group: 'radius', values: { default: '999px' } },

  { name: 'shadow.chip',  group: 'shadow', values: { default: '0 1px 2px rgba(23,23,23,0.08)' } },
  { name: 'shadow.card',  group: 'shadow', values: { default: '0 1px 3px rgba(23,23,23,0.04)' } },
  { name: 'shadow.panel', group: 'shadow', values: { default: '0 24px 60px -20px rgba(23,23,23,0.18)' } },

  { name: 'font.sans', group: 'font', values: { default: "'Inter', system-ui, -apple-system, sans-serif" } },
  { name: 'font.mono', group: 'font', values: { default: "'IBM Plex Mono', ui-monospace, monospace" } },
]});

/** Breakpoints the page will actually be authored against. */
await call('set_breakpoints', { breakpoints: [
  { name: 'mobile', maxWidth: 640 },
  { name: 'tablet', maxWidth: 900 },
  { name: 'laptop', maxWidth: 1200 },
]});

console.log(JSON.stringify({ open: s.open, docId: s.docId }, null, 2));
console.log(await call('get_tokens'));
await close();
