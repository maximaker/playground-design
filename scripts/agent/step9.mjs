import { session, connect } from './connect.mjs';
const s = await session();
const { call, close } = await connect(s.url);
const info = JSON.parse(await call('get_basic_info'));
const desktop = info.artboards.find((a) => a.name === 'Landing — 1440');
const page = JSON.parse(await call('get_children', { id: desktop.id }))[0];

/**
 * Two more artboards at tablet and phone width, holding a copy of the same
 * tree. The media-query variants travel with the nodes and each artboard is its
 * own document, so the copies lay themselves out — these are not three
 * mock-ups, they are one design measured at three widths.
 */
for (const [name, width] of [['Landing — 900 tablet', 900], ['Landing — 390 phone', 390]]) {
  const existing = info.artboards.find((a) => a.name === name);
  if (existing) continue;
  const board = JSON.parse(await call('create_artboard', {
    name, width, height: 4000,
    styles: { 'background-color': 'var(--color-bg)', display: 'block', padding: '0' },
  }));
  const copy = JSON.parse(await call('duplicate_nodes', { ids: [page.id], parentId: board.id }));
  console.log(name, '→', board.id, JSON.stringify(copy).slice(0, 80));
}
await close();
