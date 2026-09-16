/**
 * Put photographs in the placeholders an import leaves behind.
 *
 *   node scripts/agent/fill-images.mjs <docId> [base] [--list]
 *
 * An imported page keeps every image's box and none of its pictures — which is
 * right for fidelity and wrong for looking at. This fills those boxes with
 * photographs from Unsplash, chosen per band so the page reads as the page
 * rather than as a grid of grey rectangles.
 *
 * `--list` prints the placeholders it finds, in document order, with the text
 * around each one. That is the list PHOTOS is written against: node ids change
 * with every re-import, so the mapping is by page and position, and the script
 * refuses to guess if a page's count has changed.
 *
 * Only images.unsplash.com URLs are used — plus.unsplash.com is Unsplash+, and
 * a placeholder is not worth a licence. Each layer is renamed with its
 * photographer, because a credit that lives anywhere else is a credit that gets
 * lost.
 */

import '../lib/session.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const DOC = process.argv[2];
const BASE = process.argv.find((a) => a.startsWith('http')) ?? 'https://playground.thedigitalvitamins.com';
const LIST = process.argv.includes('--list');
if (!DOC) { console.error('usage: fill-images.mjs <docId> [base] [--list]'); process.exit(1); }

/** photo id → the picture, its author, and what it shows. */
const LIBRARY = {
  'hero-3': ['photo-1556746223-5aa9f4ce76df', 'Andriyko Podilnyk', 'a child’s hand in an adult’s'],
  'face-0': ['photo-1699899657680-421c2c2d5064', 'Giorgio Trovato', 'portrait, daylight'],
  'face-2': ['photo-1607990283143-e81e7a2c9349', 'Compagnons', 'a woman smiling, by a window'],
  'online-1': ['photo-1784109112573-6aeccd63c86c', 'Amrit Das', 'a woman by tall windows'],
  'online-2': ['photo-1761389294347-4e7b17731a5b', 'Toby Osborn', 'a woman in a bay window'],
  'online-4': ['photo-1681308838635-271a60b54c9e', 'Subhro Vision', 'looking out of a window'],
  'room-1': ['photo-1710698936989-500f359c6482', 'Max Tcvetkov', 'a hospital room with a chair'],
  'care-1': ['photo-1771414280104-58ae7ebb0d50', 'Hazel J', 'hands folded in a quiet room'],
  'care-2': ['photo-1763328709918-d18a45bd562f', 'Christian Agbede', 'two people talking, warm light'],
  'care-4': ['photo-1764974012597-ef8ee8c806f0', 'Karina Syrotiuk', 'hands around a mug'],
  'home-0': ['photo-1631510390389-c1e4fb20ff31', 'Spacejoy', 'a chair by a window'],
  'home-1': ['photo-1651407825801-eec2dcbd86bd', 'Annie Spratt', 'a living room with plants'],
  'home-2': ['photo-1657040899606-b22f17a6afd5', 'Christina Radevich', 'a sofa and plants'],
  'home-3': ['photo-1617202074052-fa303398aa00', 'Kate Darmody', 'a room in afternoon light'],
  'home-4': ['photo-1606202598125-e2077bb5ebcc', 'Laura Lauch', 'a room opening onto green'],
  'writing-1': ['photo-1708793669551-3a8334b814ed', 'Joonas Sild', 'paper and a pen on a table'],
  'writing-2': ['photo-1511871893393-82e9c16b81e3', 'JESHOOTS.COM', 'an open notebook'],
  'writing-3': ['photo-1723754166126-cadbccbe8820', 'Kelly Sikkema', 'a notebook on a desk'],
  'writing-4': ['photo-1708793763200-1d355d8b2c18', 'Joonas Sild', 'a page in dappled light'],
  'child-1': ['photo-1544773088-d142e38f5793', 'Jerry Wang', 'a child holding up a drawing'],
  'child-2': ['photo-1637195141546-2469a5312504', 'Stephen Andrews', 'a child drawing at a table'],
  'child-3': ['photo-1596464716127-f2a82984de30', 'Compagnons', 'crayons and paper from above'],
  'child-5': ['photo-1646617747566-b7e784435a48', 'Kelly Sikkema', 'a girl drawing with pencils'],
};

/** Per page, one photo for each placeholder, in the order `--list` prints them. */
const PHOTOS = {
  // Acasă: hero, the byline portrait, the online band, then the five tiles of
  // the gallery — a room at home, a hospital room, a mug, a drawing, a sofa.
  'Acasă': ['hero-3', 'face-0', 'online-2', 'home-4', 'home-1', 'room-1', 'care-4', 'child-1', 'home-3'],
  'Webinar': ['online-1', 'writing-2', 'home-0', 'writing-4'],
  'Program': ['care-1', 'writing-3', 'home-2'],
  'Despre': ['face-2', 'online-4', 'child-5'],
  // The last one is the portrait component again, and keeps the component's
  // own photograph — it is the same person on both pages.
  'Profesionisti': ['care-2', 'child-2', 'child-3', null],
  'Contact': ['writing-1'],
  'component:Portrait photo': 'face-2',
  'component:Photo placeholder': 'home-1',
};

