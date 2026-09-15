/**
 * Accounts: sign-up, sign-in, and the gate in front of everything.
 *
 * The parts worth checking are the ones that are invisible when they are wrong.
 * A signed-out request that still returns a document, or a second account that
 * can open the first account's work, looks exactly like a working app.
 *
 * Run against a FRESH instance — it asserts on the first-account claim:
 *   rm -f /tmp/pg-auth.db && PLAYGROUND_DB=/tmp/pg-auth.db npm run dev:server
 *   node scripts/accounts-check.mjs
 */

import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = process.argv[2] ?? 'http://localhost:4000';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
};

/** A fetch that keeps one account's cookie, so two accounts can be held at once. */
function session() {
  let cookie = '';
  return {
    get cookie() { return cookie; },
    async call(path, init = {}) {
      const res = await fetch(`${BASE}${path}`, {
        ...init,
        headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers, cookie },
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return res;
    },
  };
}

const anon = session();
const alice = session();
const bob = session();

// --- Before anyone signs in --------------------------------------------------

const state = await (await anon.call('/api/auth/state')).json();
check('a fresh instance says it has no accounts', state.hasAccounts === false, JSON.stringify(state));
check('the library is closed to a stranger', (await anon.call('/api/documents')).status === 401);
check('so is one document', (await anon.call('/api/documents/doc_whatever')).status === 401);
check('health stays open, for uptime checks', (await anon.call('/api/health')).ok);

// --- The first account -------------------------------------------------------

const signup = await alice.call('/api/auth/signup', {
  method: 'POST',
  body: JSON.stringify({ email: 'alice@example.com', password: 'a-long-enough-password', name: 'Alice' }),
});
const created = await signup.json();
check('the first account is created', signup.status === 201, created.error ?? '');
check('and claims what was already here', created.claimed >= 1, `${created.claimed} document(s)`);

const short = await session().call('/api/auth/signup', {
  method: 'POST', body: JSON.stringify({ email: 'x@example.com', password: 'short' }),
});
check('a short password is refused', short.status === 400, (await short.json()).error);

const dupe = await session().call('/api/auth/signup', {
  method: 'POST', body: JSON.stringify({ email: 'ALICE@example.com', password: 'a-long-enough-password' }),
});
check('so is a duplicate address, whatever its case', dupe.status === 409);

const wrong = await session().call('/api/auth/login', {
  method: 'POST', body: JSON.stringify({ email: 'alice@example.com', password: 'not-the-password' }),
});
check('a wrong password is refused', wrong.status === 401);

// An unknown address and a wrong password must be indistinguishable, including
// in how long they take — the timing is what leaks which addresses exist.
const timed = async (email) => {
  const t = Date.now();
  await session().call('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ email, password: 'not-the-password' }),
  });
  return Date.now() - t;
};
const known = await timed('alice@example.com');
const unknown = await timed('nobody@example.com');
check('an unknown address answers as slowly as a wrong password',
  Math.abs(known - unknown) < Math.max(known, unknown) * 0.6, `${known}ms vs ${unknown}ms`);

// --- Ownership ----------------------------------------------------------------

const made = await (await alice.call('/api/documents', {
  method: 'POST', body: JSON.stringify({ name: 'Alice private' }),
})).json();
const docId = made.document.id;

const members = await (await alice.call(`/api/documents/${docId}/members`)).json();
check('the creator owns what they create',
  members.members[0]?.role === 'owner' && members.members[0]?.user.name === 'Alice');

await bob.call('/api/auth/signup', {
  method: 'POST', body: JSON.stringify({ email: 'bob@example.com', password: 'another-long-password', name: 'Bob' }),
});
check('a second account starts with an empty library',
  (await (await bob.call('/api/documents')).json()).documents.length === 0);

const peek = await bob.call(`/api/documents/${docId}`);
check("and cannot open someone else's document", peek.status === 404, `${peek.status}`);

const write = await bob.call(`/api/documents/${docId}/ops`, {
  method: 'POST', body: JSON.stringify({ ops: [] }),
});
check('nor write to it', write.status === 404 || write.status === 403, `${write.status}`);

// --- Sharing it on purpose -----------------------------------------------------

