/**
 * Give the imported site's repeated shapes their names.
 *
 *   node scripts/agent/name-site-components.mjs <docId> [base]
 *
 * The same pass reimport-into.mjs runs at the end, on its own — after a large
 * re-import the shape index has been seen to lag a beat behind the writes, and
 * a second pass picks up whatever the first one could not find.
 */
import '../lib/session.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const DOC = process.argv[2];
const BASE = process.argv[3] ?? 'https://playground.thedigitalvitamins.com';
const NAMES = [
  ['Am fost și de partea', 'Reason card'], ['ani de practică', 'Stat'], ['15+', 'Stat'],
  ['Putem participa doar noi', 'FAQ item'], ['Trebuie ca diagnosticul', 'FAQ item, open'],
  ['O oră care limpezește', 'Step card'], ['Sesiunea 1', 'Session card'],
  ['Workshop 01', 'Workshop card'], ['Numele tău', 'Form field'],
  ['30 de minute despre cum', 'Bullet list'], ['Cum vă pot ajuta', 'Section intro'],
  ['Întrebări', 'Section header'], ['imagine provizorie', 'Portrait photo'],
  ['provizorie', 'Photo placeholder'], ['Boala nu se întâmplă', 'Quote band'],
  // Before the closing band: all three open with the brand name, and the first
  // needle to match takes the shape.
  ['© 2026', 'Site footer'],
  ['Acasă', 'Site header'],
  ['Bine în botoșei de spital', 'Closing CTA'],
];

const raw = await (await fetch(`${BASE}/api/documents/${DOC}/connections`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'naming' }),
})).text();
const client = new Client({ name: 'naming', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/${raw.match(/\/mcp\/([A-Z0-9-]+)/)[1]}`)));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r.isError) throw new Error(text);
  return text;
};

const have = new Set(JSON.parse(await call('list_components')).components.map((c) => c.name));
for (const [needle, name] of NAMES) {
  if (have.has(name)) continue;
  const { groups } = JSON.parse(await call('find_repeated_shapes', { minCopies: 2, minDepth: 2, limit: 40 }));
  const group = groups
    .filter((g) => (g.text ?? '').includes(needle) && !g.alreadyComponent)
    .sort((a, b) => b.copies - a.copies)[0];
  if (!group) { console.log(`  ${name}: nothing matched "${needle}"`); continue; }
  try { await call('componentise', { id: group.sample, name }); have.add(name); console.log(`  ${name} ×${group.copies}`); }
  catch (e) { console.log(`  ${name}: ${e.message.split('\n')[0].slice(0, 120)}`); }
}
console.log(JSON.parse(await call('list_components')).components.map((c) => `${c.name} ×${c.instances}`).join(', '));
await client.close();
