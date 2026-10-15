/*
 * Browser half of heymax connect: three light-DOM custom elements styled by
 * connect.css. Framework-agnostic; they only call this app's own
 * /api/connect/* routes (set `base` to change), so no CORS is involved.
 *
 *   <hm-linked-work uri="heymax://notes/page/abc" item-title="Kickoff notes" item-url="https://…"></hm-linked-work>
 *     optional: engagement="heymax://studio/engagement/<id>" (else its own or inherited tag) puts
 *     that engagement's work first in the picker; link-label="Attach" renames "+ Link work".
 *   <hm-unfurl href="https://studio.heymax.im/engagements/xyz"></hm-unfurl>
 *   <hm-connect-search self="notes"></hm-connect-search>   (⌘K palette; call .open())
 *
 * If connect is switched off the routes 404 and every element removes itself.
 */
import { appName, orderGroups, rankSuggestions, engagementOf } from './connect.js';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const safeHref = (u) => (/^https?:\/\//i.test(u || '') ? u : '#');
const when = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

class Off extends Error {}

async function call(base, path, init) {
  const res = await fetch(`${base}${path}`, { credentials: 'include', ...init, headers: { 'content-type': 'application/json', ...(init?.headers || {}) } });
  if (res.status === 404 && path.startsWith('/status')) throw new Off();
  if (res.status === 404 && !init?.method) throw new Off();
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

/** Search every app through this app's fan-out route. */
export function searchEverywhere(q, { base = '/api/connect', apps, limit, signal } = {}) {
  const qs = new URLSearchParams({ q });
  if (apps) qs.set('apps', apps.join(','));
  if (limit) qs.set('limit', String(limit));
  return call(base, `/everywhere?${qs}`, { signal });
}

const mark = (marks, app) => `<img class="hm-cx__mark" src="${esc(marks)}/${esc(app)}.svg" alt="" width="22" height="22" />`;

function row(marks, it, extra = '') {
  return `<a class="hm-cx__row" href="${esc(safeHref(it.url))}" data-uri="${esc(it.uri)}">
    ${mark(marks, it.app)}
    <span class="hm-cx__text"><span class="hm-cx__title">${esc(it.title || 'Untitled')}</span>
    <span class="hm-cx__meta">${esc(appName(it.app))} · ${esc(it.type)}${it.subtitle ? ` · ${esc(it.subtitle)}` : ''}</span></span>
    ${extra}</a>`;
}

/* ───────────── Picker: type to search, Enter/click picks ───────────── */

function picker({ base, marks, apps, placeholder, exclude, suggest, suggestLabel, onPick, onClose }) {
  const box = document.createElement('div');
  box.className = 'hm-cx__picker';
  box.innerHTML = `<input class="hm-cx__input" type="search" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}" />
    <div class="hm-cx__results" role="listbox"></div>`;
  const input = box.querySelector('input');
  const out = box.querySelector('.hm-cx__results');
  let ctl, items = [], active = 0;
  // Suggestions (best first) load once; they fill the empty picker and lead the search results.
  const suggested = suggest ? suggest().catch(() => []) : Promise.resolve([]);
  const paint = () => out.querySelectorAll('.hm-cx__row').forEach((r, i) => r.toggleAttribute('data-active', i === active));
  const show = (list) => list.map((it) => row(marks, it, `<span class="hm-cx__when">${esc(when(it.updated))}</span>`).replace('<a ', '<a role="option" ')).join('');
  const run = async () => {
    ctl?.abort(); ctl = new AbortController();
    const q = input.value.trim();
    if (!q) {
      const mine = ctl;
      const list = (await suggested).filter((r) => !exclude?.(r));
      if (mine !== ctl) return;
      items = list;
      out.innerHTML = items.length ? `<p class="hm-cx__hint">${esc(suggestLabel || 'Suggested')}</p>${show(items)}` : '';
      active = 0; paint();
      return;
    }
    try {
      const { groups } = await searchEverywhere(q, { base, apps, signal: ctl.signal });
      items = rankSuggestions({ linked: await suggested, found: groups.flatMap((g) => g.results), skip: (r) => !!exclude?.(r) });
      out.innerHTML = items.length
        ? show(items)
        : `<p class="hm-cx__empty">Nothing found${groups.some((g) => !g.ok) ? ' (some apps did not answer)' : ''}.</p>`;
      active = 0; paint();
    } catch (e) {
      if (e.name !== 'AbortError') out.innerHTML = `<p class="hm-cx__empty">Search unavailable.</p>`;
    }
  };
  let t;
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 160); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, items.length - 1); paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); paint(); }
    else if (e.key === 'Enter' && items[active]) { e.preventDefault(); onPick(items[active]); }
  });
  out.addEventListener('click', (e) => {
    const a = e.target.closest('.hm-cx__row');
    if (!a) return;
    e.preventDefault();
    const it = items.find((i) => i.uri === a.dataset.uri);
    if (it) onPick(it);
  });
  setTimeout(() => { input.focus(); if (suggest) run(); });
  return box;
}

