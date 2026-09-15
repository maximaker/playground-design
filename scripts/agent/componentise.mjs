/**
 * Turns a foundations sheet's specimens into real components, and rewires the
 * rest of the document to use them.
 *
 *   node scripts/agent/componentise.mjs <base> <docId> [--dry]
 *
 * A foundations sheet that *shows* a button is a picture of a button. Every
 * other button in the document is then a copy that drifts on its own, and the
 * Components tab is empty while the lint reports fifty-five repeated subtrees.
 * This registers the specimens as components with variant properties, and
 * replaces every structurally identical copy elsewhere with an instance,
 * carrying its own text across as an override.
 *
 * Matching is on structure and styles, never on text: two buttons reading
 * "Book a review" and "See the work →" are the same button. A node whose styles
 * differ by so much as one declaration is left alone — a near-match quietly
 * restyled is worse than a copy left as a copy.
 *
 * The specimen is not automatically the source. In this document the sheet drew
 * its button as a <span> with no tap-target height while all fifteen real
 * buttons were anchors with one: the sheet was showing an older copy. So each
 * specimen is matched against the copies in the artboards, and the component is
 * built from the shape that is actually in use — which is the whole point of
 * asking for the sheet and the pages to be in sync.
 *
 * The pages must not move: every artboard's HTML is compared before and after,
 * and any difference outside the foundations sheet fails the run. The sheet
 * itself is allowed to change, because bringing it up to date is the job.
 */

import '../lib/session.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [base, docId, ...flags] = process.argv.slice(2);
const DRY = flags.includes('--dry');
if (!base || !docId) {
  console.log('usage: componentise.mjs <base> <docId> [--dry]');
  process.exit(1);
}

