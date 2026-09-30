/**
 * Diagrams on the board, over MCP.
 *
 *   node scripts/board-check.mjs [base]
 *
 * What an agent does with the board: writes a diagram from Mermaid, reads it
 * back, looks at it, edits it, connects it to a real artboard, and redraws it.
 * Each step is checked against the document itself rather than against what the
 * tool said it did.
 */

import './lib/session.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = process.argv[2] ?? 'http://localhost:4000';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
};

const doc = (await (await fetch(`${BASE}/api/documents`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Board check' }),
})).json()).document;
const code = (await (await fetch(`${BASE}/api/documents/${doc.id}/connections`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'board' }),
})).text()).match(/\/mcp\/([A-Z0-9-]+)/)[1];

const client = new Client({ name: 'board-check', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/${code}`)));
const raw = async (name, args = {}) => client.callTool({ name, arguments: args });
const call = async (name, args = {}) => {
  const r = await raw(name, args);
  const t = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r.isError) throw new Error(t);
  try { return JSON.parse(t); } catch { return t; }
};
const stored = async () => (await (await fetch(`${BASE}/api/documents/${doc.id}`)).json()).document;
const boardOf = async () => (await stored()).pages[0].board ?? [];

// --- Tools are there, and grouped ---------------------------------------------

const { tools } = await client.listTools();
const names = new Set(tools.map((t) => t.name));
check('the three board tools are listed', ['get_board', 'edit_board', 'write_diagram'].every((n) => names.has(n)));
const sets = await call('list_toolsets');
check('they are the diagrams toolset', JSON.stringify(sets).includes('diagrams'));

// --- Write a diagram from Mermaid ---------------------------------------------

const written = await call('write_diagram', {
  mermaid: `flowchart LR
    A[Sign up] --> B{Verified?}
    B -- yes --> C([Dashboard])
    B -->|no| D[Resend email]
    D -.-> B
    subgraph Onboarding
      A
      B
    end
    sequence nonsense here`,
});
let board = await boardOf();
check('every node, edge and section is on the board',
  board.filter((i) => i.type === 'shape' && i.kind !== 'section').length === 4
  && board.filter((i) => i.type === 'connector').length === 4
  && board.filter((i) => i.kind === 'section').length === 1,
  `${board.length} items`);
check('the unreadable line is reported, not dropped', written.skipped?.length === 1 && written.skipped[0].line === 10);
const starter = (await stored()).pages[0].artboards[0];
const artboard = (await stored()).nodes[starter];
const right = Number(artboard.attrs['data-x']) + parseFloat(artboard.styles.width);
check('it is placed clear of the artboards', Math.min(...board.filter((i) => i.type === 'shape').map((s) => s.x)) >= right);
check('labels and dashes survive', board.some((i) => i.label === 'yes') && board.some((i) => i.label === 'no') && board.some((i) => i.dashed));

// --- Read it back, and look at it -----------------------------------------------

const read = await raw('get_board', { image: true });
const described = JSON.parse(read.content[0].text);
check('get_board returns every item with connector paths', described.items.length === board.length
  && described.items.filter((i) => i.type === 'connector').every((c) => Array.isArray(c.path) && c.path.length >= 2));
const picture = read.content.find((c) => c.type === 'image');
check('and a picture when asked', !!picture && picture.data.length > 2000,
  picture ? `${Math.round(picture.data.length / 1024)}KB` : read.content.map((c) => c.text?.slice(0, 60)).join(' | '));

// --- Edit: add, connect to an artboard by name, restyle, remove ------------------

const signUp = board.find((i) => i.text === 'Sign up');
const edited = await call('edit_board', {
  changes: [
    { action: 'add', shape: { id: 'note1', kind: 'text', x: signUp.x, y: signUp.y - 60, text: 'Entry point' } },
    { action: 'add', connector: { from: { artboard: artboard.name }, to: { shape: signUp.id }, label: 'from landing' } },
    { action: 'update', id: signUp.id, patch: { color: 'green' } },
  ],
});
board = await boardOf();
const toScreen = board.find((i) => i.type === 'connector' && i.from.kind === 'artboard');
check('a connector can start on an artboard named by its name', toScreen?.from.id === starter);
check('an agent can choose its own id to use in the same call', board.some((i) => i.id === 'note1'));
check('restyled in the same step', board.find((i) => i.id === signUp.id).color === 'green');
check('and the whole edit is one entry in history', edited.added.length === 2);

const verified = board.find((i) => i.text === 'Verified?');
const into = board.filter((i) => i.type === 'connector' && (i.to.id === verified.id || i.from.id === verified.id)).length;
await call('edit_board', { changes: [{ action: 'remove', id: verified.id }] });
board = await boardOf();
const orphans = board.filter((i) => i.type === 'connector' && (i.from.kind === 'point' || i.to.kind === 'point'));
check('removing a shape keeps its connectors, ending where it was', orphans.length === into && !board.some((i) => i.id === verified.id),
  `${orphans.length} of ${into}`);

// --- Mistakes come back as messages an agent can act on --------------------------

let err = '';
try { await call('edit_board', { changes: [{ action: 'add', connector: { from: { shape: 'nope' }, to: { x: 0, y: 0 } } }] }); }
catch (e) { err = e.message; }
check('an unknown shape is refused with the way out', /get_board/.test(err), err.slice(0, 60));
err = '';
try { await call('edit_board', { changes: [{ action: 'add', connector: { from: { artboard: 'Nowhere' }, to: { x: 0, y: 0 } } }] }); }
catch (e) { err = e.message; }
check('so is an artboard that is not on the page', /No artboard "Nowhere"/.test(err), err.slice(0, 60));

// --- Redraw with replace ---------------------------------------------------------

const before = (await boardOf()).length;
const redrawn = await call('write_diagram', { mermaid: 'flowchart TD\nX --> Y', replace: written.ids.filter((id) => board.some((i) => i.id === id)) });
board = await boardOf();
check('replace removes the old diagram in the same step', board.some((i) => i.text === 'X')
  && !board.some((i) => i.text === 'Dashboard'), `${before} → ${board.length} items`);

// --- A flow of real screens -----------------------------------------------------

const second = await call('create_artboard', { name: 'Checkout', width: 390, height: 844, x: 3000, y: 2000 });
const flow = await call('write_diagram', {
  direction: 'LR',
  nodes: [{ id: 'home', label: 'Home', artboard: artboard.name }, { id: 'pay', label: 'Pay', artboard: 'Checkout' }, { id: 'done', label: 'Thanks' }],
  edges: [{ from: 'home', to: 'pay' }, { from: 'pay', to: 'done' }],
});
let after = await stored();
check('artboards stay put unless asked', after.nodes[second.id].attrs['data-x'] === '3000' && /arrangeArtboards/.test(flow.note ?? ''));
await call('write_diagram', {
  direction: 'LR', replace: flow.ids, arrangeArtboards: true,
  nodes: [{ id: 'home', label: 'Home', artboard: artboard.name }, { id: 'pay', label: 'Pay', artboard: 'Checkout' }],
  edges: [{ from: 'home', to: 'pay' }],
});
after = await stored();
const hx = Number(after.nodes[starter].attrs['data-x']);
const px = Number(after.nodes[second.id].attrs['data-x']);
check('and arranged into the flow when asked', px > hx + parseFloat(after.nodes[starter].styles.width), `home ${hx} → pay ${px}`);

// --- The design is untouched -----------------------------------------------------

const lint = await call('lint_design');
check('the board never reaches the linter', !JSON.stringify(lint).includes('bs_'));

await client.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed ? `${failed} failed` : `all ${results.length} checks passed`}`);
process.exit(failed ? 1 : 0);