/* ───────────── <hm-linked-work> ───────────── */

/** Where documents live: what Studio attaches to its engagements and tasks. */
const WORK_APPS = ['notes', 'artifactory', 'playground'];

class HmLinkedWork extends HTMLElement {
  static observedAttributes = ['uri', 'item-title', 'engagement'];
  attributeChangedCallback() { if (this.isConnected) this.load(); }
  connectedCallback() { this.load(); }
  // Not `base`/`marks`: React 19 would try to assign a getter-only property.
  get apiBase() { return this.getAttribute('base') || '/api/connect'; }
  get marksPath() { return this.getAttribute('marks') || '/kit/marks'; }
  /** The engagement whose work comes first: the attribute, else this item's own or inherited tag. */
  get engagementUri() { return this.getAttribute('engagement') || engagementOf(this.links); }

  async load() {
    const uri = this.getAttribute('uri');
    if (!uri) return;
    this.classList.add('hm-cx', 'hm-cx-panel');
    try {
      const { links } = await call(this.apiBase, `/links?uri=${encodeURIComponent(uri)}`);
      this.links = links || [];
      this.error = null;
    } catch (e) {
      if (e instanceof Off) { this.hidden = true; return; }
      this.links = [];
      this.error = 'Links unavailable right now.';
    }
    this.hidden = false;
    this.render();
  }

  async add(other, kind) {
    const uri = this.getAttribute('uri');
    const me = { uri, title: this.getAttribute('item-title') || '', url: this.getAttribute('item-url') || location.href };
    try {
      await call(this.apiBase, '/links', { method: 'POST', body: JSON.stringify({ from: me, to: { uri: other.uri, title: other.title, url: other.url }, kind }) });
    } catch (e) { this.error = e.message; }
    this.load();
  }

  async remove(id) {
    try { await call(this.apiBase, `/links/${encodeURIComponent(id)}`, { method: 'DELETE' }); } catch (e) { this.error = e.message; }
    this.load();
  }

