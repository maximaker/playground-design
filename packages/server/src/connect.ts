/**
 * heymax connect (kit/docs/connect.md): Playground's half of the family-wide
 * search, unfurl and linked-work routes, under /api/connect/*.
 *
 * Mounted ahead of the API's auth gate and does its own auth, because the
 * contract also admits server-to-server calls carrying only
 * `Authorization: Bearer $CONNECT_TOKEN`, which that gate (owned by the SSO
 * work) does not know about. A signed-in person is checked exactly as the gate
 * checks them; a token-only caller acts as the instance owner.
 *
 * Everything 404s unless CONNECT_ENABLED=true, read per request.
 */

import { Hono, type Context } from 'hono';
import {
  bearerOk, connectConfig, formatUri, parseUri, proxyLinks, searchEverywhere, unfurl,
  type ConnectItem,
} from './kit-connect/server.mjs';
import { documentsFor } from './accounts.ts';
import { persistence, type StoredUser } from './persistence.ts';
import { listDocuments } from './store.ts';
import { listProjects } from './projects.ts';
import { userFromCookies } from './sso.ts';

const SELF = 'playground';

/** The address people open Playground at; every item URL is built on it. */
export function publicBase(): string {
  return (process.env.APP_URL || process.env.PLAYGROUND_PUBLIC_URL || 'https://playground.heymax.im').replace(/\/$/, '');
}

const subtitle = (s: string | undefined) => (s ? { subtitle: s } : {});
const iso = (ms: number | undefined) => (ms ? new Date(ms).toISOString() : null);

/** Who a token-only caller acts as: OWNER_EMAIL's account, else the oldest one. */
async function ownerUser(): Promise<StoredUser | null> {
  const store = await persistence();
  const email = process.env.OWNER_EMAIL?.trim().toLowerCase();
  if (email) {
    const u = await store.loadUserByEmail(email);
    if (u) return u;
  }
  const users = await store.listUsers();
  return users.sort((a, b) => a.createdAt - b.createdAt)[0] ?? null;
}

/** Documents this person may see: theirs, plus anything nobody owns (as GET /api/documents). */
async function visibleDocs(user: StoredUser) {
  const mine = await documentsFor(user.id);
  const owned = new Set((await (await persistence()).loadMemberships({})).map((m) => m.docId));
  return (await listDocuments()).filter((d) => mine.has(d.id) || !owned.has(d.id));
}

async function search(user: StoredUser, q: string, limit: number): Promise<ConnectItem[]> {
  const needle = q.trim().toLowerCase();
  const base = publicBase();
  const [docs, projects] = await Promise.all([visibleDocs(user), listProjects()]);
  const items: ConnectItem[] = [
    ...docs.map((d) => ({
      app: SELF, type: 'doc', id: d.id, uri: formatUri(SELF, 'doc', d.id),
      title: d.name, url: `${base}/d/${d.id}`, updated: iso(d.updatedAt),
      ...subtitle(projects.find((p) => p.id === d.projectId)?.name),
    })),
    ...projects.map((p) => ({
      app: SELF, type: 'project', id: p.id, uri: formatUri(SELF, 'project', p.id),
      title: p.name, url: `${base}/?project=${encodeURIComponent(p.id)}`, updated: iso(p.createdAt),
      subtitle: `${p.documentCount} document${p.documentCount === 1 ? '' : 's'}`,
    })),
  ];
  return items
    .filter((i) => !needle || i.title.toLowerCase().includes(needle))
    .sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''))
    .slice(0, limit);
}

/** A URI or one of our page URLs → { type, id }, or null. */
function refFor(ref: string): { type: string; id: string } | null {
  const p = parseUri(ref);
  if (p) return p.app === SELF ? { type: p.type, id: p.id } : null;
  try {
    const u = new URL(ref);
    const doc = /^\/d\/([\w-]+)/.exec(u.pathname);
    if (doc) return { type: 'doc', id: doc[1]! };
    const project = u.searchParams.get('project');
    if (project && (u.pathname === '/' || u.pathname === '')) return { type: 'project', id: project };
  } catch { /* not a URL */ }
  return null;
}

