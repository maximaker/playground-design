import { session, connect } from './connect.mjs';
const s = await session();
const { call, close } = await connect(s.url);
const info = JSON.parse(await call('get_basic_info'));
const desktop = info.artboards.find((a) => a.name === 'Landing — 1440');
const page = JSON.parse(await call('get_children', { id: desktop.id }))[0];

// The copies are exactly that — copies. Rather than patch each one and let them
// drift, they are replaced from the original whenever it changes.
for (const name of ['Landing — 900 tablet', 'Landing — 390 phone']) {
  const board = info.artboards.find((a) => a.name === name);
  const old = JSON.parse(await call('get_children', { id: board.id }));
  if (old.length) await call('delete_nodes', { ids: old.map((o) => o.id) });
  await call('duplicate_nodes', { ids: [page.id], parentId: board.id });
  console.log('refreshed', name);
}
await close();
