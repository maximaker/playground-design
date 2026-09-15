/**
 * End-to-end check for code components.
 *
 * This path crosses more boundaries than anything else in the product — MCP,
 * asset storage, CORS, two levels of iframe sandboxing, a postMessage
 * handshake, React inside React — and every one of them fails silently: the
 * component simply does not appear, or appears with default props, which looks
 * like working software. So it is checked with a real browser and a real
 * bundle, not mocked at any layer.
 */

import './lib/session.mjs';  // signs these checks in; see the module header
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const BASE = process.argv[2] ?? 'http://localhost:4000';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
};

const bundled = await build({
  entryPoints: [fileURLToPath(new URL('./fixtures/repo/entry.tsx', import.meta.url))],
  bundle: true, write: false, format: 'esm', minify: true, jsx: 'automatic', target: 'es2022',
  define: { 'process.env.NODE_ENV': '"production"' },
});
const source = bundled.outputFiles[0].text;

const doc = await (await fetch(`${BASE}/api/documents`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Code component check', template: 'clean' }),
})).json();
const docId = doc.document.id;
const conn = await (await fetch(`${BASE}/api/documents/${docId}/connections`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'Check' }),
})).json();

const client = new Client({ name: 'code-check', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(conn.url)));
const call = async (n, a = {}) => {
  const r = await client.callTool({ name: n, arguments: a });
  const t = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r.isError) throw new Error(`${n}: ${t}`);
  return t;
};

const board = JSON.parse(await call('create_artboard', { name: 'Check', width: 700, height: 300 }));
await call('register_code_component', {
  name: 'Button', importPath: '@/components/Button', sourcePath: 'components/Button.tsx',
  bundle: source,
  props: [
    { name: 'label', type: 'string', default: 'Button' },
    { name: 'variant', type: 'enum', values: ['primary', 'ghost', 'danger'], default: 'primary' },
    { name: 'size', type: 'enum', values: ['sm', 'md', 'lg'], default: 'md' },
  ],
});
const placed = JSON.parse(await call('add_code_instance', {
  componentId: 'Button', parentId: board.id, props: { label: 'Ship it', variant: 'danger' },
}));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(`${BASE}/d/${docId}`, { waitUntil: 'networkidle' });
await page.waitForSelector('.artboard-frame iframe', { timeout: 20000 });
await page.waitForTimeout(2500);

/** The component's own DOM, read from inside the sandbox. */
const read = async () => page.evaluate(async (nodeId) => {
  const storeProps = window.__playground.store.getState().doc.nodes[nodeId]?.props;
  for (const artboard of document.querySelectorAll('.artboard-frame iframe')) {
    const wrapper = artboard.contentDocument?.querySelector(`[data-node-id="${nodeId}"]`);
    if (!wrapper) continue;
    const frame = wrapper.querySelector('iframe');
    if (!frame) return { found: false };
    const rect = frame.getBoundingClientRect();
    return {
      found: true,
      opaque: !frame.contentDocument, // no same-origin access == the sandbox held
      sandbox: frame.getAttribute('sandbox'),
      artboardSandbox: artboard.getAttribute('sandbox'),
      width: Math.round(rect.width), height: Math.round(rect.height),
      error: wrapper.textContent?.includes('failed to render') ? wrapper.textContent.trim() : null,
      storeProps,
      rendered: frame.getAttribute('data-code-props'),
    };
  }
  return { found: false };
}, placed.id);

const initial = await read();
check('the component mounts', initial.found && !initial.error, initial.error ?? '');
check('it reports a real size', initial.height > 20 && initial.width > 40,
  `${initial.width}×${initial.height}`);
check('the bundle runs with an opaque origin', initial.opaque === true && initial.sandbox === 'allow-scripts',
  initial.sandbox ?? 'no sandbox attribute');
check('scripts are enabled only on the hosting artboard',
  initial.artboardSandbox === 'allow-same-origin allow-scripts', initial.artboardSandbox ?? '');

// Props must reach the component, not be quietly replaced by its defaults —
// the failure that looks most like success.
const before = { width: initial.width, height: initial.height };
await call('set_code_props', { id: placed.id, props: { size: 'lg', label: 'A much longer label' } });

// Wait for the change to arrive rather than guessing: the tab may be on the
// polling transport, whose interval is longer than any sensible fixed sleep.
let after = initial;
for (let i = 0; i < 20 && after.width === initial.width; i++) {
  await page.waitForTimeout(500);
  after = await read();
}
check('a prop change re-renders the live component',
  after.width > before.width && after.height > before.height,
  `${before.width}×${before.height} -> ${after.width}×${after.height}` +
  // Distinguishes the two ways this fails, which look the same from outside.
  (after.width === before.width
    ? `  (react handed it ${after.rendered}, store holds ${JSON.stringify(after.storeProps)})`
    : ''));

const jsx = await call('get_jsx', { id: board.id, componentName: 'Check' });
check('export emits the real import', jsx.includes('import Button from "@/components/Button"'));
check('export emits the element, not its markup', /<Button label="A much longer label"/.test(jsx));
check('export omits props left at their default', !jsx.includes('variant="primary"'));

check('no runtime errors', errors.length === 0, errors[0] ?? '');

await browser.close();
await client.close();

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} check(s) failed` : `\nall ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