async function item(user: StoredUser, ref: string): Promise<ConnectItem | null> {
  const r = refFor(ref);
  if (!r) return null;
  const base = publicBase();
  if (r.type === 'doc') {
    const d = (await visibleDocs(user)).find((x) => x.id === r.id);
    return d ? {
      app: SELF, type: 'doc', id: d.id, uri: formatUri(SELF, 'doc', d.id),
      title: d.name, url: `${base}/d/${d.id}`, updated: iso(d.updatedAt),
    } : null;
  }
  if (r.type === 'project') {
    const p = (await listProjects()).find((x) => x.id === r.id);
    return p ? {
      app: SELF, type: 'project', id: p.id, uri: formatUri(SELF, 'project', p.id),
      title: p.name, url: `${base}/?project=${encodeURIComponent(p.id)}`, updated: iso(p.createdAt),
      subtitle: `${p.documentCount} document${p.documentCount === 1 ? '' : 's'}`,
    } : null;
  }
  return null;
}

type Vars = { user: StoredUser };
export const connect = new Hono<{ Variables: Vars }>();

connect.use('*', async (c, next) => {
  const cfg = connectConfig();
  if (!cfg.enabled) return c.json({ error: 'Not found' }, 404);
  // Browser-facing routes need SSO (Max, 2026-10-12): without ID_URL only
  // server-to-server search/item answer, so the panel and palette stay hidden.
  if (!process.env.ID_URL && /^\/(status|everywhere|unfurl|links)(\/|$)/.test(c.req.path.replace(/^.*\/connect/, ''))) return c.json({ error: 'Not found' }, 404);
  let user = await userFromCookies(c.req.header('cookie'));
  if (!user && bearerOk(c.req.header('authorization'), cfg.token)) user = await ownerUser();
  if (!user) return c.json({ error: 'Sign in to continue.', needsAuth: true }, 401);
  c.set('user', user);
  return next();
});

const limitOf = (c: Context) => Math.min(Math.max(Number(c.req.query('limit')) || 8, 1), 50);

connect.get('/status', (c) => c.json({ enabled: true, self: SELF }));

connect.get('/search', async (c) =>
  c.json({ results: await search(c.get('user'), c.req.query('q') ?? '', limitOf(c)) }));

connect.get('/item', async (c) => {
  const ref = c.req.query('uri') ?? c.req.query('url') ?? '';
  const found = await item(c.get('user'), ref);
  return found ? c.json(found) : c.json({ error: 'Not found' }, 404);
});

connect.get('/everywhere', async (c) => {
  const user = c.get('user');
  const apps = (c.req.query('apps') ?? '').split(',').map((a) => a.trim()).filter(Boolean);
  return c.json(await searchEverywhere({
    self: SELF, q: c.req.query('q') ?? '', apps: apps.length ? apps : undefined,
    local: (q, limit) => search(user, q, limit), cookie: c.req.header('cookie'), cfg: connectConfig(),
    limit: Math.min(Math.max(Number(c.req.query('limit')) || 6, 1), 50),
  }));
});

connect.get('/unfurl', async (c) => {
  const user = c.get('user');
  const found = await unfurl({
    self: SELF, ref: c.req.query('ref') ?? '', local: (ref) => item(user, ref),
    cookie: c.req.header('cookie'), cfg: connectConfig(),
  });
  return found ? c.json(found) : c.json({ error: 'Not found' }, 404);
});

const relay = (r: { status: number; body: unknown }, c: Context) =>
  c.json(r.body as object, r.status as 200);

connect.get('/links', async (c) =>
  relay(await proxyLinks({ method: 'GET', uri: c.req.query('uri'), cookie: c.req.header('cookie'), cfg: connectConfig() }), c));

connect.post('/links', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return relay(await proxyLinks({ method: 'POST', body, cookie: c.req.header('cookie'), cfg: connectConfig() }), c);
});

connect.delete('/links/:id', async (c) =>
  relay(await proxyLinks({ method: 'DELETE', id: c.req.param('id'), cookie: c.req.header('cookie'), cfg: connectConfig() }), c));
