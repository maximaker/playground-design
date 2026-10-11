/**
 * End-to-end MCP tests: a real MCP client over real HTTP against a real server,
 * driving the document the way an agent would.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

process.env.PLAYGROUND_DB = `/tmp/playground-test-${Date.now()}.db`;

const { app } = await import('./app.ts');
const { createDocument, getDocument } = await import('./store.ts');
const { createConnection } = await import('./connections.ts');
const { shutdownRenderer } = await import('./render.ts');

let server: ReturnType<typeof serve>;
let base: string;
let client: Client;
let docId: string;
/** Session cookie for the test account, so REST calls get past the auth gate. */
let cookie = '';

/** `fetch`, signed in. The MCP transport has its own credential and needs none. */
async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, { ...init, headers: { ...init.headers, cookie } });
}

function textOf(res: unknown): string {
  const content = (res as { content: { type: string; text?: string }[] }).content;
  return content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
}
function jsonOf<T>(res: unknown): T { return JSON.parse(textOf(res)) as T; }
function isError(res: unknown): boolean { return (res as { isError?: boolean }).isError === true; }

before(async () => {
  const port = 4100 + Math.floor(Math.random() * 400);
  base = `http://127.0.0.1:${port}`;
  server = serve({ fetch: app.fetch, port });

  // The REST API needs an account now. The MCP endpoint does not — a connection
  // code is its own credential — which is what most of this file exercises.
  const signup = await fetch(`${base}/api/auth/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'test@example.com', password: 'a-long-test-password' }),
  });
  cookie = (signup.headers.get('set-cookie') ?? '').split(';')[0]!;

  docId = (await createDocument('MCP Test')).id;
  const conn = await createConnection(docId, 'Test Agent');

  client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${conn.code}`)));
});

