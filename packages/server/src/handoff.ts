/**
 * Handoff sites.
 *
 * A read-only spec site for a whole document or one section, at /h/<slug>, for
 * the developer or client who has no account and should not need one: screens
 * grouped by section with their status and flow card, the flow diagrams, the
 * tokens, the decisions log and the handover annotations.
 *
 * Like a published page it is rendered from the document on every request, so
 * the link keeps up with the work. It is stored as a share with the role
 * `handoff` — a revocable token resolved on the server — but it never opens the
 * editor: a share-link viewer and a handoff reader are different credentials.
 */

import { randomBytes } from 'node:crypto';
import {
  type CanvasDocument, type NodeId, type Page, type Section,
  SECTION_STATUS_META, decisionsOf, describeDecision, emitBoardSvg, emitStandalone, getArtboardSize,
  sectionFlows, sectionsOf, descendants, NOTE_KIND_LABELS, cssVarName, fontFamiliesIn, googleFontsHref,
} from '@playground/shared';
import { persistence, type StoredShare } from './persistence.ts';
import { ensureLoaded, getDocument } from './store.ts';
import { slugify } from './publish.ts';

export type HandoffScope = { kind: 'document' } | { kind: 'section'; sectionId: string };

export interface Handoff {
  slug: string;
  docId: string;
  scope: HandoffScope;
  createdAt: number;
  lastUsedAt: number | null;
}

function scopeOf(s: StoredShare): HandoffScope {
  try {
    const parsed = JSON.parse(s.label ?? '') as HandoffScope;
    if (parsed?.kind === 'section' && parsed.sectionId) return parsed;
  } catch { /* fall through */ }
  return { kind: 'document' };
}

function toHandoff(s: StoredShare): Handoff {
  return { slug: s.token, docId: s.docId, scope: scopeOf(s), createdAt: s.createdAt, lastUsedAt: s.lastUsedAt };
}

/** The section and its page, wherever it is in the document. */
export function findSection(doc: CanvasDocument, sectionId: string): { page: Page; section: Section } | null {
  for (const page of doc.pages) {
    const section = sectionsOf(page).find((s) => s.id === sectionId);
    if (section) return { page, section };
  }
  return null;
}

export async function listHandoffs(docId: string): Promise<Handoff[]> {
  const store = await persistence();
  return (await store.loadShares(docId)).filter((s) => s.role === 'handoff' && !s.revoked).map(toHandoff);
}

/**
 * Publishes (or returns the existing) handoff for this scope. One live link per
 * scope: publishing the same scope again keeps the address people already have.
 */
export async function publishHandoff(doc: CanvasDocument, scope: HandoffScope): Promise<Handoff> {
  if (scope.kind === 'section' && !findSection(doc, scope.sectionId)) {
    throw new Error(`No section "${scope.sectionId}". Call list_sections.`);
  }
  const key = JSON.stringify(scope);
  const existing = (await listHandoffs(doc.id)).find((h) => JSON.stringify(h.scope) === key);
  if (existing) return existing;
  const name = scope.kind === 'section' ? findSection(doc, scope.sectionId)!.section.title : doc.name;
  // Readable, but not guessable: the name says what it is, the suffix keeps it private.
  const slug = `${slugify(name).slice(0, 40)}-${randomBytes(6).toString('base64url').replace(/[-_]/g, 'x').toLowerCase()}`;
  const share: StoredShare = {
    token: slug, docId: doc.id, role: 'handoff', label: key,
    createdAt: Date.now(), lastUsedAt: null, revoked: false,
  };
  await (await persistence()).saveShare(share);
  return toHandoff(share);
}

/** Withdraws handoffs: one by slug, or every one for the document. */
export async function unpublishHandoff(docId: string, slug?: string): Promise<number> {
  const store = await persistence();
  let n = 0;
  for (const s of await store.loadShares(docId)) {
    if (s.role !== 'handoff' || s.revoked || (slug && s.token !== slug)) continue;
    await store.saveShare({ ...s, revoked: true });
    n++;
  }
  return n;
}