const raw = await (await fetch(`${base}/api/documents/${docId}/connections`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'componentise' }),
})).text();
const code = raw.match(/\/mcp\/([A-Z0-9-]+)/)?.[1];
if (!code) {
  console.error('  could not mint a connection code — is this account a member of the document?');
  console.error(' ', raw.slice(0, 200));
  process.exit(1);
}
const client = new Client({ name: 'componentise', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${code}`)));
const call = async (n, a = {}) => {
  const r = await client.callTool({ name: n, arguments: a });
  const t = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r.isError) throw new Error(`${n}: ${t}`);
  return t;
};
const doc = async () => (await (await fetch(`${base}/api/documents/${docId}`)).json()).document;

// ---------------------------------------------------------------------------
// Finding the specimens
// ---------------------------------------------------------------------------

let d = await doc();
const byText = (text) => Object.values(d.nodes).find((n) => n.text?.trim() === text);

/** The row of specimens under a titled panel in the foundations sheet. */
function panelRow(title) {
  const heading = byText(title);
  if (!heading) return null;
  const panel = d.nodes[heading.parent];
  const row = panel?.children.map((id) => d.nodes[id]).find((n) => n && n.id !== heading.id);
  return row ?? null;
}

const buttonsRow = panelRow('Buttons');
const tagsRow = panelRow('Tags');
const segRow = panelRow('Segmented control');
if (!buttonsRow || !tagsRow || !segRow) {
  console.error('  this document has no foundations sheet with Tags / Buttons / Segmented control panels');
  process.exit(1);
}

const [solidBtn, ghostBtn] = buttonsRow.children.map((id) => d.nodes[id]);
const [neutralTag, goodTag] = tagsRow.children.map((id) => d.nodes[id]);

/** The two specimen cards, which sit in the `pair` after the panels. */
const pair = Object.values(d.nodes).find((n) =>
  n.name === 'pair' && n.children.length === 2
  && n.children.every((id) => d.nodes[id]?.name === 'pair-card'));

console.log(`  specimens: ${[solidBtn, ghostBtn, neutralTag, goodTag].filter(Boolean).length} inline, ` +
  `${pair ? 2 : 0} cards, 1 segmented control`);

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

/**
 * What makes two nodes "the same thing".
 *
 * Tag, styles and child shape; never text, never ids, never names. Layer names
 * come from whatever wrote the HTML and are not part of what a reader sees.
 */
function signature(nodes, id) {
  const n = nodes[id];
  if (!n) return '';
  const styles = Object.entries(n.styles).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${v}`).join(';');
  const variants = (n.variants ?? []).map((v) =>
    `${v.selector}{${Object.entries(v.styles).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${k}:${x}`).join(';')}}`).join('');
  const attrs = Object.entries(n.attrs ?? {}).filter(([k]) => k !== 'href' && k !== 'id')
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join(',');
  const kids = n.children.map((c) => signature(nodes, c)).join('|');
  return `${n.type}/${n.tag ?? ''}[${styles}][${variants}][${attrs}](${kids})`;
}

/**
 * Every node of a subtree in document order.
 *
 * Copies are matched to the definition position by position: the structures are
 * identical by construction, so the nth node of one is the nth of the other.
 */
function walk(nodes, id, out = []) {
  const n = nodes[id];
  if (!n) return out;
  out.push(n);
  for (const c of n.children) walk(nodes, c, out);
  return out;
}

/**
 * The overrides that make an instance say what the copy said.
 *
 * Text and attributes both: the first run of this carried the text across and
 * not the links, so every button on the page ended up pointing at the
 * definition's own href. The artboard comparison caught it, which is what it is
 * there for.
 */
function overridesFor(defNodes, copyNodes) {
  const updates = [];
  for (const [i, def] of defNodes.entries()) {
    const copy = copyNodes[i];
    if (!copy) continue;
    const update = {};
    if (typeof copy.text === 'string' && copy.text !== def.text) update.text = copy.text;
    const attrs = {};
    for (const [k, v] of Object.entries(copy.attrs ?? {})) if (def.attrs?.[k] !== v) attrs[k] = v;
    // An attribute the copy does not have cannot be removed by an override, so
    // it stays — worth knowing, and so far never true in practice.
    if (Object.keys(attrs).length) update.attrs = attrs;
    if (Object.keys(update).length) updates.push({ defId: def.id, ...update });
  }
  return updates;
}

function subtreeIds(nodes, id, out = []) {
  out.push(id);
  for (const c of nodes[id]?.children ?? []) subtreeIds(nodes, c, out);
  return out;
}

// ---------------------------------------------------------------------------
// Before
// ---------------------------------------------------------------------------

const artboards = JSON.parse(await call('get_basic_info')).artboards;
const before = {};
for (const b of artboards) before[b.name] = await call('get_html', { id: b.id });

// The sheet is the one artboard allowed to change: it is what gets corrected.
const SHEET = artboards.find((b) => /foundation/i.test(b.name))?.name;

// ---------------------------------------------------------------------------
// Register the components
// ---------------------------------------------------------------------------

/** Style declarations that differ between a base node and a variant specimen. */
function styleDelta(baseNode, variantNode) {
  const delta = {};
  for (const [k, v] of Object.entries(variantNode.styles)) {
    if (baseNode.styles[k] !== v) delta[k] = v;
  }
  // A declaration the variant drops has to be restated, not left behind.
  for (const k of Object.keys(baseNode.styles)) {
    if (!(k in variantNode.styles)) delta[k] = 'initial';
  }
  return delta;
}

/**
 * Every distinct shape in the artboards, with the copies that have it.
 *
 * Built once, before anything is touched, so that "what is actually in use" is
 * measured against the document as the author left it.
 */
function shapeGroups(nodes, roots) {
  const groups = new Map();
  for (const root of roots) {
    for (const id of subtreeIds(nodes, root)) {
      if (id === root) continue;
      const sig = signature(nodes, id);
      const group = groups.get(sig) ?? { sig, ids: [], sample: id };
      group.ids.push(id);
      groups.set(sig, group);
    }
  }
  return groups;
}

/**
 * Whether `sample` is the same control as `specimen`, only newer.
 *
 * The test is that nothing *conflicts*: every declaration they share has the
 * same value, and the sample may add more. A button that gained `min-height`
 * and became an anchor passes; a tag with different padding and font size does
 * not — that is a second size of tag, not a newer copy of this one, and a
 * similarity score happily called it a match.
 */
function isNewerCopyOf(specimen, sample) {
  if (sample.children.length !== specimen.children.length) return false;
  for (const [k, v] of Object.entries(specimen.styles)) {
    if (k in sample.styles && sample.styles[k] !== v) return false;
  }
  // Something has to be different, or this is just another copy.
  const added = Object.keys(sample.styles).filter((k) => !(k in specimen.styles));
  return added.length > 0 || sample.tag !== specimen.tag;
}

/**
 * The shape a specimen is a picture of: the most-used group that is clearly the
 * same thing. Falls back to the specimen itself when nothing else looks like it.
 */
function currentShapeFor(nodes, specimen, groups, { sheetIds }) {
  let best = null;
  for (const group of groups.values()) {
    const sample = nodes[group.sample];
    if (!sample || sheetIds.has(group.sample)) continue;
    if (!isNewerCopyOf(specimen, sample)) continue;
    if (!best || group.ids.length > best.group.ids.length) best = { group };
  }
  return best;
}

const made = [];

async function componentise(sourceNode, name, description, variants = []) {
  if (!sourceNode) return null;
  const res = JSON.parse(await call('create_component', { id: sourceNode.id, name, description }));
  const entry = { name, ...res, variants: [] };

  if (variants.length) {
    await call('set_component_props', {
      componentId: res.componentId,
      props: [{ name: 'tone', values: [variants[0].base, ...variants.map((v) => v.value)], default: variants[0].base }],
    });
    for (const v of variants) {
      await call('set_variant', {
        componentId: res.componentId,
        match: { tone: v.value },
        overrides: [{ defId: res.definitionRoot, styles: v.styles }],
      });
      entry.variants.push(v.value);
    }
  }
  made.push(entry);
  console.log(`  + ${name}${entry.variants.length ? ` (tone: ${entry.variants.join(', ')})` : ''}`);
  return entry;
}

if (DRY) {
  console.log('  --dry: stopping before any change');
  await client.close();
  process.exit(0);
}

// Which shape is actually in use, per specimen.
const sheetNode = artboards.find((b) => b.name === SHEET);
const sheetIds = new Set(sheetNode ? subtreeIds(d.nodes, sheetNode.id) : []);
const groups = shapeGroups(d.nodes, d.pages.flatMap((p) => p.artboards));

/** Picks the source node for a component, and says so when it is not the specimen. */
function sourceFor(specimen, label) {
  if (!specimen) return null;
  const current = currentShapeFor(d.nodes, specimen, groups, { sheetIds });
  if (!current || current.group.ids.length === 0) return specimen;
  const sample = d.nodes[current.group.sample];
  if (signature(d.nodes, sample.id) === signature(d.nodes, specimen.id)) return specimen;
  const drifted = Object.keys({ ...specimen.styles, ...sample.styles })
    .filter((k) => specimen.styles[k] !== sample.styles[k]);
  console.log(`  ~ the sheet's ${label} is out of date against ${current.group.ids.length} in use: ` +
    `${specimen.tag} → ${sample.tag}, ${drifted.join(', ')}`);
  return sample;
}

