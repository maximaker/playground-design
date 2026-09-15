import { readFileSync } from 'node:fs';
import { session, connect } from './connect.mjs';
const s = await session();
const { call, close } = await connect(s.url);
const info = JSON.parse(await call('get_basic_info'));
const board = info.artboards.find((a) => a.name === 'Landing — 1440');

const html = readFileSync(new URL('./page.html', import.meta.url), 'utf8');
await call('write_html', { targetId: board.id, mode: 'replace-children', html });
console.log('page rewritten as one fragment');
await close();