  render() {
    const self = (this.getAttribute('uri') || '').split('/')[2];
    const tags = this.links.filter((l) => l.kind === 'for' && l.direction === 'out');
    const work = this.links.filter((l) => !(l.kind === 'for' && l.direction === 'out'));
    const own = tags.filter((l) => !l.inherited);
    const x = (l) => `<button class="hm-cx__x" type="button" data-remove="${esc(l.id)}" aria-label="Remove ${esc(l.title)}">×</button>`;
    // An inherited tag (a Notes page under a tagged page) says where it comes from; it is removed there.
    const tagEnd = (l) => (l.inherited ? `<span class="hm-cx__from">from ${esc(l.inherited.title || 'parent')}</span>` : x(l));
    const label = this.getAttribute('link-label') || 'Link work';
    this.innerHTML = `
      <div class="hm-cx__head"><span class="hm-cx__label">Linked work</span></div>
      ${self !== 'studio' ? `<div class="hm-cx__tags">
        ${tags.map((l) => `<span class="hm-cx__tag">${mark(this.marksPath, 'studio')}<a href="${esc(safeHref(l.url))}">${esc(l.title || l.type)}</a>${tagEnd(l)}</span>`).join('')}
        <button class="hm-cx__add" type="button" data-pick="tag">${own.length ? '+ Tag' : '+ Engagement'}</button>
      </div>` : ''}
      ${work.length
        ? `<div class="hm-cx__list">${work.map((l) => row(this.marksPath, l, x(l))).join('')}</div>`
        : `<p class="hm-cx__empty">${self === 'studio' ? 'Notes, artifacts and designs for this engagement show here.' : 'Nothing linked yet.'}</p>`}
      ${this.error ? `<p class="hm-cx__error">${esc(this.error)}</p>` : ''}
      <div class="hm-cx__actions">
        <button class="hm-cx__add" type="button" data-pick="link">+ ${esc(label)}</button>
        ${self !== 'studio' && this.engagementUri ? '<button class="hm-cx__add" type="button" data-pick="task">+ Attach to task</button>' : ''}
      </div>
      <div class="hm-cx__slot"></div>`;
    this.querySelectorAll('[data-remove]').forEach((b) =>
      b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); this.remove(b.dataset.remove); }));
    this.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => this.pick(b.dataset.pick)));
  }

  /**
   * Best-first candidates from the engagement. "link": work already tagged for
   * or linked to it, then work matching its client. "task": its tasks.
   */
  async suggestions(what) {
    const eng = this.engagementUri;
    if (!eng || what === 'tag') return [];
    if (what === 'task') {
      // Studio's search reads an engagement URI as "this engagement's tasks", open ones first.
      const { groups } = await searchEverywhere(eng, { base: this.apiBase, apps: ['studio'], limit: 25 });
      return groups.flatMap((g) => g.results).filter((r) => r.type === 'task');
    }
    const [linked, item] = await Promise.all([
      call(this.apiBase, `/links?uri=${encodeURIComponent(eng)}`).then((b) => b.links || [], () => []),
      call(this.apiBase, `/unfurl?ref=${encodeURIComponent(eng)}`).catch(() => null),
    ]);
    const client = (item?.subtitle || '').split(' · ')[0];
    const sameClient = client
      ? (await searchEverywhere(client, { base: this.apiBase, apps: WORK_APPS, limit: 12 }).catch(() => ({ groups: [] }))).groups.flatMap((g) => g.results)
      : [];
    return rankSuggestions({ linked, sameClient });
  }

  pick(what) {
    const slot = this.querySelector('.hm-cx__slot');
    const me = this.getAttribute('uri');
    const have = new Set(this.links.map((l) => l.uri));
    slot.replaceChildren(
      picker({
        base: this.apiBase,
        marks: this.marksPath,
        apps: what === 'link' ? undefined : ['studio'],
        placeholder: what === 'tag' ? 'Find an engagement…' : what === 'task' ? 'Find a task…' : 'Find a page, artifact, design…',
        suggest: what === 'tag' ? undefined : () => this.suggestions(what),
        suggestLabel: what === 'task' ? 'Tasks in this engagement' : 'For this engagement',
        exclude: (r) => r.uri === me || have.has(r.uri) || (what === 'tag' && r.type !== 'engagement') || (what === 'task' && r.type !== 'task'),
        // A tag names the engagement with its client in front: the client comes from the engagement.
        onPick: (it) => this.add(what === 'tag' ? { ...it, title: `${(it.subtitle || '').split(' · ')[0]} · ${it.title}`.replace(/^ · /, '') } : it, what === 'tag' ? 'for' : 'relates'),
        onClose: () => slot.replaceChildren(),
      }),
    );
  }
}

/* ───────────── <hm-unfurl> ───────────── */