export async function resolveHandoff(slug: string): Promise<{ handoff: Handoff; doc: CanvasDocument } | null> {
  if (!slug || slug.length > 64) return null;
  const store = await persistence();
  const found = await store.loadShare(slug);
  if (!found || found.revoked || found.role !== 'handoff' || found.token !== slug) return null;
  await ensureLoaded(found.docId);
  const doc = getDocument(found.docId);
  if (!doc) return null;
  if (!found.lastUsedAt || Date.now() - found.lastUsedAt > 60_000) {
    void store.saveShare({ ...found, lastUsedAt: Date.now() }).catch(() => {});
  }
  return { handoff: toHandoff(found), doc };
}

interface Group { page: Page; section: Section | null; artboards: NodeId[] }

/** What the handoff shows, in reading order. */
export function handoffGroups(doc: CanvasDocument, scope: HandoffScope): Group[] {
  if (scope.kind === 'section') {
    const hit = findSection(doc, scope.sectionId);
    return hit ? [{ page: hit.page, section: hit.section, artboards: hit.section.artboards.filter((a) => doc.nodes[a]) }] : [];
  }
  const groups: Group[] = [];
  for (const page of doc.pages) {
    const sections = sectionsOf(page);
    const seen = new Set<NodeId>();
    for (const section of sections) {
      const boards = section.artboards.filter((a) => doc.nodes[a]);
      boards.forEach((a) => seen.add(a));
      groups.push({ page, section, artboards: boards });
    }
    const rest = page.artboards.filter((a) => !seen.has(a) && doc.nodes[a]?.type === 'artboard');
    if (rest.length) groups.push({ page, section: null, artboards: rest });
  }
  return groups;
}

export function handoffAllows(doc: CanvasDocument, scope: HandoffScope, artboardId: NodeId): boolean {
  return handoffGroups(doc, scope).some((g) => g.artboards.includes(artboardId));
}

