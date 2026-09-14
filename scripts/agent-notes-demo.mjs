/**
 * An agent working the prompt-card queue: notice, claim, act, answer.
 * This is the loop the canvas is designed around.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = 'http://localhost:4000';
const docId = process.argv[2];

const conn = await (await fetch(`${BASE}/api/documents/${docId}/connections`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'Claude Code' }),
})).json();

const client = new Client({ name: 'notes', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(conn.url)));

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  if (r.isError) throw new Error(`${name}: ${text}`);
  return text;
};

const info = JSON.parse(await call('get_basic_info'));
console.log('notes:', JSON.stringify(info.notes));
if (!info.notes.queued) { console.log('nothing queued'); process.exit(0); }

const { notes } = JSON.parse(await call('list_notes', { status: 'queued' }));
for (const note of notes) {
  console.log(`\ncard ${note.id}: ${JSON.stringify(note.text)}`);
  console.log('  targets:', note.targets.map(t => `${t.name}#${t.id}`).join(', ') || '(none)');

  const claim = JSON.parse(await call('claim_note', { id: note.id }));
  console.log('  claimed ->', claim.next);

  const target = note.targets[0]?.id;
  if (!target) { await call('respond_to_note', { id: note.id, response: 'No target attached.', status: 'queued' }); continue; }

  // Do the work the card asks for.
  const children = JSON.parse(await call('get_children', { id: target }));
  const price = children.find(c => c.type === 'text');

  await call('update_styles', {
    updates: [
      { id: target, styles: { 'border-width': '3px', 'border-color': 'var(--color-brand)', transform: 'scale(1.04)' } },
      ...(price ? [{ id: price.id, styles: { 'font-size': '18px', 'font-weight': '700' } }] : []),
    ],
  });
  const priceNode = children.find(c => c.name === '$16');
  if (priceNode) await call('update_styles', { updates: [{ id: priceNode.id, styles: { 'font-size': '60px' } }] });

  await call('respond_to_note', {
    id: note.id,
    response: 'Thickened the border to 3px in the brand colour, scaled the card 4%, and bumped the price to 60px.',
  });
  console.log('  answered');
}

await client.close();