class HmUnfurl extends HTMLElement {
  async connectedCallback() {
    const href = this.getAttribute('href');
    const base = this.getAttribute('base') || '/api/connect';
    const marks = this.getAttribute('marks') || '/kit/marks';
    this.classList.add('hm-cx', 'hm-cx-unfurl');
    this.innerHTML = `<a class="hm-cx__row" href="${esc(safeHref(href))}"><span class="hm-cx__title">${esc(href)}</span></a>`;
    try {
      const it = await call(base, `/unfurl?ref=${encodeURIComponent(href)}`);
      if (it?.uri) {
        this.innerHTML = row(marks, it, `<span class="hm-cx__when">${esc(when(it.updated))}</span>`);
        this.dispatchEvent(new CustomEvent('hm-unfurled', { detail: it, bubbles: true }));
      }
    } catch { /* keep the plain link */ }
  }
}

/* ───────────── <hm-connect-search> (⌘K across the family) ───────────── */

class HmConnectSearch extends HTMLElement {
  connectedCallback() {
    if (this.dialog) return;
    this.classList.add('hm-cx');
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'hm-cx-palette';
    this.dialog.innerHTML = `<input class="hm-cx__input" type="search" placeholder="Search Studio, Notes, Artifactory, Playground…" aria-label="Search all apps" />
      <div class="hm-cx__results"></div>`;
    this.append(this.dialog);
    const input = this.dialog.querySelector('input');
    const out = this.dialog.querySelector('.hm-cx__results');
    const base = this.getAttribute('base') || '/api/connect';
    const marks = this.getAttribute('marks') || '/kit/marks';
    const self = this.getAttribute('self');
    let ctl, t, flat = [], active = 0;
    const paint = () => out.querySelectorAll('.hm-cx__row').forEach((r, i) => r.toggleAttribute('data-active', i === active));
    const run = async () => {
      ctl?.abort(); ctl = new AbortController();
      const q = input.value.trim();
      if (!q) { out.innerHTML = ''; flat = []; return; }
      try {
        const { groups } = await searchEverywhere(q, { base, signal: ctl.signal });
        const ordered = orderGroups(groups, self);
        flat = ordered.flatMap((g) => g.results);
        out.innerHTML = ordered
          .map((g) => `<section class="hm-cx__group"><h3>${mark(marks, g.app)}${esc(appName(g.app))}</h3>
            ${g.ok ? (g.results.length ? g.results.map((r) => row(marks, r, `<span class="hm-cx__when">${esc(when(r.updated))}</span>`)).join('') : '<p class="hm-cx__empty">No matches</p>')
              : '<p class="hm-cx__empty">Unavailable</p>'}</section>`)
          .join('');
        active = 0; paint();
      } catch (e) {
        if (e instanceof Off) { this.remove(); return; }
        if (e.name !== 'AbortError') out.innerHTML = '<p class="hm-cx__empty">Search unavailable.</p>';
      }
    };
    input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 160); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, flat.length - 1); paint(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); paint(); }
      else if (e.key === 'Enter' && flat[active]) { e.preventDefault(); location.href = safeHref(flat[active].url); }
    });
    this.dialog.addEventListener('click', (e) => { if (e.target === this.dialog) this.dialog.close(); });
    if (this.hasAttribute('hotkey')) {
      // ⌘K / Ctrl+K by default; an app with its own ⌘K sets hotkey="shift" for ⌘⇧K.
      const shift = this.getAttribute('hotkey') === 'shift';
      document.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && e.shiftKey === shift) { e.preventDefault(); this.open(); }
      });
    }
  }
  open(q = '') {
    const input = this.dialog.querySelector('input');
    if (!this.dialog.open) this.dialog.showModal();
    input.value = q; input.focus();
    input.dispatchEvent(new Event('input'));
  }
}

export function defineConnectElements() {
  if (!customElements.get('hm-linked-work')) customElements.define('hm-linked-work', HmLinkedWork);
  if (!customElements.get('hm-unfurl')) customElements.define('hm-unfurl', HmUnfurl);
  if (!customElements.get('hm-connect-search')) customElements.define('hm-connect-search', HmConnectSearch);
}
