/** Runs one tool call: node run.mjs <tool> '<json args>' */
import { session, connect } from './connect.mjs';
const s = await session();
const { call, close } = await connect(s.url);
const out = await call(process.argv[2], JSON.parse(process.argv[3] ?? '{}'));
console.log(out);
await close();
