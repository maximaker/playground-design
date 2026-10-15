/*
 * Server half of heymax connect: framework-agnostic helpers each app's own
 * /api/connect/* routes call. Node 18+ (global fetch), no dependencies.
 *
 * The browser only ever talks to its own app. Cross-app calls happen here,
 * server to server, carrying the person's heymax session cookie (SSO) and/or
 * a shared CONNECT_TOKEN. So there is no CORS and no third-party cookie to go
 * wrong, and a token works where SSO is off.
 */
import { timingSafeEqual } from 'node:crypto';
import { CONNECT_APPS, parseUri, orderGroups } from './connect.js';

export { parseUri, formatUri, orderGroups, CONNECT_APPS } from './connect.js';

const trim = (s) => (s || '').replace(/\/$/, '');

/**
 * Settings, read from env.
 *  CONNECT_ENABLED=true   turns everything on (off: every route 404s)
 *  CONNECT_TOKEN          shared secret between the four apps (optional with SSO)
 *  ID_URL / LINKS_URL     where the links store lives (identity service)
 *  CONNECT_<APP>_URL      override an app's address (local dev)
 */
export function connectConfig(env = process.env) {
  const linksUrl = trim(env.LINKS_URL || env.ID_URL || 'https://id.heymax.im');
  const base = (app) => trim(env[`CONNECT_${app.toUpperCase()}_URL`] || CONNECT_APPS[app].url);
  return {
    enabled: env.CONNECT_ENABLED === 'true',
    token: env.CONNECT_TOKEN || '',
    linksUrl,
    /** Where an app's /api/connect/* answers. Artifactory's is the identity service. */
    apiBase: (app) =>
      app === 'artifactory' ? trim(env.CONNECT_ARTIFACTORY_API_URL || linksUrl) : base(app),
    timeoutMs: Number(env.CONNECT_TIMEOUT_MS || 1500),
  };
}

/** True when `authorization` is `Bearer <CONNECT_TOKEN>`. Constant-time. */
export function bearerOk(authorization, token) {
  if (!token || !authorization) return false;
  const m = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!m) return false;
  const a = Buffer.from(m[1].trim());
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Only the heymax session cookie travels on: never an app's own cookies. */
export function heymaxCookie(cookieHeader) {
  const m = (cookieHeader || '').match(/(?:^|;\s*)((?:__Secure-)?heymax\.session_token)=([^;]+)/);
  return m ? `${m[1]}=${m[2]}` : '';
}

/** Headers for a server-to-server call made on behalf of this request. */
export function forwardHeaders(cookieHeader, cfg) {
  const h = { accept: 'application/json' };
  const c = heymaxCookie(cookieHeader);
  if (c) h.cookie = c;
  if (cfg.token) h.authorization = `Bearer ${cfg.token}`;
  return h;
}

async function getJson(url, init, timeoutMs) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
  if (res.status >= 300 && res.status < 400) throw new Error('not signed in there');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * ⌘K fan-out. `local(q)` searches this app in-process; the others are asked
 * over HTTP with a timeout each. An app that fails is reported, not fatal.
 * Returns { groups: [{ app, ok, results, error? }] } in the fixed order.
 */
export async function searchEverywhere({ self, q, apps, local, cookie, cfg, limit = 6 }) {
  const want = (apps?.length ? apps : Object.keys(CONNECT_APPS)).filter((a) => CONNECT_APPS[a]);
  const headers = forwardHeaders(cookie, cfg);
  const groups = await Promise.all(
    want.map(async (app) => {
      try {
        const results =
          app === self
            ? await local(q, limit)
            : (await getJson(`${cfg.apiBase(app)}/api/connect/search?q=${encodeURIComponent(q)}&limit=${limit}`, { headers }, cfg.timeoutMs)).results;
        return { app, ok: true, results: Array.isArray(results) ? results.slice(0, limit) : [] };
      } catch (e) {
        return { app, ok: false, results: [], error: String(e?.message || e) };
      }
    }),
  );
  return { groups: orderGroups(groups, self) };
}