const api = async (path, init) => {
  const res = await fetch(`${BASE}/api${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? null : res.json();
};

const { document: doc } = await api(`/documents/${DOC}`);
const PLACEHOLDER = /e7ded1|--color-line/;
const photoComponents = new Set(
  Object.entries(doc.components ?? {}).filter(([, c]) => /photo|portrait/i.test(c.name)).map(([id]) => id),
);
/** The box inside a photo component that carries the placeholder fill. */
const boxOf = (componentId) => {
  const stack = [doc.components[componentId].root];
  while (stack.length) {
    const n = doc.nodes[stack.pop()];
    if (!n) continue;
    if (PLACEHOLDER.test(n.styles?.['background-color'] ?? '')) return n.id;
    stack.push(...(n.children ?? []));
  }
  return null;
};

const textOf = (id, out = []) => {
  const n = doc.nodes[id];
  if (!n) return out;
  if (n.text) out.push(n.text);
  for (const k of n.children ?? []) textOf(k, out);
  return out;
};

/** Placeholders in document order, per page. */
const found = {};
for (const page of doc.pages) {
  const list = [];
  const walk = (id) => {
    const n = doc.nodes[id];
    if (!n) return;
    if (n.type === 'instance' && photoComponents.has(n.componentRef)) {
      list.push({ kind: 'instance', id, defId: boxOf(n.componentRef), context: textOf(n.parent).join(' ') });
    } else if (PLACEHOLDER.test(n.styles?.['background-color'] ?? '') && !(n.children ?? []).length) {
      list.push({ kind: 'node', id, context: textOf(n.parent).join(' ') });
    }
    for (const k of n.children ?? []) walk(k);
  };
  for (const board of page.artboards) walk(board);
  found[page.name] = list;
}

if (LIST) {
  for (const [page, list] of Object.entries(found)) {
    console.log(`\n${page}  (${list.length})`);
    for (const [i, p] of list.entries()) {
      const box = p.kind === 'instance' ? doc.nodes[p.defId] : doc.nodes[p.id];
      const size = `${box?.styles?.width ?? '?'}×${box?.styles?.height ?? box?.styles?.['aspect-ratio'] ?? '?'}`;
      console.log(`  ${String(i).padStart(2)} ${p.kind.padEnd(8)} ${size.padEnd(14)} ${JSON.stringify(p.context.slice(0, 56))}`);
    }
  }
  process.exit(0);
}

const raw = await (await fetch(`${BASE}/api/documents/${DOC}/connections`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'photographs' }),
})).text();
const client = new Client({ name: 'photographs', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/${raw.match(/\/mcp\/([A-Z0-9-]+)/)[1]}`)));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r.isError) throw new Error(`${name}: ${text}`);
  return text;
};

const fill = (key, width) => {
  const entry = LIBRARY[key];
  if (!entry) throw new Error(`no photo called "${key}"`);
  const [file] = entry;
  return {
    'background-image': `url("https://images.unsplash.com/${file}?w=${width}&q=70&auto=format&fit=crop")`,
    'background-size': 'cover',
    'background-position': 'center',
  };
};

const styleUpdates = [];
const overrides = [];
const renames = [];
let missing = 0;
for (const [page, list] of Object.entries(found)) {
  const wanted = PHOTOS[page] ?? [];
  if (wanted.length !== list.length) {
    console.log(`${page}: ${list.length} placeholders but ${wanted.length} photos listed — skipped`);
    missing++;
    continue;
  }
  for (const [i, p] of list.entries()) {
    const key = wanted[i];
    if (!key) continue;
    const box = p.kind === 'instance' ? doc.nodes[p.defId] : doc.nodes[p.id];
    const width = /^\d+px$/.test(box?.styles?.width ?? '') ? Math.max(320, parseInt(box.styles.width, 10) * 2) : 1200;
    const styles = fill(key, width);
    if (p.kind === 'instance') overrides.push({ instanceId: p.id, defId: p.defId, styles });
    else styleUpdates.push({ id: p.id, styles });
    renames.push({ id: p.id, name: `Photo — ${LIBRARY[key][2]} (Unsplash, ${LIBRARY[key][1]})` });
  }
}

// The component definitions too, so an instance nobody overrode is still a photograph.
for (const componentId of photoComponents) {
  const box = boxOf(componentId);
  const key = PHOTOS[`component:${doc.components[componentId].name}`];
  if (box && key) styleUpdates.push({ id: box, styles: fill(key, 1200) });
}

if (styleUpdates.length) await call('update_styles', { updates: styleUpdates });
for (let i = 0; i < overrides.length; i += 50) await call('set_override', { updates: overrides.slice(i, i + 50) });
if (renames.length) await call('rename_nodes', { updates: renames });
console.log(`${styleUpdates.length} boxes, ${overrides.length} instance overrides, ${renames.length} renamed`);
if (missing) console.log(`${missing} page(s) skipped`);
await client.close();