/** One screen as a standalone page, for the frames on the handoff. */
export function handoffScreenHtml(doc: CanvasDocument, artboardId: NodeId): string {
  return emitStandalone(doc, artboardId, { mode: 'stylesheet' });
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function handoffHtml(doc: CanvasDocument, handoff: Handoff, base: string): string {
  const groups = handoffGroups(doc, handoff.scope);
  const boards = new Set(groups.flatMap((g) => g.artboards));
  const title = handoff.scope.kind === 'section'
    ? `${findSection(doc, handoff.scope.sectionId)?.section.title ?? 'Section'} · ${doc.name}`
    : doc.name;
  const SHOT = 320;
  const SHEET = 640;

  // The document's own type and accent, so the site reads as this project and not a generic spec.
  const firstBoard = groups.find((g) => g.artboards.length)?.artboards[0];
  const families = firstBoard ? fontFamiliesIn(doc, firstBoard) : [];
  const fontHref = googleFontsHref(families.slice(0, 2));
  const fontStack = families[0] ? `"${families[0].replace(/"/g, '')}",` : '';
  const accentToken = doc.tokens.find((t) => t.group === 'color' && /(^|\.)(brand|accent|primary)$/.test(t.name))
    ?? doc.tokens.find((t) => t.group === 'color' && /brand|accent|primary|lime/.test(t.name));
  const accent = accentToken?.values.default ?? '';
  const safeAccent = /^#[0-9a-f]{3,8}$/i.test(accent) ? accent : '';
  const isSheet = (id: NodeId) => getArtboardSize(doc.nodes[id]!).width >= 1000;

  const screen = (id: NodeId) => {
    const n = doc.nodes[id]!;
    const { width, height } = getArtboardSize(n);
    const scale = Math.min(1, (width >= 1000 ? SHEET : SHOT) / Math.max(1, width));
    const h = Math.round(Math.min(height, 4000) * scale);
    return `<figure class="screen"><a href="${base}/screen/${encodeURIComponent(id)}" target="_blank" rel="noopener" class="frame" style="width:${Math.round(width * scale)}px;height:${h}px">`
      + `<iframe loading="lazy" src="${base}/screen/${encodeURIComponent(id)}" title="${esc(n.name)}" tabindex="-1" `
      + `style="width:${width}px;height:${Math.min(height, 4000)}px;transform:scale(${scale})"></iframe></a>`
      + `<figcaption>${esc(n.name)} <span>${Math.round(width)}×${Math.round(height)}</span></figcaption></figure>`;
  };

  const ordered = [...groups.filter((g) => !g.section && g.artboards.length && g.artboards.every(isSheet)),
    ...groups.filter((g) => g.section || !g.artboards.length || !g.artboards.every(isSheet))];
  const sectionHtml = ordered.map((g) => {
    const s = g.section;
    const meta = s ? SECTION_STATUS_META[s.status] : null;
    const card = s?.flowCard;
    // Unsectioned frames: wide ones are the brief, research and docs a newcomer should read first.
    const fallback = g.artboards.length && g.artboards.every(isSheet) ? 'Brief & docs' : g.page.name.replace(/^\d+\s*/, '');
    const flows = s ? sectionFlows(doc, s) : [];
    return `<section class="group">
  <header>
    <p class="eyebrow">${esc(g.page.name)}</p>
    <h2>${card?.code ? `<span class="code">${esc(card.code)}</span> ` : ''}${esc(card?.title || s?.title || fallback)}</h2>
    ${meta ? `<span class="status" style="background:${meta.bg};color:${meta.fg}">${esc(meta.label)}</span>` : ''}
  </header>
  ${s?.description ? `<p class="desc">${esc(s.description)}</p>` : ''}
  ${card && (card.role || card.persona || card.goal || card.feedback?.length) ? `<dl class="card">
    ${card.role ? `<dt>Role</dt><dd>${esc(card.role)}</dd>` : ''}
    ${card.persona ? `<dt>Persona</dt><dd>${esc(card.persona)}</dd>` : ''}
    ${card.goal ? `<dt>Goal</dt><dd>${esc(card.goal)}</dd>` : ''}
    ${card.feedback?.length ? `<dt>Open feedback</dt><dd><ul>${card.feedback.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></dd>` : ''}
  </dl>` : ''}
  ${flows.length ? `<p class="flows">Flows: ${flows.map((f) => `<a href="#flows-${esc(f.pageId)}">${esc(f.title)}</a>`).join(', ')}</p>` : ''}
  <div class="screens">${g.artboards.map(screen).join('') || '<p class="empty">No screens yet.</p>'}</div>
</section>`;
  }).join('\n');

  // Flow diagrams: every page a section in scope links a flow on.
  const flowPages = new Map<string, Page>();
  for (const g of groups) for (const f of g.section ? sectionFlows(doc, g.section) : []) {
    const p = doc.pages.find((x) => x.id === f.pageId);
    if (p) flowPages.set(p.id, p);
  }
  const flowsHtml = [...flowPages.values()].map((p) =>
    `<figure class="flow" id="flows-${esc(p.id)}"><figcaption>${esc(p.name)}</figcaption>${emitBoardSvg(doc, p)}</figure>`).join('');

  const tokens = doc.tokens.map((t) => {
    const v = t.values.default ?? Object.values(t.values)[0] ?? '';
    const swatch = t.group === 'color' ? `<i style="background:${esc(v)}"></i>` : '';
    const themes = Object.entries(t.values).filter(([k]) => k !== 'default').map(([k, x]) => `${esc(k)}: ${esc(x)}`).join(' · ');
    return `<tr><td>${swatch}<code>${esc(cssVarName(t.name))}</code></td><td>${esc(v)}</td><td class="muted">${themes}</td></tr>`;
  }).join('');

  const decisions = decisionsOf(doc)
    .filter((d) => handoff.scope.kind === 'document' || (d.nodeId && [...boards].some((b) => b === d.nodeId || descendants(doc, b).includes(d.nodeId!))))
    .map((d) => describeDecision(doc, d));

  const inScope = (nodeId: NodeId | undefined) => !!nodeId && [...boards].some((b) => b === nodeId || descendants(doc, b).includes(nodeId));
  const notes = (doc.comments ?? []).filter((c) => (c.kind ?? 'comment') !== 'comment' && inScope(c.nodeId));

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} — handoff</title>
${fontHref ? `<link rel="stylesheet" href="${esc(fontHref)}">` : ''}
<style>
  :root { --bg:#fafafa; --fg:#18181b; --muted:#71717a; --line:#e4e4e7; --card:#fff; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111113; --fg:#f4f4f5; --muted:#a1a1aa; --line:#2a2a2e; --card:#18181b; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 ${fontStack}system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { max-width:1200px; margin:0 auto; padding:32px 16px 96px; }
  nav { display:flex; gap:16px; flex-wrap:wrap; font-size:14px; margin:8px 0 32px; }
  nav a { color:var(--muted); }
  ${safeAccent ? `.accent-bar { height:6px; width:56px; border-radius:99px; background:${safeAccent}; margin-bottom:16px; }` : '.accent-bar { display:none; }'}
  h1 { font-size:28px; margin:0; letter-spacing:-.01em; }
  h2 { font-size:20px; margin:0; }
  h3 { font-size:16px; margin:40px 0 12px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); }
  .group { border-top:1px solid var(--line); padding:28px 0; }
  .group header { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
  .eyebrow { width:100%; margin:0; font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.06em; }
  .code { color:var(--muted); font-weight:500; }
  .status { font-size:12px; font-weight:600; padding:2px 8px; border-radius:99px; }
  .desc { color:var(--muted); max-width:70ch; }
  .card { display:grid; grid-template-columns:max-content 1fr; gap:4px 16px; background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 16px; max-width:720px; font-size:14px; }
  .card dt { color:var(--muted); } .card dd { margin:0; } .card ul { margin:0; padding-left:18px; }
  .screens { display:flex; flex-wrap:wrap; gap:24px; margin-top:20px; }
  .screen { margin:0; }
  .frame { display:block; overflow:hidden; border-radius:8px; border:1px solid var(--line); background:#fff; position:relative; }
  .frame iframe { border:0; transform-origin:0 0; pointer-events:none; display:block; }
  figcaption { font-size:13px; margin-top:6px; } figcaption span { color:var(--muted); }
  .flow { margin:0 0 24px; background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px; overflow:auto; }
  .flow svg { max-width:100%; height:auto; }
  table { border-collapse:collapse; width:100%; font-size:14px; }
  td { border-top:1px solid var(--line); padding:6px 8px; vertical-align:top; overflow-wrap:anywhere; }
  td i { display:inline-block; width:14px; height:14px; border-radius:3px; border:1px solid var(--line); vertical-align:-2px; margin-right:8px; }
  .muted, .empty { color:var(--muted); }
  ul.log { padding-left:18px; } ul.log li { margin-bottom:6px; }
  .wrap { overflow-x:auto; }
</style></head>
<body><main>
<div class="accent-bar"></div>
<p class="eyebrow">Handoff · read-only · revision ${esc(String(doc.rev ?? ''))} · rendered ${esc(new Date().toISOString().slice(0, 16).replace('T', ' '))} UTC</p>
<h1>${esc(title)}</h1>
<nav><a href="#screens">Screens</a>${flowsHtml ? '<a href="#flows">Flows</a>' : ''}<a href="#tokens">Tokens</a><a href="#decisions">Decisions</a><a href="#notes">Annotations</a></nav>
<div id="screens">${sectionHtml || '<p class="empty">Nothing to show yet.</p>'}</div>
${flowsHtml ? `<h3 id="flows">Flows</h3>${flowsHtml}` : ''}
<h3 id="tokens">Tokens</h3>
${tokens ? `<div class="wrap"><table>${tokens}</table></div>` : '<p class="empty">No tokens.</p>'}
<h3 id="decisions">Decisions</h3>
${decisions.length ? `<ul class="log">${decisions.map((d) => `<li><strong>${esc(d.decision)}</strong> <span class="muted">— ${esc(d.by)}, ${esc(d.date)}${d.node && 'name' in d.node ? ` · ${esc(String(d.node.name))}` : ''}</span></li>`).join('')}</ul>` : '<p class="empty">No decisions logged.</p>'}
<h3 id="notes">Annotations</h3>
${notes.length ? `<ul class="log">${notes.map((c) => `<li><strong>${esc(NOTE_KIND_LABELS[c.kind as keyof typeof NOTE_KIND_LABELS] ?? c.kind ?? '')}</strong> · ${esc(doc.nodes[c.nodeId!]?.name ?? '')}: ${esc(c.text)}${c.resolved ? ' <span class="muted">(resolved)</span>' : ''}</li>`).join('')}</ul>` : '<p class="empty">No annotations.</p>'}
</main></body></html>`;
}