const buttonSource = sourceFor(solidBtn, 'button');
const ghostSource = sourceFor(ghostBtn, 'ghost button');
const tagSource = sourceFor(neutralTag, 'tag');
const goodSource = sourceFor(goodTag, 'success tag');

const button = await componentise(buttonSource, 'Button', 'Pill button. Tone picks the surface it sits on.',
  ghostSource ? [{ base: 'solid', value: 'ghost', styles: styleDelta(buttonSource, ghostSource) }] : []);
const tag = await componentise(tagSource, 'Tag', 'Small pill label. Tone "good" is the success surface.',
  goodSource ? [{ base: 'neutral', value: 'good', styles: styleDelta(tagSource, goodSource) }] : []);

d = await doc();
const segmented = await componentise(d.nodes[segRow.id], 'Segmented control',
  'Three-way switch. The active item carries the chip shadow.');

let lightCard = null;
let inkCard = null;
if (pair) {
  d = await doc();
  const [lightId, inkId] = pair.children;
  lightCard = await componentise(d.nodes[lightId], 'Card — light', 'The neutral half of a pair: problem, evidence, tags.');
  d = await doc();
  inkCard = await componentise(d.nodes[inkId], 'Card — ink', 'The emphatic half. One per screen, at most.');
}

// The variant specimens are copies of a variant that now exists; replace them
// with instances so the sheet shows the component rather than a lookalike.
async function replaceWithVariant(target, component, tone) {
  if (!target || !component) return;
  d = await doc();
  const node = d.nodes[target.id];
  if (!node) return;
  const parent = d.nodes[node.parent];
  const index = parent.children.indexOf(node.id);
  const { created } = JSON.parse(await call('insert_instance', {
    componentId: component.componentId, parentId: parent.id, index,
  }));
  await call('set_instance_props', { updates: [{ instanceId: created[0], props: { tone } }] });
  const updates = overridesFor(walk(d.nodes, component.definitionRoot), walk(d.nodes, node.id))
    .map((u) => ({ instanceId: created[0], ...u }));
  if (updates.length) await call('set_override', { updates });
  await call('delete_nodes', { ids: [node.id] });
}

