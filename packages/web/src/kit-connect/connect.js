/*
 * The heymax connect vocabulary, shared by every app (browser and Node).
 *
 * Every item in the family has a URI, heymax://<app>/<type>/<id>. Links, tags
 * and search results carry URIs; each app turns its own URIs into page URLs.
 * See kit/docs/connect.md.
 */

export const CONNECT_APPS = {
  studio: { name: 'Studio', url: 'https://studio.heymax.im' },
  artifactory: { name: 'Artifactory', url: 'https://artifactory.heymax.im' },
  playground: { name: 'Playground', url: 'https://playground.heymax.im' },
  notes: { name: 'Notes', url: 'https://notes.heymax.im' },
};

/** Fixed group order in search: the app you are in first, then this order. */
export const APP_ORDER = ['studio', 'notes', 'artifactory', 'playground'];

/** Link kinds. `for` is a tag: an item belongs to a Studio client or engagement. */
export const KINDS = ['relates', 'for'];

const URI_RE = /^heymax:\/\/(studio|artifactory|playground|notes)\/([a-z-]+)\/([A-Za-z0-9_.:-]{1,128})$/;

export function parseUri(uri) {
  const m = typeof uri === 'string' ? uri.match(URI_RE) : null;
  return m ? { app: m[1], type: m[2], id: m[3] } : null;
}

export function formatUri(app, type, id) {
  return `heymax://${app}/${type}/${id}`;
}

export function appName(app) {
  return CONNECT_APPS[app]?.name ?? app;
}

/**
 * A search result / unfurl card. Every app's /api/connect/search and
 * /api/connect/item return this shape.
 * @typedef {{ app: string, type: string, id: string, uri: string, title: string,
 *   url: string, updated: string | null, subtitle?: string }} ConnectItem
 */

/** Grouped results in the fixed order, `self` first. */
export function orderGroups(groups, self) {
  const order = [self, ...APP_ORDER.filter((a) => a !== self)];
  return [...groups].sort((a, b) => order.indexOf(a.app) - order.indexOf(b.app));
}

/**
 * What to offer first when attaching work for an engagement: items already
 * tagged for or linked to it (as the links store returns them, newest first),
 * then items matching its client, newest first. No repeats; `skip(item)` drops
 * the item itself and what is already attached. Search results passed as
 * `found` keep their order but move the suggested ones to the top.
 */
export function rankSuggestions({ linked = [], sameClient = [], found, skip = () => false }) {
  const seen = new Set();
  const take = (list) => list.filter((it) => it?.uri && !skip(it) && !seen.has(it.uri) && seen.add(it.uri));
  const byRecent = (a, b) => String(b.updated ?? '').localeCompare(String(a.updated ?? ''));
  const suggested = [...take(linked.filter((l) => l.app !== 'studio')), ...take([...sameClient].sort(byRecent))];
  if (!found) return suggested;
  const want = new Set(suggested.map((s) => s.uri));
  const rest = found.filter((it) => !want.has(it.uri) && !skip(it));
  const hits = found.filter((it) => want.has(it.uri));
  return [...hits, ...rest];
}

/** The engagement an item is tagged for: its own `for` link, else one it inherits. */
export function engagementOf(links = []) {
  const tag = links.find((l) => l.kind === 'for' && l.direction === 'out' && !l.inherited) ?? links.find((l) => l.kind === 'for' && l.direction === 'out');
  return tag?.uri ?? null;
}