after(async () => {
  await client.close().catch(() => {});
  // The screenshot test may have launched a headless browser; without closing it
  // the test process stays alive until the runner's timeout kills it.
  await shutdownRenderer();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('lists the full tool surface', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  for (const expected of [
    'get_basic_info', 'get_selection', 'get_node_info', 'get_children', 'get_tree_summary',
    'get_computed_styles', 'get_jsx', 'get_html', 'get_screenshot', 'get_fill_image',
    'get_font_family_info', 'get_tokens', 'get_guide', 'find_nodes',
    'create_artboard', 'write_html', 'update_styles', 'set_text_content', 'rename_nodes',
    'set_attributes', 'move_nodes', 'duplicate_nodes', 'delete_nodes', 'set_tokens',
    'set_selection', 'export', 'start_working_on_nodes', 'finish_working_on_nodes',
    'register_code_component', 'list_code_components', 'add_code_instance', 'set_code_props',
    'remove_code_component', 'get_code_usage', 'get_code_component_guide',
  ]) {
    assert.ok(names.includes(expected), `missing tool: ${expected}`);
  }
  // Every tool must describe itself well enough to be usable without docs.
  for (const t of tools) assert.ok((t.description ?? '').length > 30, `${t.name} needs a real description`);
});

test('get_basic_info reports artboards', async () => {
  const info = jsonOf<{ artboards: { id: string; width: number }[]; nodeCount: number }>(
    await client.callTool({ name: 'get_basic_info', arguments: {} }),
  );
  assert.equal(info.artboards.length, 1);
  assert.equal(info.artboards[0]!.width, 1440);
});

test('write_html creates an editable tree with styles and variants', async () => {
  const info = jsonOf<{ artboards: { id: string }[] }>(await client.callTool({ name: 'get_basic_info', arguments: {} }));
  const artboard = info.artboards[0]!.id;

  const res = jsonOf<{ created: number; totalNodes: number; roots: { id: string; type: string }[]; warnings: string[] }>(
    await client.callTool({
      name: 'write_html',
      arguments: {
        targetId: artboard,
        mode: 'insert-children',
        html: `
          <style>
            .hero { display: flex; flex-direction: column; gap: 16px; padding: 48px; }
            .cta:hover { background: #1d4ed8 }
            @media (max-width: 768px) { .hero { padding: 24px } }
          </style>
          <section class="hero">
            <h1 style="font-size:48px">Ship faster</h1>
            <p>Design in real HTML.</p>
            <button class="cta" style="background:#3b82f6;color:#fff">Get started</button>
          </section>`,
      },
    }),
  );

  assert.equal(res.created, 1);
  assert.ok(res.totalNodes >= 4);
  assert.equal(res.roots[0]!.type, 'frame');

  const doc = getDocument(docId)!;
  const hero = doc.nodes[res.roots[0]!.id]!;
  assert.equal(hero.styles.display, 'flex');
  assert.equal(hero.styles.padding, '48px');
  assert.ok(hero.variants.some((v) => v.selector.startsWith('@media')));

  const button = Object.values(doc.nodes).find((n) => n.tag === 'button')!;
  assert.ok(button.variants.some((v) => v.selector === ':hover'));
});

test('get_tree_summary returns rows, with the text outline on request', async () => {
  type Row = { id: string; type: string; name: string; text?: string; depth: number; parent: string | null };
  const res = jsonOf<{ nodes: Row[]; outline?: string }>(
    await client.callTool({ name: 'get_tree_summary', arguments: { depth: 6 } }));
  assert.equal(res.nodes[0]!.type, 'artboard');
  assert.equal(res.nodes[0]!.depth, 0);
  assert.ok(res.nodes.some((n) => n.text === 'Ship faster'));
  assert.ok(res.nodes.length < 20, 'summary should stay compact');
  assert.equal(res.outline, undefined);
  const withOutline = jsonOf<{ outline: string }>(
    await client.callTool({ name: 'get_tree_summary', arguments: { depth: 6, outline: true } }));
  assert.match(withOutline.outline, /artboard#/);
});

type Hit = { id: string; type: string; tag: string; name: string; text?: string; artboard: string | null; line: string };
async function find(args: Record<string, unknown>): Promise<{ count: number; nodes: Hit[] }> {
  return jsonOf(await client.callTool({ name: 'find_nodes', arguments: args }));
}

test('find_nodes returns structured rows by text and by type', async () => {
  const byText = await find({ query: 'Ship faster' });
  assert.equal(byText.nodes[0]!.type, 'text');
  assert.equal(byText.nodes[0]!.text, 'Ship faster');
  assert.ok(byText.nodes[0]!.artboard, 'each hit says which artboard it is on');
  assert.match(byText.nodes[0]!.line, /text#/, 'the compact line is still there');
  const byType = await find({ type: 'artboard' });
  assert.ok(byType.count >= 1);
  assert.ok(byType.nodes.every((n) => n.type === 'artboard'));
  const none = await find({ query: 'nonexistent-xyz' });
  assert.deepEqual(none, { count: 0, nodes: [] });
});

test('unknown parameters are rejected with the name of the key', async () => {
  const res = await client.callTool({ name: 'find_nodes', arguments: { query: 'Ship', typo: 'x' } });
  assert.ok(isError(res));
  assert.match(textOf(res), /typo/);
  const { tools } = await client.listTools();
  const schema = tools.find((t) => t.name === 'find_nodes')!.inputSchema as { additionalProperties?: boolean };
  assert.equal(schema.additionalProperties, false);
});

test('update_styles batches and supports variant selectors', async () => {
  const id = (await find({ tag: 'button' })).nodes[0]?.id ?? '';
  assert.ok(id, 'should find the button node');

  await client.callTool({
    name: 'update_styles',
    arguments: {
      updates: [
        { id, styles: { 'border-radius': '9999px', padding: '12px 24px' } },
        { id, styles: { transform: 'translateY(-1px)' }, selector: ':hover' },
      ],
    },
  });

  const node = getDocument(docId)!.nodes[id]!;
  assert.equal(node.styles['border-radius'], '9999px');
  assert.ok(node.variants.find((v) => v.selector === ':hover')?.styles.transform);
});

test('set_text_content rejects non-text nodes with a recoverable message', async () => {
  const info = jsonOf<{ artboards: { id: string }[] }>(await client.callTool({ name: 'get_basic_info', arguments: {} }));
  const res = await client.callTool({
    name: 'set_text_content',
    arguments: { updates: [{ id: info.artboards[0]!.id, text: 'nope' }] },
  });
  assert.ok(isError(res));
  assert.match(textOf(res), /not text nodes/);
  assert.match(textOf(res), /get_children/, 'error should say how to recover');
});

test('set_text_content updates real text nodes', async () => {
  const doc = getDocument(docId)!;
  const h1 = Object.values(doc.nodes).find((n) => n.tag === 'h1')!;
  await client.callTool({ name: 'set_text_content', arguments: { updates: [{ id: h1.id, text: 'Ship even faster' }] } });
  assert.equal(getDocument(docId)!.nodes[h1.id]!.text, 'Ship even faster');
});

test('create_artboard places new artboards clear of existing ones', async () => {
  const res = jsonOf<{ id: string; x: number; width: number }>(
    await client.callTool({ name: 'create_artboard', arguments: { name: 'Mobile', width: 390, height: 844 } }),
  );
  assert.equal(res.width, 390);
  assert.ok(res.x >= 1440, 'should be placed to the right of the 1440px artboard');
});

test('duplicate_nodes returns a complete id map', async () => {
  const doc = getDocument(docId)!;
  const hero = Object.values(doc.nodes).find((n) => n.tag === 'section')!;
  const res = jsonOf<{ duplicated: { newId: string; idMap: Record<string, string> }[] }>(
    await client.callTool({ name: 'duplicate_nodes', arguments: { ids: [hero.id] } }),
  );
  const dup = res.duplicated[0]!;
  assert.notEqual(dup.newId, hero.id);
  assert.ok(Object.keys(dup.idMap).length >= 4, 'id map should cover every descendant');

  const after = getDocument(docId)!;
  for (const newId of Object.values(dup.idMap)) assert.ok(after.nodes[newId], `${newId} should exist`);
});

test('move_nodes preserves ids and refuses cycles', async () => {
  const doc = getDocument(docId)!;
  const hero = Object.values(doc.nodes).find((n) => n.tag === 'section')!;
  const child = doc.nodes[hero.children[0]!]!;

  const bad = await client.callTool({ name: 'move_nodes', arguments: { moves: [{ id: hero.id, parentId: child.id }] } });
  assert.ok(isError(bad), 'moving a parent into its own child must fail');

  const artboard = doc.pages[0]!.artboards[0]!;
  await client.callTool({ name: 'move_nodes', arguments: { moves: [{ id: child.id, parentId: artboard, index: 0 }] } });
  const after = getDocument(docId)!;
  assert.equal(after.nodes[child.id]!.parent, artboard, 'id must survive the move');
  assert.equal(after.nodes[artboard]!.children[0], child.id);
});

test('move_nodes repositions artboards on the canvas', async () => {
  const doc = getDocument(docId)!;
  const mobile = doc.pages[0]!.artboards.map((a) => doc.nodes[a]!).find((n) => n.name === 'Mobile')!;
  await client.callTool({ name: 'move_nodes', arguments: { moves: [{ id: mobile.id, x: 2000, y: 100 }] } });
  const after = getDocument(docId)!.nodes[mobile.id]!;
  assert.equal(after.attrs['data-x'], '2000');
  assert.equal(after.attrs['data-y'], '100');
});

test('get_jsx emits tailwind and inline formats', async () => {
  const doc = getDocument(docId)!;
  const hero = Object.values(doc.nodes).find((n) => n.tag === 'section')!;

  const tw = textOf(await client.callTool({ name: 'get_jsx', arguments: { id: hero.id, format: 'tailwind' } }));
  assert.match(tw, /className="/);
  assert.match(tw, /flex-col/);

  const inline = textOf(await client.callTool({
    name: 'get_jsx', arguments: { id: hero.id, format: 'inline', componentName: 'Hero' },
  }));
  assert.match(inline, /export function Hero\(\)/);
  assert.match(inline, /flexDirection/);
});

test('get_html round-trips through write_html', async () => {
  const doc = getDocument(docId)!;
  const hero = Object.values(doc.nodes).find((n) => n.tag === 'section')!;
  const html = textOf(await client.callTool({ name: 'get_html', arguments: { id: hero.id } }));
  assert.match(html, /<section/);

  const artboard = doc.pages[0]!.artboards[0]!;
  const res = jsonOf<{ totalNodes: number }>(await client.callTool({
    name: 'write_html', arguments: { targetId: artboard, html },
  }));
  assert.ok(res.totalNodes >= 4, 'emitted HTML should parse back into an equivalent tree');
});

test('get_tokens and set_tokens work together', async () => {
  const before = jsonOf<{ tokens: { name: string; usage: string }[] }>(
    await client.callTool({ name: 'get_tokens', arguments: {} }),
  );
  assert.ok(before.tokens.find((t) => t.name === 'color.brand'));
  assert.equal(before.tokens.find((t) => t.name === 'color.brand')!.usage, 'var(--color-brand)');

  await client.callTool({
    name: 'set_tokens',
    arguments: { tokens: [{ name: 'color.accent', group: 'color', values: { default: '#f97316' } }] },
  });
  const after = jsonOf<{ tokens: { name: string }[] }>(await client.callTool({ name: 'get_tokens', arguments: {} }));
  assert.ok(after.tokens.find((t) => t.name === 'color.accent'));

  const bad = await client.callTool({
    name: 'set_tokens',
    arguments: { tokens: [{ name: 'color.bad', group: 'color', values: { dark: '#000' } }] },
  });
  assert.ok(isError(bad), 'a token without a default value must be rejected');
});

test('get_guide returns real guidance and rejects unknown topics', async () => {
  const layout = textOf(await client.callTool({ name: 'get_guide', arguments: { topic: 'layout' } }));
  assert.match(layout, /flexbox/i);
  const bad = await client.callTool({ name: 'get_guide', arguments: { topic: 'nope' } });
  assert.ok(isError(bad));
  assert.match(textOf(bad), /Available:/);
});

test('get_selection is empty and honest when no tab is connected', async () => {
  const res = jsonOf<{ liveTabConnected: boolean; selection: unknown[] }>(
    await client.callTool({ name: 'get_selection', arguments: {} }),
  );
  assert.equal(res.liveTabConnected, false);
  assert.equal(res.selection.length, 0);
});

test('get_computed_styles measures headlessly when no tab shows the page', async () => {
  const doc = getDocument(docId)!;
  const hero = Object.values(doc.nodes).find((n) => n.tag === 'section')!;
  const res = jsonOf<{
    source: string; note?: string;
    nodes: { authored: Record<string, string>; computed: { box: { width: number; height: number }; styles: Record<string, string> } | null }[];
  }>(await client.callTool({ name: 'get_computed_styles', arguments: { ids: [hero.id], properties: ['display'] } }));
  assert.equal(res.nodes[0]!.authored.display, 'flex');
  if (res.source === 'authored') return; // no renderer on this machine
  assert.equal(res.source, 'headless');
  assert.equal(res.nodes[0]!.computed!.styles.display, 'flex');
  assert.ok(res.nodes[0]!.computed!.box.width > 0);
});

test('stale node ids produce a recoverable error', async () => {
  const res = await client.callTool({ name: 'get_node_info', arguments: { id: 'n_doesnotexist' } });
  assert.ok(isError(res));
  assert.match(textOf(res), /get_tree_summary/, 'error should tell the agent how to get fresh ids');
});

test('delete_nodes reports the full subtree size', async () => {
  const doc = getDocument(docId)!;
  const dup = Object.values(doc.nodes).find((n) => n.name.endsWith('copy') || n.tag === 'section')!;
  const res = jsonOf<{ deleted: number; totalNodesRemoved: number }>(
    await client.callTool({ name: 'delete_nodes', arguments: { ids: [dup.id] } }),
  );
  assert.equal(res.deleted, 1);
  assert.ok(res.totalNodesRemoved > 1);
  assert.equal(getDocument(docId)!.nodes[dup.id], undefined);
});

test('agent edits are attributed in history', async () => {
  const res = await api(`/api/documents/${docId}/history`);
  const { history } = (await res.json()) as { history: { origin: { kind: string; label?: string } }[] };
  assert.ok(history.length > 0);
  assert.ok(history.some((h) => h.origin.kind === 'agent' && h.origin.label === 'Test Agent'));
});

test('start_working_on_nodes creates a restore point', async () => {
  const doc = getDocument(docId)!;
  const artboard = doc.pages[0]!.artboards[0]!;
  const res = jsonOf<{ marked: string[] }>(await client.callTool({
    name: 'start_working_on_nodes', arguments: { ids: [artboard], summary: 'Adding a footer' },
  }));
  assert.deepEqual(res.marked, [artboard]);

  const snaps = (await (await api(`/api/documents/${docId}/snapshots`)).json()) as
    { snapshots: { label: string }[] };
  assert.ok(snaps.snapshots.some((s) => s.label.includes('Adding a footer')));

  await client.callTool({ name: 'finish_working_on_nodes', arguments: { summary: 'Done' } });
});

test('rejects an invalid connection code without leaking why', async () => {
  const res = await fetch(`${base}/mcp/BOGUS-CODE-HERE-XXXX`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
  });
  assert.equal(res.status, 401);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /not valid/);
  assert.doesNotMatch(body.error, /expired|revoked|unknown/i);
});

test('screenshot explains itself when no backend is available', async () => {
  const doc = getDocument(docId)!;
  const artboard = doc.pages[0]!.artboards[0]!;
  const res = await client.callTool({ name: 'get_screenshot', arguments: { id: artboard } });
  const content = (res as { content: { type: string }[] }).content;
  if (isError(res)) {
    // No Playwright installed and no tab connected: the message must say what to do.
    assert.match(textOf(res), /Playwright|browser tab/);
  } else {
    assert.equal(content[0]!.type, 'image');
  }
});

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

test('create_component replaces the source with an instance', async () => {
  const doc = getDocument(docId)!;
  const artboard = doc.pages[0]!.artboards[0]!;

  const built = jsonOf<{ roots: { id: string }[] }>(await client.callTool({
    name: 'write_html',
    arguments: {
      targetId: artboard,
      html: `<div style="display:flex;padding:12px;background:#eee"><span>Reusable</span></div>`,
    },
  }));
  const source = built.roots[0]!.id;

  const created = jsonOf<{ componentId: string; instanceId: string; definitionRoot: string }>(
    await client.callTool({ name: 'create_component', arguments: { id: source, name: 'Chip' } }),
  );

  const after = getDocument(docId)!;
  assert.equal(after.nodes[source], undefined, 'the original subtree is replaced');
  assert.equal(after.nodes[created.instanceId]!.type, 'instance');
  assert.equal(after.components![created.componentId]!.name, 'Chip');
  // The definition lives in the document but on no page, so it is not on canvas.
  assert.ok(after.nodes[created.definitionRoot]);
  assert.ok(!after.pages[0]!.artboards.includes(created.definitionRoot));
});

test('list_components reports instances and structure', async () => {
  const out = jsonOf<{ components: { name: string; instances: number; structure: string }[] }>(
    await client.callTool({ name: 'list_components', arguments: {} }),
  );
  const chip = out.components.find((c) => c.name === 'Chip')!;
  assert.equal(chip.instances, 1);
  assert.match(chip.structure, /frame#/);
});

test('insert_instance and get_instance round-trip', async () => {
  const doc = getDocument(docId)!;
  const artboard = doc.pages[0]!.artboards[0]!;
  const list = jsonOf<{ components: { id: string }[] }>(await client.callTool({ name: 'list_components', arguments: {} }));
  const componentId = list.components[0]!.id;

  const inserted = jsonOf<{ created: string[] }>(await client.callTool({
    name: 'insert_instance', arguments: { componentId, parentId: artboard, count: 2 },
  }));
  assert.equal(inserted.created.length, 2);

  const info = jsonOf<{ overridableParts: { defId: string; type: string; text?: string }[] }>(
    await client.callTool({ name: 'get_instance', arguments: { id: inserted.created[0]! } }),
  );
  assert.ok(info.overridableParts.some((p) => p.type === 'text' && p.text === 'Reusable'));
});

test('set_override changes one instance only', async () => {
  const list = jsonOf<{ components: { id: string }[] }>(await client.callTool({ name: 'list_components', arguments: {} }));
  const componentId = list.components[0]!.id;
  const doc = getDocument(docId)!;
  const instances = Object.values(doc.nodes).filter((n) => n.componentRef === componentId);
  assert.ok(instances.length >= 2);

  const info = jsonOf<{ overridableParts: { defId: string; type: string }[] }>(
    await client.callTool({ name: 'get_instance', arguments: { id: instances[0]!.id } }),
  );
  const textPart = info.overridableParts.find((p) => p.type === 'text')!;

  await client.callTool({
    name: 'set_override',
    arguments: { updates: [{ instanceId: instances[0]!.id, defId: textPart.defId, text: 'Only this one' }] },
  });

  const first = jsonOf<{ overridableParts: { defId: string; text?: string }[] }>(
    await client.callTool({ name: 'get_instance', arguments: { id: instances[0]!.id } }),
  );
  const second = jsonOf<{ overridableParts: { defId: string; text?: string }[] }>(
    await client.callTool({ name: 'get_instance', arguments: { id: instances[1]!.id } }),
  );
  assert.equal(first.overridableParts.find((p) => p.defId === textPart.defId)!.text, 'Only this one');
  assert.equal(second.overridableParts.find((p) => p.defId === textPart.defId)!.text, 'Reusable');
});

test('set_override rejects a defId that is not in the definition', async () => {
  const doc = getDocument(docId)!;
  const instance = Object.values(doc.nodes).find((n) => n.type === 'instance')!;
  const res = await client.callTool({
    name: 'set_override',
    arguments: { updates: [{ instanceId: instance.id, defId: 'n_nope', text: 'x' }] },
  });
  assert.ok(isError(res));
  assert.match(textOf(res), /get_instance/);
});

test('editing the component updates every instance', async () => {
  const list = jsonOf<{ components: { id: string; root: string }[] }>(
    await client.callTool({ name: 'list_components', arguments: {} }),
  );
  const def = list.components[0]!;

  await client.callTool({
    name: 'update_styles',
    arguments: { updates: [{ id: def.root, styles: { 'border-radius': '999px' } }] },
  });

  const doc = getDocument(docId)!;
  const instance = Object.values(doc.nodes).find((n) => n.componentRef === def.id)!;
  const { html } = await import('@playground/shared').then((m) => m.emitHtml(doc, instance.id, { mode: 'inline' }));
  assert.match(html, /border-radius:999px/);
});

test('detach_instance bakes in overrides and drops the link', async () => {
  const doc = getDocument(docId)!;
  const instance = Object.values(doc.nodes).find((n) => n.type === 'instance' && n.overrides && Object.keys(n.overrides).length)!;
  const res = jsonOf<{ newRoot: string; nodeCount: number }>(
    await client.callTool({ name: 'detach_instance', arguments: { id: instance.id } }),
  );

  const after = getDocument(docId)!;
  assert.equal(after.nodes[instance.id], undefined);
  const root = after.nodes[res.newRoot]!;
  assert.equal(root.componentRef, undefined);
  const text = Object.values(after.nodes).find((n) => n.text === 'Only this one');
  assert.ok(text, 'the override survived detaching');
});

// ---------------------------------------------------------------------------
// Code components
// ---------------------------------------------------------------------------

const BUNDLE = 'export function mount(el, props) { el.textContent = props.label ?? "x"; }';

test('registering a code component stores the bundle as an asset', async () => {
  const res = jsonOf<{ id: string }>(await client.callTool({
    name: 'register_code_component',
    arguments: {
      name: 'Button', importPath: '@/components/Button', bundle: BUNDLE,
      sourcePath: 'components/Button.tsx',
      props: [
        { name: 'label', type: 'string', default: 'Button' },
        { name: 'variant', type: 'enum', values: ['primary', 'ghost'], default: 'primary' },
      ],
    },
  }));

  const component = getDocument(docId)!.codeComponents![res.id]!;
  assert.equal(component.name, 'Button');

  // The bundle has to be fetchable, or nothing renders on the canvas.
  const asset = await fetch(`${base}/assets/${component.bundle}`);
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get('content-type'), 'text/javascript');
  assert.equal(await asset.text(), BUNDLE);
});

test('a bundle without a mount export is refused', async () => {
  const res = await client.callTool({
    name: 'register_code_component',
    arguments: { name: 'Broken', importPath: '@/x', bundle: 'export const nope = 1;' },
  });
  assert.ok(isError(res));
  assert.match(textOf(res), /mount\(element, props\)/);
});

test('a minified bundle that aliases its export is accepted', async () => {
  const res = await client.callTool({
    name: 'register_code_component',
    arguments: { name: 'Minified', importPath: '@/m', bundle: 'function a(e,t){}export{a as mount};' },
  });
  assert.ok(!isError(res), textOf(res));
});

test('registering the same name twice needs an explicit replace', async () => {
  const dup = await client.callTool({
    name: 'register_code_component',
    arguments: { name: 'Button', importPath: '@/components/Button', bundle: BUNDLE },
  });
  assert.ok(isError(dup));
  assert.match(textOf(dup), /replace: true/);

  const replaced = jsonOf<{ updated: boolean }>(await client.callTool({
    name: 'register_code_component',
    arguments: {
      name: 'Button', importPath: '@/components/Button', bundle: BUNDLE, replace: true,
      props: [
        { name: 'label', type: 'string', default: 'Button' },
        { name: 'variant', type: 'enum', values: ['primary', 'ghost'], default: 'primary' },
      ],
    },
  }));
  assert.equal(replaced.updated, true);
});

test('placing an instance and setting props round-trips', async () => {
  const artboard = jsonOf<{ artboards: { id: string }[] }>(
    await client.callTool({ name: 'get_basic_info', arguments: {} }),
  ).artboards[0]!.id;

  const placed = jsonOf<{ id: string }>(await client.callTool({
    name: 'add_code_instance',
    arguments: { componentId: 'Button', parentId: artboard, props: { label: 'Save' } },
  }));

  const node = getDocument(docId)!.nodes[placed.id]!;
  assert.equal(node.type, 'code');
  assert.equal(node.props!.label, 'Save');

  await client.callTool({
    name: 'set_code_props', arguments: { id: placed.id, props: { variant: 'ghost' } },
  });
  const after = getDocument(docId)!.nodes[placed.id]!;
  assert.equal(after.props!.variant, 'ghost');
  assert.equal(after.props!.label, 'Save', 'props not mentioned keep their value');
});

test('an undeclared prop is refused rather than silently dropped', async () => {
  const artboard = jsonOf<{ artboards: { id: string }[] }>(
    await client.callTool({ name: 'get_basic_info', arguments: {} }),
  ).artboards[0]!.id;

  const res = await client.callTool({
    name: 'add_code_instance',
    arguments: { componentId: 'Button', parentId: artboard, props: { colour: 'red' } },
  });
  assert.ok(isError(res));
  assert.match(textOf(res), /does not declare/);
});

test('get_code_usage reports every instance with its real JSX', async () => {
  const usage = jsonOf<{ instances: { jsx: string }[] }>(
    await client.callTool({ name: 'get_code_usage', arguments: { componentId: 'Button' } }),
  );
  assert.ok(usage.instances.length >= 1);
  assert.match(usage.instances[0]!.jsx, /^<Button /);
});

test('unregistering refuses while instances are still placed', async () => {
  const res = await client.callTool({
    name: 'remove_code_component', arguments: { componentId: 'Button' },
  });
  assert.ok(isError(res));
  assert.match(textOf(res), /removeInstances: true/);

  const forced = jsonOf<{ instancesRemoved: number }>(await client.callTool({
    name: 'remove_code_component', arguments: { componentId: 'Button', removeInstances: true },
  }));
  assert.ok(forced.instancesRemoved >= 1);
  assert.equal(getDocument(docId)!.codeComponents!.Button, undefined);
});

test('embed_artifact places an Artifactory share link on its own artboard', async () => {
  const placed = jsonOf<{ id: string; artboardId: string; src: string }>(await client.callTool({
    name: 'embed_artifact', arguments: { url: 'https://art.example.com/#/s/abc123', name: 'Persona', width: 900, height: 700 },
  }));
  assert.equal(placed.src, 'https://art.example.com/#/e/abc123');
  const doc = getDocument(docId)!;
  const embed = doc.nodes[placed.id]!;
  assert.equal(embed.type, 'embed');
  assert.equal(embed.tag, 'iframe');
  assert.equal(embed.attrs.src, placed.src);
  assert.equal(embed.parent, placed.artboardId);
  assert.equal(doc.nodes[placed.artboardId]!.styles.width, '900px');
  assert.ok(doc.pages.some((p) => p.artboards.includes(placed.artboardId)));
});

test('embed_artifact refuses a link that is not a share link', async () => {
  const res = await client.callTool({ name: 'embed_artifact', arguments: { url: 'https://example.com/page' } });
  assert.ok(isError(res));
});

test('a new document can be seeded with HTML at a given artboard size', async () => {
  const res = await api('/api/documents', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'From Artifactory', html: '<div style="width:1800px">Hi</div>', width: 1840, height: 1200 }),
  });
  assert.equal(res.status, 201);
  const { document } = await res.json() as { document: { nodes: Record<string, { styles: Record<string, string>; children: string[] }>; pages: { artboards: string[] }[] } };
  const board = document.nodes[document.pages[0]!.artboards[0]!]!;
  assert.equal(board.styles.width, '1840px');
  assert.equal(board.styles.height, '1200px');
  assert.equal(board.children.length, 1);
});

