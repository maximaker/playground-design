/**
 * The project directory, when the client shares one.
 *
 *   node scripts/roots-check.mjs [base]
 *
 * MCP roots are how a client says "the work is over here". For a hosted server
 * that is information and nothing more — a path on someone else's machine is
 * not a path — so the checks that matter are the boundaries: only directories
 * the client declared, only files inside them, and a clear answer rather than
 * an error where the server simply cannot see the disk.
 */

import './lib/session.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const BASE = process.argv[2] ?? 'http://localhost:4000';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
};

// A project on disk for the client to point at.
const project = mkdtempSync(join(tmpdir(), 'playground-roots-'));
mkdirSync(join(project, 'src', 'styles'), { recursive: true });
writeFileSync(join(project, 'src', 'styles', 'tokens.css'), `:root {
  --color-brand: #0d8a72;
  --color-ink: #16161a;
  --space-4: 16px;
  --radius-md: 12px;
}`);
writeFileSync(join(project, 'tailwind.config.js'), 'module.exports = { theme: { extend: {} } };');
const secret = join(tmpdir(), 'not-the-project.css');
writeFileSync(secret, ':root { --color-secret: #ff0000; }');

const doc = (await (await fetch(`${BASE}/api/documents`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Roots' }),
})).json()).document;
const code = (await (await fetch(`${BASE}/api/documents/${doc.id}/connections`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'roots' }),
})).text()).match(/\/mcp\/([A-Z0-9-]+)/)[1];

const connect = async (opts = {}) => {
  const client = new Client({ name: 'roots-check', version: '1' }, opts);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/${code}`)));
  return {
    client,
    async call(name, args = {}) {
      const r = await client.callTool({ name, arguments: args });
      const t = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      if (r.isError) throw new Error(t);
      try { return JSON.parse(t); } catch { return t; }
    },
  };
};

// --- A client that shares nothing --------------------------------------------------

const plain = await connect();
const nothing = await plain.call('find_project_tokens');
check('a client that shares nothing gets an explanation, not an error',
  nothing.roots.length === 0 && /instead/i.test(nothing.note ?? ''), (nothing.note ?? '').slice(0, 72));

let refused = null;
try {
  await plain.call('sync_tokens_from_code', { path: join(project, 'src/styles/tokens.css') });
} catch (e) { refused = e.message; }
check('and cannot ask the server to read a file', /shared no directories/.test(refused ?? ''),
  (refused ?? '').slice(0, 60));

// --- A client that shares the project ------------------------------------------------

const shared = await connect({ capabilities: { roots: {} } });
shared.client.setRequestHandler(ListRootsRequestSchema, () => ({
  roots: [{ uri: pathToFileURL(project).href, name: 'project' }],
}));

const found = await shared.call('find_project_tokens');
check('the token file in the project is found',
  found.found.some((f) => f.path.endsWith('tokens.css')), found.found.map((f) => f.path.split('/').pop()).join(', '));
check('and the config is listed as one you have to read',
  found.found.find((f) => f.path.endsWith('.js'))?.read === 'you');

const synced = await shared.call('sync_tokens_from_code', {
  path: join(project, 'src/styles/tokens.css'), dryRun: true,
});
check('the server reads the stylesheet itself',
  JSON.stringify(synced).includes('brand'), JSON.stringify(synced).slice(0, 80));

const applied = await shared.call('sync_tokens_from_code', { path: join(project, 'src/styles/tokens.css') });
check('and the tokens land in the document', JSON.stringify(applied).includes('added')
  || JSON.stringify(applied).includes('4'), JSON.stringify(applied).slice(0, 70));
const tokens = await shared.call('get_tokens');
check('with the names the project gave them',
  JSON.stringify(tokens).includes('brand') && JSON.stringify(tokens).includes('space'),
  JSON.stringify(tokens).slice(0, 70));

// --- The boundary ----------------------------------------------------------------------

let outside = null;
try { await shared.call('sync_tokens_from_code', { path: secret }); } catch (e) { outside = e.message; }
check('a file outside the shared directory is refused', /not inside a directory/.test(outside ?? ''),
  (outside ?? '').slice(0, 60));

let escaped = null;
const traversal = join(project, '..', 'not-the-project.css');
try { await shared.call('sync_tokens_from_code', { path: traversal }); } catch (e) { escaped = e.message; }
check('and so is the same file reached by climbing out of it',
  /not inside a directory/.test(escaped ?? ''), (escaped ?? '').slice(0, 60));

let config = null;
try { await shared.call('sync_tokens_from_code', { path: join(project, 'tailwind.config.js') }); } catch (e) { config = e.message; }
check('a config is not executed to read it', /Read it yourself/.test(config ?? ''), (config ?? '').slice(0, 60));

await plain.client.close();
await shared.client.close();
await fetch(`${BASE}/api/documents/${doc.id}`, { method: 'DELETE' });

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} of ${results.length} checks failed` : `\nall ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
