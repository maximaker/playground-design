/**
 * Moves a document from one Playground instance to another and reports what
 * arrives intact.
 *
 * The source deliberately uses the things that are easy to lose: design tokens,
 * a hover variant, a breakpoint variant, and a component with instances.
 *
 * What it found, and what the README now says: structure, styles and variants
 * survive an HTML round trip. Tokens do not — the reference `var(--space-card)`
 * arrives intact and resolves to nothing, so the layout silently collapses, and
 * a name the target happens to share resolves to the *target's* value, which is
 * worse because it looks fine. Components do not survive either; instances are
 * flattened into ordinary markup.
 *
 * Tokens can be carried separately with get_tokens → set_tokens. Use that
 * rather than parsing the CSS export: it emits every theme into one stylesheet,
 * and a regex over it picks up the dark value.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const LOCAL = 'http://localhost:4000';
const LIVE = process.argv[2] ?? 'https://playground.thedigitalvitamins.com';

async function connect(base, docId) {
  const raw = await (await fetch(`${base}/api/documents/${docId}/connections`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'roundtrip' }),
  })).text();
  const code = raw.match(/\/mcp\/([A-Z0-9-]+)/)[1];
  const c = new Client({ name: 'roundtrip', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${code}`)));
  return {
    c,
    call: async (n, a = {}) => {
      const r = await c.callTool({ name: n, arguments: a });
      const t = r.content.filter((x) => x.type === 'text').map((x) => x.text).join('\n');
      if (r.isError) throw new Error(`${n}: ${t}`);
      return t;
    },
  };
}

// --- Source ---------------------------------------------------------------

const src = (await (await fetch(`${LOCAL}/api/documents`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Round trip — source' }),
})).json()).document;
const a = await connect(LOCAL, src.id);

await a.call('set_tokens', { tokens: [
  { name: 'color.brand', group: 'color', values: { default: '#4F46E5', dark: '#818CF8' } },
  { name: 'space.card', group: 'space', values: { default: '28px' } },
]});

const board = JSON.parse(await a.call('create_artboard', { name: 'Source', width: 900, height: 600 }));
const written = JSON.parse(await a.call('write_html', {
  targetId: board.id, mode: 'replace-children',
  html: `
    <style>
      .card { display: flex; flex-direction: column; gap: 12px; padding: var(--space-card);
              background: #fff; border-radius: 16px; border: 1px solid #ececec; }
      .card:hover { border-color: var(--color-brand); }
      @media (max-width: 600px) { .card { padding: 12px; } }
      .cta { padding: 12px 24px; border-radius: 999px; background: var(--color-brand); color: #fff; }
    </style>
    <div style="display:flex;flex-direction:column;gap:24px;padding:40px;background:#ebebeb;height:100%">
      <h1 style="margin:0;font-size:32px;color:var(--color-brand)">Round trip</h1>
      <div class="card">
        <strong style="font-size:18px">A card with a hover and a breakpoint</strong>
        <p style="margin:0;color:#7c7c7c">Tokens, variants and a component should all survive.</p>
      </div>
      <span class="cta">Call to action</span>
    </div>`,
}));

// A real component with an instance, which is the thing most likely to be lost.
const cardId = JSON.parse(await a.call('get_children', { id: written.roots[0].id }))[1].id;
const comp = JSON.parse(await a.call('create_component', { id: cardId, name: 'Card' }));
await a.call('insert_instance', { componentId: comp.componentId, parentId: written.roots[0].id });

const before = JSON.parse(await a.call('get_basic_info'));
const tokensBefore = JSON.parse(await a.call('get_tokens'));
// These tools answer with prose when there is nothing to list, so the count
// has to survive a response that is not JSON.
const count = (text) => { try { const v = JSON.parse(text); return Array.isArray(v) ? v.length : (v.components?.length ?? 0); } catch { return 0; } };
const compsBefore = count(await a.call('list_components'));
console.log('  source:', before.nodeCount, 'nodes |', tokensBefore.tokens.length, 'tokens |',
  compsBefore, 'component(s)');

// --- Export ---------------------------------------------------------------

const exported = await a.call('get_html', { id: board.id, mode: 'stylesheet' });
console.log('  exported:', exported.length, 'chars of HTML+CSS');
await a.c.close();

// --- Import ---------------------------------------------------------------

const dst = (await (await fetch(`${LIVE}/api/documents`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Round trip — imported' }),
})).json()).document;
const b = await connect(LIVE, dst.id);
const dstBoard = JSON.parse(await b.call('create_artboard', { name: 'Imported', width: 900, height: 600 }));
await b.call('write_html', { targetId: dstBoard.id, mode: 'replace-children', html: exported });

const after = JSON.parse(await b.call('get_basic_info'));
const tokensAfter = JSON.parse(await b.call('get_tokens'));
const rawComps = await b.call('list_components');
const compsAfter = (() => { try { const v = JSON.parse(rawComps); return Array.isArray(v) ? v.length : (v.components?.length ?? 0); } catch { return 0; } })();

console.log('\n  --- what arrived');
console.log('  nodes     :', after.nodeCount, '(source had', before.nodeCount + ')');
console.log('  tokens    :', tokensAfter.tokens.map((t) => t.name).join(', ') || '(none)');
console.log('  components:', compsAfter, '(source had', compsBefore + ')');
console.log('\n  source url:', `${LOCAL}/d/${src.id}`);
console.log('  imported  :', `${LIVE}/d/${dst.id}`);
await b.c.close();