// ---------------------------------------------------------------------------
// Gaps an agent hit building a whole app through MCP
// ---------------------------------------------------------------------------

type Call = <T>(tool: string, args?: Record<string, unknown>) => Promise<T>;
type Raw = (tool: string, args?: Record<string, unknown>) => Promise<unknown>;

/** A fresh document with its own agent connection, so a test cannot disturb the others. */
async function freshAgent(name: string): Promise<{ id: string; agent: Client; call: Call; raw: Raw }> {
  const id = (await createDocument(name)).id;
  const conn = await createConnection(id, `${name} agent`);
  const agent = new Client({ name: 'test', version: '1.0.0' });
  await agent.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${conn.code}`)));
  const raw: Raw = (tool, args = {}) => agent.callTool({ name: tool, arguments: args });
  const call: Call = async <T>(tool: string, args: Record<string, unknown> = {}): Promise<T> => {
    const res = await raw(tool, args);
    if (isError(res)) throw new Error(`${tool}: ${textOf(res)}`);
    return jsonOf<T>(res);
  };
  return { id, agent, call, raw };
}

test('update_note and delete_note edit and remove a note in place', async () => {
  const { id, agent, call, raw } = await freshAgent('Notes');
  const made = await call<{ id: string }>('create_note', { text: 'First', x: 10, y: 10 });
  const moved = await call<{ text: string; x: number; y: number; color: string }>(
    'update_note', { id: made.id, text: 'Second', x: 400, color: 'green' });
  assert.deepEqual([moved.text, moved.x, moved.y, moved.color], ['Second', 400, 10, 'green']);
  const note = getDocument(id)!.pages[0]!.notes!.find((n) => n.id === made.id)!;
  assert.equal(note.text, 'Second');
  assert.ok(isError(await raw('update_note', { id: made.id })), 'nothing to change is an error');
  await call('delete_note', { id: made.id });
  assert.equal(getDocument(id)!.pages[0]!.notes!.some((n) => n.id === made.id), false);
  assert.ok(isError(await raw('delete_note', { id: made.id })));
  await agent.close();
});

test('create_page starts empty unless asked, and the agent page is presence only', async () => {
  const { peersOf } = await import('./realtime.ts');
  const { id, agent, call } = await freshAgent('Pages');
  const empty = await call<{ pageId: string }>('create_page', { name: 'Flows' });
  assert.deepEqual(getDocument(id)!.pages.find((p) => p.id === empty.pageId)!.artboards, []);
  const withBoard = await call<{ pageId: string; artboardId: string }>('create_page', { name: 'Screens', withArtboard: true });
  assert.deepEqual(getDocument(id)!.pages.find((p) => p.id === withBoard.pageId)!.artboards, [withBoard.artboardId]);
  // The agent shows up as a peer on the page it moved to; nothing tells a tab to go there.
  const agentPeer = peersOf(id).find((p) => p.kind === 'agent');
  assert.equal(agentPeer?.pageId, withBoard.pageId);
  await agent.close();
});

test('fit_artboard sets the height to the rendered content', async () => {
  const { id, agent, call, raw } = await freshAgent('Fit');
  const board = getDocument(id)!.pages[0]!.artboards[0]!;
  await call('update_styles', { updates: [{ id: board, styles: { height: '2000px', display: 'block', padding: '0' } }] });
  await call('write_html', { targetId: board, html: '<div style="height:300px;margin:0">Tall</div><div style="height:100px">More</div>' });
  const res = await raw('fit_artboard', { id: board, padBottom: 20 });
  if (isError(res) && /renderer/.test(textOf(res))) { await agent.close(); return; }
  const fitted = jsonOf<{ from: number; to: number }>(res);
  assert.equal(fitted.from, 2000);
  assert.equal(fitted.to, 420);
  assert.equal(getDocument(id)!.nodes[board]!.styles.height, '420px');
  assert.ok(isError(await raw('fit_artboard', { id: getDocument(id)!.nodes[board]!.children[0]! })), 'only artboards');
  await agent.close();
});

test('replace_with_instance swaps built elements for instances, carrying text and styles', async () => {
  const { id, agent, call } = await freshAgent('Swap');
  const board = getDocument(id)!.pages[0]!.artboards[0]!;
  const def = await call<{ roots: { id: string }[] }>('write_html', {
    targetId: board, html: '<a href="#go" style="display:inline-flex;padding:8px"><span>Go</span></a>' });
  const component = await call<{ componentId: string; definitionRoot: string }>('create_component', { id: def.roots[0]!.id, name: 'Action' });

  const built = await call<{ roots: { id: string }[] }>('write_html', {
    targetId: board,
    html: '<a href="#save" style="display:inline-flex;padding:12px"><span>Save lead</span></a>'
      + '<div style="display:flex"><p>Other shape</p></div>',
  });
  const [same, other] = built.roots.map((r) => r.id);
  const index = getDocument(id)!.nodes[board]!.children.indexOf(same!);

  const res = await call<{ replaced: { from: string; id: string; unmapped: string[] }[]; ids: string[] }>(
    'replace_with_instance', { nodeIds: [same, other], componentId: component.componentId });
  const after = getDocument(id)!;
  assert.equal(after.nodes[same!], undefined, 'the original is gone');
  assert.equal(after.nodes[other!], undefined);
  const instance = after.nodes[res.ids[0]!]!;
  assert.equal(instance.type, 'instance');
  assert.equal(after.nodes[board]!.children[index], instance.id, 'same parent, same index');

  const defSpan = after.nodes[component.definitionRoot]!.children[0]!;
  assert.equal(instance.overrides![defSpan]!.text, 'Save lead');
  assert.equal(instance.overrides![component.definitionRoot]!.styles!.padding, '12px');
  assert.equal(instance.overrides![component.definitionRoot]!.attrs!.href, '#save');
  // A different shape still maps its text onto the definition's text part.
  assert.equal(after.nodes[res.ids[1]!]!.overrides![defSpan]!.text, 'Other shape');
  await agent.close();
});

test('insert_instance returns { id, ids }', async () => {
  const { id, agent, call } = await freshAgent('Insert');
  const board = getDocument(id)!.pages[0]!.artboards[0]!;
  const def = await call<{ roots: { id: string }[] }>('write_html', { targetId: board, html: '<span>Tag</span>' });
  const { componentId } = await call<{ componentId: string }>('create_component', { id: def.roots[0]!.id, name: 'Tag' });
  const res = await call<{ id: string; ids: string[] }>('insert_instance', { componentId, parentId: board, count: 2 });
  assert.equal(res.ids.length, 2);
  assert.equal(res.id, res.ids[0]);
  await agent.close();
});

test('connectors take waypoints in edit_board and write_diagram', async () => {
  const { agent, call } = await freshAgent('Routes');
  await call('edit_board', { changes: [
    { action: 'add', shape: { id: 'a', kind: 'rect', x: 3000, y: 0 } },
    { action: 'add', shape: { id: 'b', kind: 'rect', x: 3600, y: 0 } },
    { action: 'add', connector: { id: 'ab', from: { shape: 'a' }, to: { shape: 'b' }, waypoints: [{ x: 3300, y: 400 }] } },
  ] });
  type Board = { items: { id: string; path?: [number, number][] | null }[] };
  let board = await call<Board>('get_board');
  assert.ok(board.items.find((i) => i.id === 'ab')!.path!.some(([x, y]) => x === 3300 && y === 400));
  await call('edit_board', { changes: [{ action: 'update', id: 'ab', patch: { waypoints: null } }] });
  board = await call<Board>('get_board');
  assert.ok(!board.items.find((i) => i.id === 'ab')!.path!.some(([, y]) => y === 400), 'null restores automatic routing');

  const drawn = await call<{ ids: string[] }>('write_diagram', {
    nodes: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }],
    edges: [{ from: 'x', to: 'y', waypoints: [{ x: 9000, y: 9000 }] }],
  });
  board = await call<Board>('get_board');
  const edge = board.items.find((i) => drawn.ids.includes(i.id) && i.path)!;
  assert.ok(edge.path!.some(([x, y]) => x === 9000 && y === 9000));
  await agent.close();
});

test('write_html keeps class lists, and name_layers names layers without sampling', async () => {
  const { id, agent, call } = await freshAgent('Names');
  const board = getDocument(id)!.pages[0]!.artboards[0]!;
  const built = await call<{ roots: { id: string }[] }>('write_html', {
    targetId: board,
    html: '<div><button class="btn primary">Save lead</button></div>',
  });
  const button = Object.values(getDocument(id)!.nodes).find((n) => n.tag === 'button')!;
  assert.equal(button.attrs['data-class'], 'btn primary');

  const named = await call<{ source: string }>('name_layers', { id: board });
  assert.equal(named.source, 'fallback');
  assert.equal(getDocument(id)!.nodes[built.roots[0]!.id]!.name, 'Group · Save lead');
  const again = await call<{ renamed: number }>('name_layers', { id: board });
  assert.equal(again.renamed, 0, 'renamed layers are no longer generic');
  await agent.close();
});

test('tokens can alias other tokens and use groups of their own', async () => {
  const { id, agent, call, raw } = await freshAgent('Tokens');
  await call('set_tokens', { tokens: [
    { name: 'color.lime', group: 'color', values: { default: '#a3e635' } },
    { name: 'color.accent', group: 'color', values: { default: '{color.lime}' } },
    { name: 'motion.fast', group: 'motion', values: { default: '120ms' } },
  ] });
  assert.ok(isError(await raw('set_tokens', { tokens: [{ name: 'color.x', group: 'color', values: { default: '{color.nope}' } }] })),
    'an alias to nothing is refused');
  const doc = getDocument(id)!;
  assert.equal(doc.tokens.find((t) => t.name === 'motion.fast')!.group, 'motion');
  const { emitStandalone } = await import('@playground/shared');
  assert.match(emitStandalone(doc, doc.pages[0]!.artboards[0]!), /--color-accent: var\(--color-lime\)/);
  await agent.close();
});

test('a project connection lists and switches between the documents in the project', async () => {
  const project = (await (await api('/api/projects', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'App' }),
  })).json() as { project: { id: string } }).project;
  const first = (await createDocument('Screens')).id;
  const second = (await createDocument('Design system')).id;
  const outside = (await createDocument('Elsewhere')).id;
  for (const doc of [first, second]) {
    await api(`/api/documents/${doc}/project`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: project.id }),
    });
  }
  const made = await api(`/api/projects/${project.id}/connections`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'Builder', docId: first }),
  });
  assert.equal(made.status, 201);
  const { connection } = await made.json() as { connection: { code: string; docId: string; projectId: string } };
  assert.equal(connection.docId, first);
  assert.equal(connection.projectId, project.id);

  const agent = new Client({ name: 'test', version: '1.0.0' });
  await agent.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${connection.code}`)));
  const call = (name: string, args: Record<string, unknown> = {}) => agent.callTool({ name, arguments: args });

  const listed = jsonOf<{ documents: { id: string; current: boolean }[] }>(await call('list_documents'));
  assert.deepEqual(listed.documents.map((d) => d.id).sort(), [first, second].sort());
  assert.equal(listed.documents.find((d) => d.current)!.id, first);

  const switched = jsonOf<{ current: string; switched: boolean }>(await call('switch_document', { docId: second }));
  assert.deepEqual([switched.current, switched.switched], [second, true]);
  assert.equal(jsonOf<{ documentName: string }>(await call('get_basic_info')).documentName, 'Design system');
  assert.ok(isError(await call('switch_document', { docId: outside })), 'never outside the project');
  await agent.close();

  // The choice is stored: a new session on the same code starts where the last one left off.
  const again = new Client({ name: 'test', version: '1.0.0' });
  await again.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${connection.code}`)));
  assert.equal(jsonOf<{ documentName: string }>(await again.callTool({ name: 'get_basic_info', arguments: {} })).documentName, 'Design system');
  await again.close();

  // A document connection stays scoped to its document.
  const single = jsonOf<{ projectId: null; documents: unknown[] }>(await client.callTool({ name: 'list_documents', arguments: {} }));
  assert.equal(single.projectId, null);
  assert.equal(single.documents.length, 1);
  assert.ok(isError(await client.callTool({ name: 'switch_document', arguments: { docId: second } })));
});

test('sections: create, arrange, update membership and status, list, delete', async () => {
  const { id, agent, call, raw } = await freshAgent('Sections');
  const a = await call<{ id: string }>('create_artboard', { name: 'One', width: 390, height: 844, x: 0, y: 0 });
  const b = await call<{ id: string }>('create_artboard', { name: 'Two', width: 390, height: 844, x: 3000, y: 500 });
  const made = await call<{ id: string; screens: number; status: string }>(
    'create_section', { title: 'A - Onboarding', artboards: [a.id, b.id], arrange: true, gap: 80 });
  assert.equal(made.screens, 2);
  assert.equal(made.status, 'draft');
  const doc = getDocument(id)!;
  assert.equal(doc.nodes[b.id]!.attrs['data-x'], String(Number(doc.nodes[a.id]!.attrs['data-x']) + 390 + 80));
  assert.equal(doc.nodes[b.id]!.attrs['data-y'], doc.nodes[a.id]!.attrs['data-y']);

  const updated = await call<{ status: string; screens: number }>('update_section', { id: made.id, status: 'ready', remove: [b.id] });
  assert.deepEqual([updated.status, updated.screens], ['ready', 1]);
  // A second section claiming `a` takes it from the first.
  const other = await call<{ id: string }>('create_section', { title: 'B', artboards: [a.id] });
  const listed = await call<{ sections: { id: string; screens: number }[]; ungrouped: string[] }>('list_sections', {});
  assert.deepEqual(listed.sections.map((s) => s.screens), [0, 1]);
  assert.ok(listed.ungrouped.includes(b.id));

  const info = await call<{ sections: { id: string }[] }>('get_basic_info', {});
  assert.equal(info.sections.length, 2);
  const spec = await call<{ section?: { status: string } }>('get_spec', { id: a.id, measure: false, includeCode: false });
  assert.equal(spec.section?.status, 'draft');

  assert.ok(isError(await raw('create_section', { title: 'X', artboards: ['nope'] })));
  assert.ok(isError(await raw('update_section', { id: made.id })));
  await call('delete_section', { id: other.id });
  assert.equal(getDocument(id)!.pages[0]!.sections!.some((s) => s.id === other.id), false);
  await agent.close();
});

test('screen cards: a diagram on one page runs between artboards on another', async () => {
  const { id, agent, call, raw } = await freshAgent('Cross-page flows');
  const screensPage = getDocument(id)!.pages[0]!.id;
  const login = await call<{ id: string }>('create_artboard', { name: 'Login', width: 390, height: 844, x: 0, y: 0 });
  const home = await call<{ id: string }>('create_artboard', { name: 'Home', width: 390, height: 844, x: 600, y: 0 });
  const flowsPage = (await call<{ pageId: string }>('create_page', { name: 'User flows' })).pageId;

  const drawn = await call<{ ids: string[]; shapes: Record<string, string> }>('write_diagram', {
    pageId: flowsPage, direction: 'LR',
    nodes: [
      { id: 'start', label: 'Open app', kind: 'ellipse' },
      { id: 'login', label: 'Login', artboard: 'Login' },
      { id: 'home', label: 'Home', artboard: home.id },
    ],
    edges: [{ from: 'start', to: 'login' }, { from: 'login', to: 'home', label: 'signed in' }],
    groups: [{ label: 'Sign in', members: ['start', 'login', 'home'] }],
  });
  const page = getDocument(id)!.pages.find((p) => p.id === flowsPage)!;
  const cards = page.board!.filter((i) => i.type === 'shape' && i.kind === 'screen');
  assert.deepEqual(cards.map((c) => (c as { ref?: string }).ref).sort(), [home.id, login.id].sort());
  // The screens stayed on their own page.
  assert.deepEqual(getDocument(id)!.pages.find((p) => p.id === screensPage)!.artboards.slice(-2), [login.id, home.id]);
  const connectors = page.board!.filter((i) => i.type === 'connector');
  assert.ok(connectors.every((c) => c.type === 'connector' && c.from.kind === 'shape' && c.to.kind === 'shape'));

  type Item = { id: string; kind?: string; screen?: { id?: string; name?: string; pageId?: string; pageName?: string; missing?: boolean } };
  const board = await call<{ items: Item[] }>('get_board', { pageId: flowsPage });
  const loginCard = board.items.find((i) => i.kind === 'screen' && i.screen?.id === login.id)!;
  assert.deepEqual([loginCard.screen!.name, loginCard.screen!.pageId], ['Login', screensPage]);

  // edit_board: a connector end on another page's artboard reuses the card.
  const edited = await call<{ added: string[] }>('edit_board', {
    pageId: flowsPage,
    changes: [{ action: 'add', connector: { from: { artboard: 'Home' }, to: { artboard: 'Login' }, label: 'sign out' } }],
  });
  assert.equal(edited.added.length, 1, 'no new cards: both screens already have one');
  const added = await call<{ added: string[] }>('edit_board', {
    pageId: flowsPage,
    changes: [{ action: 'add', shape: { kind: 'screen', artboard: login.id, x: 0, y: 2000, id: 'again' } }],
  });
  assert.deepEqual(added.added, ['again']);
  assert.ok(isError(await raw('edit_board', { pageId: flowsPage, changes: [{ action: 'add', shape: { kind: 'screen', x: 0, y: 0 } }] })));

  // Deleting the screen leaves a missing card, not a crash.
  await call('delete_nodes', { ids: [home.id] });
  const after = await call<{ items: Item[] }>('get_board', { pageId: flowsPage });
  assert.ok(after.items.some((i) => i.kind === 'screen' && i.screen?.missing));
  const svg = textOf(await raw('get_board', { pageId: flowsPage, svg: true }));
  assert.match(svg, /Missing screen/);
  void drawn;

  // Section flows: the screens' section names the diagram on the other page.
  const diagram = page.board!.find((i) => i.type === 'shape' && i.kind === 'section')!;
  const section = await call<{ id: string; flows: { id: string; title: string; pageId: string }[] }>(
    'create_section', { title: 'Auth', artboards: [login.id], flows: [diagram.id], pageId: screensPage });
  assert.deepEqual(section.flows.map((f) => [f.id, f.title, f.pageId]), [[diagram.id, 'Sign in', flowsPage]]);
  const info = await call<{ sections: { flows?: { pageId: string }[] }[] }>('get_basic_info', { pageId: screensPage });
  assert.equal(info.sections[0]!.flows![0]!.pageId, flowsPage);
  const listed = await call<{ sections: { flows?: { title: string }[] }[] }>('list_sections', { pageId: screensPage });
  assert.equal(listed.sections[0]!.flows![0]!.title, 'Sign in');
  assert.ok(isError(await raw('update_section', { id: section.id, flows: ['nope'] })));
  await agent.close();
});

test('set_artboard_theme shows one artboard in a document theme', async () => {
  const { emitStandalone } = await import('@playground/shared');
  const { id, agent, call, raw } = await freshAgent('Themes');
  await call('set_tokens', { tokens: [{ name: 'color.surface', group: 'color', values: { default: '#fafafa', dark: '#101010' } }] });
  const a = await call<{ id: string }>('create_artboard', { name: 'Light', width: 390, height: 844 });
  const b = await call<{ id: string; theme?: string }>('create_artboard', { name: 'Dark', width: 390, height: 844, theme: 'dark' });
  assert.equal(b.theme, 'dark');
  assert.match(emitStandalone(getDocument(id)!, b.id), /:root \{[^}]*--color-surface: #101010/);
  assert.match(emitStandalone(getDocument(id)!, a.id), /:root \{[^}]*--color-surface: #fafafa/);

  await call('set_artboard_theme', { id: a.id, theme: 'dark' });
  assert.equal(getDocument(id)!.nodes[a.id]!.attrs['data-theme'], 'dark');
  const info = await call<{ artboards: { id: string; theme?: string }[] }>('get_basic_info', {});
  assert.equal(info.artboards.find((x) => x.id === a.id)!.theme, 'dark');
  await call('set_artboard_theme', { id: a.id, theme: 'default' });
  assert.equal(getDocument(id)!.nodes[a.id]!.attrs['data-theme'], undefined);

  assert.ok(isError(await raw('set_artboard_theme', { id: a.id, theme: 'sepia' })));
  assert.ok(isError(await raw('set_artboard_theme', { id: getDocument(id)!.nodes[a.id]!.children[0] ?? 'nope', theme: 'dark' })));
  await agent.close();
});

test('lint_design is a health check: selectors, clipping and themes, as JSON', async () => {
  const info = jsonOf<{ artboards: { id: string }[] }>(await client.callTool({ name: 'get_basic_info', arguments: {} }));
  const artboard = info.artboards[0]!.id;
  const spans = Array.from({ length: 20 }, (_, i) => `<span>${i}</span>`).join('');
  const written = jsonOf<{ warnings: string[]; roots: { id: string }[] }>(await client.callTool({
    name: 'write_html',
    arguments: {
      targetId: artboard,
      mode: 'insert-children',
      html: `<style>span { color: #333 } .nav span { color: red }</style>
        <div style="height:40px;overflow:hidden"><p style="font-size:16px;line-height:24px">${'Long copy that wraps. '.repeat(30)}</p></div>
        <div>${spans}</div>`,
    },
  }));
  assert.ok(written.warnings.some((w) => /"span" matched/.test(w)), 'write_html warns at once');
  assert.ok(written.warnings.some((w) => /"\.nav span" matched nothing/.test(w)));

  const report = jsonOf<{
    ok: boolean; coverage: { themes: string[] };
    findings: { rule: string; node: string; page: string | null; message: string }[];
  }>(await client.callTool({ name: 'lint_design', arguments: { rules: ['style-rule', 'overflow'] } }));
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((f) => f.rule === 'style-rule'));
  assert.ok(report.findings.every((f) => f.page), 'every finding names its page');
  const clipped = report.findings.find((f) => f.rule === 'overflow');
  if (clipped) assert.equal(getDocument(docId)!.nodes[clipped.node]!.styles.overflow, 'hidden');
  else console.log('# overflow not measured (no headless browser)');

  // Clean up so later tests see the artboard as before.
  await client.callTool({ name: 'delete_nodes', arguments: { ids: written.roots.map((r) => r.id) } });
});

test('set_version_state marks pages and sections; get_basic_info and list_sections report it', async () => {
  const info = jsonOf<{ pages: { id: string }[] }>(await client.callTool({ name: 'get_basic_info', arguments: {} }));
  const pageId = info.pages[0]!.id;
  const set = jsonOf<{ kind: string; version: { state: string } }>(
    await client.callTool({ name: 'set_version_state', arguments: { id: pageId, state: 'current' } }));
  assert.equal(set.kind, 'page');
  assert.equal(set.version.state, 'current');
  const after = jsonOf<{ pages: { id: string; version?: { state: string } }[] }>(await client.callTool({ name: 'get_basic_info', arguments: {} }));
  assert.equal(after.pages.find((p) => p.id === pageId)!.version!.state, 'current');

  const sec = jsonOf<{ id: string }>(await client.callTool({ name: 'create_section', arguments: { title: 'Old flow', artboards: [] } }));
  const sup = jsonOf<{ version: { state: string; reason: string } }>(await client.callTool({
    name: 'set_version_state', arguments: { id: sec.id, state: 'superseded', reason: 'Replaced after review' },
  }));
  assert.equal(sup.version.reason, 'Replaced after review');
  const listed = jsonOf<{ sections: { id: string; version?: { state: string } }[] }>(await client.callTool({ name: 'list_sections', arguments: {} }));
  assert.equal(listed.sections.find((s) => s.id === sec.id)!.version!.state, 'superseded');

  const bad = await client.callTool({ name: 'set_version_state', arguments: { id: sec.id, state: 'superseded', replacedBy: 'nope' } });
  assert.ok((bad as { isError?: boolean }).isError);
  await client.callTool({ name: 'set_version_state', arguments: { id: pageId, state: null } });
  await client.callTool({ name: 'delete_section', arguments: { id: sec.id } }).catch(() => {});
});