/** Turn a pasted heymax page URL into a URI-less lookup, or a URI into its app. */
export function appForHref(href) {
  if (parseUri(href)) return parseUri(href).app;
  try {
    const host = new URL(href).hostname;
    if (host === 'id.heymax.im') return null;
    if (host === 'studio-os.heymax.im') return 'studio'; // Studio's old address
    return Object.entries(CONNECT_APPS).find(([, a]) => new URL(a.url).hostname === host)?.[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Unfurl: resolve a URI or heymax URL to a ConnectItem. Own items through
 * `local(ref)`; others through that app's /api/connect/item. null if unknown.
 */
export async function unfurl({ self, ref, local, cookie, cfg }) {
  const app = appForHref(ref);
  if (!app) return null;
  if (app === self) return local(ref);
  const headers = forwardHeaders(cookie, cfg);
  const key = parseUri(ref) ? 'uri' : 'url';
  try {
    return await getJson(`${cfg.apiBase(app)}/api/connect/item?${key}=${encodeURIComponent(ref)}`, { headers }, cfg.timeoutMs);
  } catch {
    return null;
  }
}

/**
 * Pass a links request through to the store. Returns { status, body }.
 * method GET (query `uri`), POST (body {from, to, kind}), DELETE (id).
 */
export async function proxyLinks({ method, uri, id, body, cookie, cfg }) {
  const headers = { ...forwardHeaders(cookie, cfg), 'content-type': 'application/json' };
  const url =
    method === 'GET'
      ? `${cfg.linksUrl}/api/links?uri=${encodeURIComponent(uri || '')}`
      : method === 'DELETE'
        ? `${cfg.linksUrl}/api/links/${encodeURIComponent(id || '')}`
        : `${cfg.linksUrl}/api/links`;
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      signal: AbortSignal.timeout(cfg.timeoutMs * 2),
      redirect: 'manual',
    });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { error: text.slice(0, 200) }; }
    return { status: res.status, body: json };
  } catch (e) {
    return { status: 503, body: { error: 'Links unavailable', detail: String(e?.message || e) } };
  }
}

/*
 * MCP: the same links, for agents. Every app's MCP server offers link_items,
 * list_links and unlink_items on top of these, server to server with
 * CONNECT_TOKEN (an agent has no browser cookie). Each returns
 * { ok: true, ... } or { ok: false, error } with a sentence to show.
 */

const OFF = { ok: false, error: 'Cross-app linking is off on this app (CONNECT_ENABLED is not true).' };

/** A URI or heymax page URL → ConnectItem, through this app or the item's own app. */
export async function resolveItem({ self, ref, local, cfg }) {
  return unfurl({ self, ref: String(ref || '').trim(), local, cookie: '', cfg });
}

/** Link two items (URIs or heymax URLs). kind `for` tags `from` with a Studio engagement `to`. */
export async function linkItems({ self, from, to, kind = 'relates', local, cfg }) {
  if (!cfg.enabled) return OFF;
  const [a, b] = await Promise.all([from, to].map((ref) => resolveItem({ self, ref, local, cfg })));
  if (!a) return { ok: false, error: `Could not find ${from}. Use a heymax:// URI or the item's page URL.` };
  if (!b) return { ok: false, error: `Could not find ${to}. Use a heymax:// URI or the item's page URL.` };
  if (kind === 'for' && !(b.app === 'studio' && b.type === 'engagement'))
    return { ok: false, error: 'A "for" link tags an item with a Studio engagement: put the engagement in `to`.' };
  const end = (x) => ({ uri: x.uri, title: x.title, url: x.url });
  const r = await proxyLinks({ method: 'POST', body: { from: end(a), to: end(b), kind }, cookie: '', cfg });
  if (r.status >= 300) return { ok: false, error: r.body?.error || `The links store answered ${r.status}.` };
  return { ok: true, id: r.body?.id, kind, from: a, to: b };
}

/** Everything linked to one item, both directions. */
export async function listItemLinks({ self, ref, local, cfg }) {
  if (!cfg.enabled) return OFF;
  const uri = parseUri(ref) ? ref : (await resolveItem({ self, ref, local, cfg }))?.uri;
  if (!uri) return { ok: false, error: `Could not find ${ref}.` };
  const r = await proxyLinks({ method: 'GET', uri, cookie: '', cfg });
  if (r.status >= 300) return { ok: false, error: r.body?.error || `The links store answered ${r.status}.` };
  return { ok: true, uri, links: r.body?.links ?? [] };
}

/** Remove one link by the id link_items or list_links gave. */
export async function unlinkItems({ id, cfg }) {
  if (!cfg.enabled) return OFF;
  const r = await proxyLinks({ method: 'DELETE', id, cookie: '', cfg });
  if (r.status >= 300) return { ok: false, error: r.body?.error || `The links store answered ${r.status}.` };
  return { ok: true, id };
}
