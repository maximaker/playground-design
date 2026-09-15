/**
 * The full code-component loop, the way an agent would drive it:
 * bundle a real component from a repo, register it, place it, vary its props,
 * and export JSX that imports the original rather than copying its markup.
 */
import './lib/session.mjs';  // signs these checks in; see the module header
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE ?? 'http://localhost:4000';
const entry = fileURLToPath(new URL('./fixtures/repo/entry.tsx', import.meta.url));

// Step 1: the agent bundles. It has the filesystem and the toolchain; the
// browser has neither, which is why the contract is "hand me a module".
const bundled = await build({
  entryPoints: [entry], bundle: true, write: false, format: 'esm',
  minify: true, jsx: 'automatic', target: 'es2022',
  define: { 'process.env.NODE_ENV': '"production"' },
});
const source = bundled.outputFiles[0].text;
console.log(`Bundled Button.tsx → ${(source.length / 1024).toFixed(0)}KB of ESM (React included).`);

const doc = await (await fetch(`${BASE}/api/documents`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ template: 'clean', name: 'Code components' }),
})).json();
const conn = await (await fetch(`${BASE}/api/documents/${doc.document.id}/connections`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'Code Agent' }),
})).json();

const client = new Client({ name: 'code-demo', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(conn.url)));
const call = async (n, a = {}) => {
  const r = await client.callTool({ name: n, arguments: a });
  const t = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r.isError) throw new Error(`${n}: ${t}`);
  return t;
};

const board = JSON.parse(await call('create_artboard', { name: 'Buttons', width: 880, height: 360 }));
const shell = JSON.parse(await call('write_html', {
  targetId: board.id, mode: 'replace-children',
  html: `<div style="display:flex;flex-direction:column;gap:24px;padding:48px;background:#ffffff;height:100%">
    <span style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#71717a">Real components</span>
    <div style="display:flex;flex-direction:row;gap:16px;align-items:center;flex-wrap:wrap"></div>
  </div>`,
}));
const row = JSON.parse(await call('get_children', { id: shell.roots[0].id }))[1].id;

// Step 2: register. The props declared here become the designer's controls.
const registered = JSON.parse(await call('register_code_component', {
  name: 'Button',
  importPath: '@/components/Button',
  sourcePath: 'components/Button.tsx',
  bundle: source,
  props: [
    { name: 'label', type: 'string', default: 'Button' },
    { name: 'variant', type: 'enum', values: ['primary', 'ghost', 'danger'], default: 'primary' },
    { name: 'size', type: 'enum', values: ['sm', 'md', 'lg'], default: 'md' },
    { name: 'disabled', type: 'boolean', default: 'false' },
  ],
}));
console.log(`Registered ${registered.id}.`);

// Step 3: place instances. Same component, different props — no duplication.
const combos = [
  { label: 'Save changes', variant: 'primary', size: 'md' },
  { label: 'Cancel', variant: 'ghost', size: 'md' },
  { label: 'Delete', variant: 'danger', size: 'lg' },
  { label: 'Saving…', variant: 'primary', size: 'sm', disabled: 'true' },
];
for (const props of combos) {
  await call('add_code_instance', { componentId: 'Button', parentId: row, props });
}

console.log(await call('get_code_usage', { componentId: 'Button' }));

// Step 4: the payoff — export is an import, not a copy.
console.log('\n--- JSX export ---');
console.log(await call('get_jsx', { id: board.id, componentName: 'Buttons' }));

// And a guard against the obvious mistake.
const rejected = await client.callTool({
  name: 'add_code_instance',
  arguments: { componentId: 'Button', parentId: row, props: { colour: 'red' } },
});
console.log('\nUndeclared prop is refused:', rejected.isError ? 'yes' : 'NO — bug');

console.log(`\nOpen ${BASE}/d/${doc.document.id}`);
await client.close();
