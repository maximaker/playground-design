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

test('get_tree_summary is compact and includes the new content', async () => {
  const out = textOf(await client.callTool({ name: 'get_tree_summary', arguments: { depth: 6 } }));
  assert.match(out, /artboard#/);
  assert.match(out, /Ship faster/);
  assert.ok(out.split('\n').length < 20, 'summary should stay compact');
});

test('find_nodes locates by text and by type', async () => {
  const byText = textOf(await client.callTool({ name: 'find_nodes', arguments: { query: 'Ship faster' } }));
  assert.match(byText, /text#/);
  const byType = textOf(await client.callTool({ name: 'find_nodes', arguments: { type: 'artboard' } }));
  assert.match(byType, /artboard#/);
  const none = textOf(await client.callTool({ name: 'find_nodes', arguments: { query: 'nonexistent-xyz' } }));
  assert.match(none, /No matching nodes/);
});

test('update_styles batches and supports variant selectors', async () => {
  const hit = textOf(await client.callTool({ name: 'find_nodes', arguments: { tag: 'button' } }));
  const id = /text#(\S+)|frame#(\S+)/.exec(hit)?.[0].split('#')[1] ?? '';
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

test('get_computed_styles falls back to authored styles without a tab', async () => {
  const doc = getDocument(docId)!;
  const hero = Object.values(doc.nodes).find((n) => n.tag === 'section')!;
  const res = jsonOf<{ note?: string; nodes: { authored: Record<string, string> }[] }>(
    await client.callTool({ name: 'get_computed_styles', arguments: { ids: [hero.id] } }),
  );
  assert.match(res.note ?? '', /No browser tab/);
  assert.equal(res.nodes[0]!.authored.display, 'flex');
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
  const res = await fetch(`${base}/api/documents/${docId}/history`);
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

  const snaps = (await (await fetch(`${base}/api/documents/${docId}/snapshots`)).json()) as
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
