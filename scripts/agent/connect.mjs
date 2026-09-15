/**
 * A minimal MCP client, so this session can drive Playground the way any
 * connected agent does — same endpoint, same connection code, same tools.
 *
 * Kept as a module rather than a one-off script because instructions arrive one
 * at a time and re-minting a connection for each would be wasteful and would
 * clutter the document's connection list.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const BASE = process.env.PLAYGROUND_BASE ?? 'http://localhost:4000';
// One session file per host, so a local build and a deployed one do not
// overwrite each other's document id and connection code.
const SESSION = new URL(
  `./session${BASE.includes('localhost') ? '' : '.remote'}.json`,
  import.meta.url,
).pathname;

export async function session({ name = 'Agent brief', template = 'clean', fresh = false } = {}) {
  if (!fresh && existsSync(SESSION)) {
    return JSON.parse(readFileSync(SESSION, 'utf8'));
  }
  const res = await fetch(`${BASE}/api/documents`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, template }),
  });
  if (!res.ok) {
    // A failure here is almost always the server's storage, not the request.
    // Reading the body as text first means the real message survives even when
    // the response is not JSON at all.
    const body = await res.text();
    let detail = body;
    try { const parsed = JSON.parse(body); detail = parsed.detail ?? parsed.error ?? body; } catch { /* plain text */ }
    throw new Error(`${BASE} refused to create a document (${res.status}): ${detail}`);
  }
  const doc = await res.json();
  const conn = await (await fetch(`${BASE}/api/documents/${doc.document.id}/connections`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'Claude Code' }),
  })).json();

  const value = { base: BASE, docId: doc.document.id, url: conn.url, open: `${BASE}/d/${doc.document.id}` };
  writeFileSync(SESSION, JSON.stringify(value, null, 2));
  return value;
}

export async function connect(url) {
  const client = new Client({ name: 'claude-code', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return {
    client,
    /** Calls a tool and throws with the server's own message on failure. */
    async call(name, args = {}) {
      const res = await client.callTool({ name, arguments: args });
      const text = res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      if (res.isError) throw new Error(`${name}: ${text}`);
      return text;
    },
    close: () => client.close(),
  };
}