await alice.call(`/api/documents/${docId}/members`, {
  method: 'POST', body: JSON.stringify({ email: 'bob@example.com', role: 'viewer' }),
});
check('an invited viewer can read it', (await bob.call(`/api/documents/${docId}`)).ok);
const viewerWrite = await bob.call(`/api/documents/${docId}/ops`, {
  method: 'POST', body: JSON.stringify({ ops: [] }),
});
check('but still cannot write', viewerWrite.status === 403, `${viewerWrite.status}`);

await alice.call(`/api/documents/${docId}/members`, {
  method: 'POST', body: JSON.stringify({ email: 'bob@example.com', role: 'editor' }),
});
check('promoted to editor, the write goes through',
  (await bob.call(`/api/documents/${docId}/ops`, { method: 'POST', body: JSON.stringify({ ops: [] }) })).ok);

const bobDeletes = await bob.call(`/api/documents/${docId}`, { method: 'DELETE' });
check('an editor still cannot delete the document', bobDeletes.status === 403, `${bobDeletes.status}`);

const lastOwner = await alice.call(`/api/documents/${docId}/members/${created.user.id}`, { method: 'DELETE' });
check('the last owner cannot be removed', lastOwner.status === 400);

// --- Agents ---------------------------------------------------------------------

const connRes = await alice.call(`/api/documents/${docId}/connections`, {
  method: 'POST', body: JSON.stringify({ label: 'accounts check' }),
});
const code = (await connRes.text()).match(/\/mcp\/([A-Z0-9-]+)/)?.[1];
check('an owner can mint a connection code', !!code);

const mcp = new Client({ name: 'accounts-check', version: '1' });
await mcp.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/${code}`)));
const info = await mcp.callTool({ name: 'get_basic_info', arguments: {} });
check('and the agent works with no session of its own', !info.isError);
await mcp.close();

const anonMint = await anon.call(`/api/documents/${docId}/connections`, {
  method: 'POST', body: JSON.stringify({ label: 'nope' }),
});
check('a stranger cannot mint one', anonMint.status === 401, `${anonMint.status}`);

// --- The socket -------------------------------------------------------------------
//
// The API gate is decorative if the socket is open: every edit travels over the
// socket, not over REST.

const ws = await import('ws');
const joinAs = (cookie) => new Promise((resolve) => {
  const sock = new ws.WebSocket(`${BASE.replace('http', 'ws')}/ws`, { headers: cookie ? { cookie } : {} });
  sock.on('open', () => sock.send(JSON.stringify({ type: 'join', docId, clientId: 'check' })));
  sock.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.type === 'joined' || msg.type === 'error') { sock.close(); resolve(msg); }
  });
  sock.on('error', () => resolve({ type: 'error', message: 'socket failed' }));
});

const anonJoin = await joinAs(null);
check('the socket refuses an unauthenticated join', anonJoin.type === 'error', anonJoin.message ?? '');
const aliceJoin = await joinAs(alice.cookie);
check('and lets the owner in, named', aliceJoin.type === 'joined' && aliceJoin.peer?.name === 'Alice',
  aliceJoin.peer?.name ?? aliceJoin.message);
check('with their own stable colour, not a per-connection one',
  aliceJoin.peer?.color === created.user.color, `${aliceJoin.peer?.color}`);

// --- In the browser -----------------------------------------------------------------

const browser = await chromium.launch({ headless: true });
const view = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
view.on('pageerror', (e) => errors.push(e.message));
await view.goto(`${BASE}/`, { waitUntil: 'networkidle' });
check('a signed-out visitor gets the landing page', (await view.locator('.landing').count()) === 1);
check('with a sign-in form on it, not behind a button',
  (await view.locator('.auth-card input[type=password]').count()) === 1);

await view.fill('.auth-card input[type=email]', 'alice@example.com');
await view.fill('.auth-card input[type=password]', 'a-long-enough-password');
await view.click('.auth-card button[type=submit]');
await view.waitForSelector('.library, .home', { timeout: 15000 }).catch(() => {});
await view.waitForTimeout(1500);
check('signing in lands on the library', (await view.locator('.landing').count()) === 0);
check('and the account shows in the bar', (await view.locator('.account-button').count()) === 1);

await view.click('.account-button');
await view.waitForTimeout(300);
await view.click('.account-item');
await view.waitForTimeout(1500);
check('signing out returns to the landing page', (await view.locator('.landing').count()) === 1);
check('no runtime errors', errors.length === 0, errors[0] ?? '');

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} of ${results.length} checks failed` : `\nall ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