// When the component was sourced from a page copy, the specimens are still
// sitting in the sheet and are exactly what should become instances.
await replaceWithVariant(solidBtn.id === buttonSource?.id ? null : solidBtn, button, 'solid');
await replaceWithVariant(ghostBtn, button, 'ghost');
await replaceWithVariant(neutralTag.id === tagSource?.id ? null : neutralTag, tag, 'neutral');
await replaceWithVariant(goodTag, tag, 'good');

// ---------------------------------------------------------------------------
// Shapes the document repeats but the sheet never drew
// ---------------------------------------------------------------------------
//
// Reported, not registered. Componentising these automatically was tried and
// produced twenty-five components called things like Foot and Section head,
// then a second attempt with tighter rules still split one card into two
// components because the tablet copy differed by a declaration. Naming things
// is the part a person should do; counting them is the part worth automating.

/** Layer names that describe a box rather than a thing. */
const ANONYMOUS = /^(div|span|text|row|stack|col|wrap|sheet|page|section|foot|footer|head|nav|brand|hero|cards|steps|stats|list|pair|seg|panel|content|inner|main|body|grid|group|title|meta|links)$/i;

function reportRepeats(nodes, pages, componentRoots) {
  const inComponent = new Set(componentRoots.flatMap((r) => subtreeIds(nodes, r)));
  const groups = [...shapeGroups(nodes, pages.flatMap((p) => p.artboards)).values()]
    .filter((g) => g.ids.length >= 3 && !g.ids.some((id) => inComponent.has(id)))
    .filter((g) => {
      const n = nodes[g.sample];
      if (!n || n.type === 'instance' || n.children.length < 2) return false;
      if (ANONYMOUS.test(n.name ?? '')) return false;
      const st = n.styles ?? {};
      const surface = st.background || st['background-color'] || st.border || st['border-color'];
      return !!surface && !!st['border-radius'];
    })
    .sort((a, b) => b.ids.length - a.ids.length)
    .slice(0, 8);
  if (!groups.length) return;
  console.log('\n  shapes repeated in the pages that could also be components:');
  for (const g of groups) console.log(`    ${(nodes[g.sample].name ?? '?').padEnd(16)} ×${g.ids.length}`);
}

// ---------------------------------------------------------------------------
// Rewire the rest of the document
// ---------------------------------------------------------------------------

d = await doc();
const definitions = [button, tag, segmented, lightCard, inkCard].filter(Boolean);

/**
 * One entry per (component, tone): the signature a copy must have to be that
 * component, and the styles to expect on it.
 */
const wanted = [];
for (const c of definitions) {
  wanted.push({ component: c, tone: null, sig: signature(d.nodes, c.definitionRoot) });
  const def = d.components?.[c.componentId];
  for (const variant of def?.variants ?? []) {
    const tone = variant.match?.tone;
    if (!tone) continue;
    // A variant's copies carry the variant's styles inline, so the signature to
    // look for is the definition with that delta applied.
    const patched = structuredClone(d.nodes);
    const rootStyles = { ...patched[c.definitionRoot].styles };
    for (const [k, v] of Object.entries(variant.overrides?.[c.definitionRoot]?.styles ?? {})) {
      if (v === 'initial') delete rootStyles[k]; else rootStyles[k] = v;
    }
    patched[c.definitionRoot] = { ...patched[c.definitionRoot], styles: rootStyles };
    wanted.push({ component: c, tone, sig: signature(patched, c.definitionRoot) });
  }
}

