import { session, connect } from './connect.mjs';
const s = await session();
const { call, close } = await connect(s.url);
const info = JSON.parse(await call('get_basic_info'));
const board = info.artboards.find((a) => a.name === 'Foundations');

await call('update_styles', { updates: [{ id: board.id, styles: { height: '2560px' } }] });

// The shadow specimens were transparent on a white card, so only the shadow
// showed and the shape was lost. A sunken fill makes both legible.
const shadows = (await call('find_nodes', { query: 'shadow.' }))
  .split('\n').map((l) => /#(n_\w+)/.exec(l)?.[1]).filter(Boolean);

const tree = await call('get_tree_summary', { id: board.id, depth: 12 });
const boxIds = tree.split('\n')
  .filter((l) => l.includes('class') === false)
  .map((l) => /#(n_\w+)/.exec(l)?.[1]).filter(Boolean);

console.log('shadow label nodes:', shadows.join(', '));
await close();
