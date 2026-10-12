/*
 * Browser half of heymax connect: three light-DOM custom elements styled by
 * connect.css. Framework-agnostic; they only call this app's own
 * /api/connect/* routes (set `base` to change), so no CORS is involved.
 *
 *   <hm-linked-work uri="heymax://notes/page/abc" item-title="Kickoff notes" item-url="https://…"></hm-linked-work>
 *   <hm-unfurl href="https://studio-os.heymax.im/engagements/xyz"></hm-unfurl>
 *   <hm-connect-search self="notes"></hm-connect-search>   (⌘K palette; call .open())
 *
 * If connect is switched off the routes 404 and every element removes itself.
 */
import { appName, orderGroups } from './connect.js';

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
export function searchEverywhere(q, { base = '/api/connect', apps, signal } = {}) {
  const qs = new URLSearchParams({ q });
  if (apps) qs.set('apps', apps.join(','));
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

function picker({ base, marks, apps, placeholder, exclude, onPick, onClose }) {
  const box = document.createElement('div');
  box.className = 'hm-cx__picker';
  box.innerHTML = `<input class="hm-cx__input" type="search" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}" />
    <div class="hm-cx__results" role="listbox"></div>`;
  const input = box.querySelector('input');
  const out = box.querySelector('.hm-cx__results');
  let ctl, items = [], active = 0;
  const paint = () => out.querySelectorAll('.hm-cx__row').forEach((r, i) => r.toggleAttribute('data-active', i === active));
  const run = async () => {
    ctl?.abort(); ctl = new AbortController();
    const q = input.value.trim();
    if (!q) { out.innerHTML = ''; items = []; return; }
    try {
      const { groups } = await searchEverywhere(q, { base, apps, signal: ctl.signal });
      items = groups.flatMap((g) => g.results).filter((r) => !exclude?.(r));
      out.innerHTML = items.length
        ? items.map((it) => row(marks, it).replace('<a ', '<a role="option" ')).join('')
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
  setTimeout(() => input.focus());
  return box;
}

/* ───────────── <hm-linked-work> ───────────── */

class HmLinkedWork extends HTMLElement {
  static observedAttributes = ['uri', 'item-title'];
  attributeChangedCallback() { if (this.isConnected) this.load(); }
  connectedCallback() { this.load(); }
  // Not `base`/`marks`: React 19 would try to assign a getter-only property.
  get apiBase() { return this.getAttribute('base') || '/api/connect'; }
  get marksPath() { return this.getAttribute('marks') || '/kit/marks'; }

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
    const x = (l) => `<button class="hm-cx__x" type="button" data-remove="${esc(l.id)}" aria-label="Remove ${esc(l.title)}">×</button>`;
    this.innerHTML = `
      <div class="hm-cx__head"><span class="hm-cx__label">Linked work</span></div>
      ${self !== 'studio' ? `<div class="hm-cx__tags">
        ${tags.map((l) => `<span class="hm-cx__tag">${mark(this.marksPath, 'studio')}<a href="${esc(safeHref(l.url))}">${esc(l.title || l.type)}</a>${x(l)}</span>`).join('')}
        <button class="hm-cx__add" type="button" data-pick="tag">${tags.length ? '+ Tag' : '+ Client or engagement'}</button>
      </div>` : ''}
      ${work.length
        ? `<div class="hm-cx__list">${work.map((l) => row(this.marksPath, l, x(l))).join('')}</div>`
        : `<p class="hm-cx__empty">${self === 'studio' ? 'Notes, artifacts and designs for this engagement show here.' : 'Nothing linked yet.'}</p>`}
      ${this.error ? `<p class="hm-cx__error">${esc(this.error)}</p>` : ''}
      <button class="hm-cx__add" type="button" data-pick="link">+ Link work</button>
      <div class="hm-cx__slot"></div>`;
    this.querySelectorAll('[data-remove]').forEach((b) =>
      b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); this.remove(b.dataset.remove); }));
    this.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => this.pick(b.dataset.pick)));
  }

  pick(what) {
    const slot = this.querySelector('.hm-cx__slot');
    const me = this.getAttribute('uri');
    const have = new Set(this.links.map((l) => l.uri));
    slot.replaceChildren(
      picker({
        base: this.apiBase,
        marks: this.marksPath,
        apps: what === 'tag' ? ['studio'] : undefined,
        placeholder: what === 'tag' ? 'Find a client or engagement…' : 'Find a page, artifact, design…',
        exclude: (r) => r.uri === me || have.has(r.uri) || (what === 'tag' && !['client', 'engagement'].includes(r.type)),
        onPick: (it) => this.add(it, what === 'tag' ? 'for' : 'relates'),
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
    this.dialog.innerHTML = `<input class="hm-cx__input" type="search" placeholder="Search Studio OS, Notes, Artifactory, Playground…" aria-label="Search all apps" />
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