const artboardIds = new Set(d.pages.flatMap((p) => p.artboards));
const definitionIds = new Set(Object.values(d.components ?? {}).flatMap((c) => subtreeIds(d.nodes, c.root)));

/** Candidates: everything inside an artboard, deepest first so a card is offered before its tags. */
const candidates = [];
for (const artboard of artboardIds) {
  for (const id of subtreeIds(d.nodes, artboard)) {
    if (id === artboard || definitionIds.has(id)) continue;
    candidates.push(id);
  }
}

const swaps = [];
const claimed = new Set();
for (const id of candidates) {
  if (claimed.has(id)) continue;
  const sig = signature(d.nodes, id);
  const match = wanted.find((w) => w.sig === sig);
  if (!match) continue;
  for (const inner of subtreeIds(d.nodes, id)) claimed.add(inner);
  swaps.push({ id, ...match });
}

console.log(`  ${swaps.length} copies elsewhere match a component`);
for (const c of definitions) {
  const n = swaps.filter((s) => s.component === c).length;
  if (n) console.log(`    ${c.name.padEnd(18)} ${n}`);
}

for (const swap of swaps) {
  d = await doc();
  const node = d.nodes[swap.id];
  if (!node) continue;
  const parent = d.nodes[node.parent];
  const index = parent.children.indexOf(node.id);
  const updates = overridesFor(walk(d.nodes, swap.component.definitionRoot), walk(d.nodes, swap.id));

  const { created } = JSON.parse(await call('insert_instance', {
    componentId: swap.component.componentId, parentId: parent.id, index,
  }));
  if (swap.tone) {
    await call('set_instance_props', { updates: [{ instanceId: created[0], props: { tone: swap.tone } }] });
  }
  if (updates.length) {
    await call('set_override', { updates: updates.map((u) => ({ instanceId: created[0], ...u })) });
  }
  await call('delete_nodes', { ids: [swap.id] });
}

// ---------------------------------------------------------------------------
// After: the page must not have moved
// ---------------------------------------------------------------------------

const after = {};
for (const b of JSON.parse(await call('get_basic_info')).artboards) {
  after[b.name] = await call('get_html', { id: b.id });
}

/**
 * The emitted class name for a node encodes its id, and an instance's id is not
 * the copy's — so a swap that changes nothing a reader can see still changes
 * `class="c-n_abc"` to `class="c-n_def--n_ghi"`. Comparing with those stripped
 * keeps the check about the page rather than about the ids in it.
 */
const normalise = (html) => html.replace(/ class="c-[^"]*"/g, '');

let drift = 0;
for (const [name, html] of Object.entries(before)) {
  const now = after[name];
  if (normalise(now ?? '') === normalise(html)) { console.log(`  = ${name}`); continue; }
  if (name === SHEET) {
    console.log(`  ~ ${name} updated to match what the pages use (${html.length} → ${now?.length ?? 0} chars)`);
    continue;
  }
  drift++;
  console.log(`  ! ${name} changed: ${html.length} → ${now?.length ?? 0} chars`);
  // Show the first line that differs, which is almost always enough to see why.
  const a = html.split('\n');
  const b = (now ?? '').split('\n');
  const at = a.findIndex((line, i) => line !== b[i]);
  if (at >= 0) {
    console.log(`      before: ${a[at]?.trim().slice(0, 120)}`);
    console.log(`      after : ${b[at]?.trim().slice(0, 120)}`);
  }
}

d = await doc();
reportRepeats(d.nodes, d.pages, Object.values(d.components ?? {}).map((c) => c.root));

const components = JSON.parse(await call('list_components')).components;
console.log(`\n  components: ${components.map((c) => `${c.name} ×${c.instances}`).join(', ')}`);
console.log(drift
  ? `\n  ${drift} artboard(s) render differently — review before keeping this`
  : '\n  every artboard emits byte-identical HTML');

await client.close();
process.exit(drift ? 1 : 0);
