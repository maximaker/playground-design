/*
 * heymax dial: the radial menu that replaces each app's sidebar, plus the
 * in-document mini ring. Vanilla, no dependencies; styles live in dial.css.
 * Geometry and behaviour are copied from the approved prototypes in
 * notes-radial-menu/ (index.html, suite.html, current-layout.html, mini-ring.js).
 *
 *   import { createDial, createMiniRing, DIAL_ICONS } from './dial.js';
 *   const dial = createDial({
 *     app: 'notes', name: 'Notes', mark: '<svg…>',            // gap label
 *     items: [{ id, label, icon, kbd, badge, panel }],        // ring order; >10 overflow into "More (n)"
 *     activeId: 'home',
 *     panel: { title, filter, groups: [{ title, rows: [{ id, label, meta, emoji, swatch, current, open, children }] , empty }] },
 *     onSelect: (item) => {}, onRow: (row) => {},
 *     onMove: ({ id, targetId, zone }) => {},                  // rows with reorderable: true; zone = before | after | inside
 *     onMoveTo: (row) => {},                                 // Ctrl/Cmd Shift M on a focused reorderable row
 *     startClosed: false, corner: false,                      // corner: knob-only bottom-left (canvas editors)
 *   });
 *   dial.update({ items, activeId, panel }); dial.setOpen(true); dial.openPanel(); dial.destroy();
 *
 * Compact mode (isCompact(): <=860px wide, or a coarse pointer with no fine one):
 * no ring. A 44px menu button sits at the left of the top bar and opens a
 * left drawer with the ring items as a list and the deep list as an
 * expandable section. Desktop is unchanged. The mini ring doesn't open there.
 */

export const DIAL_ICONS = {
  home: '<path d="M4 11l8-6.5 8 6.5V20h-5v-5H9v5H4z"/>',
  today: '<path d="M4 12h4l2-6 4 12 2-6h4"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  newpage: '<path d="M7 3.5h7l4.5 4.5v12.5h-11.5z"/><path d="M14 3.5V8h4.5"/><path d="M12.5 11.5v6M9.5 14.5h6"/>',
  folder: '<path d="M4 6.5h6l2 2h8v10a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z"/>',
  doc: '<path d="M7 3.5h7l4.5 4.5v12.5h-11.5z"/><path d="M14 3.5V8h4.5"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M21 20c0-2.6-1.7-4.9-4-5.7"/>',
  coin: '<circle cx="12" cy="12" r="8.5"/><path d="M14.5 9.5c-.5-1-1.5-1.5-2.5-1.5-1.4 0-2.5.8-2.5 2s1.1 1.6 2.5 2 2.5.8 2.5 2-1.1 2-2.5 2c-1 0-2-.5-2.5-1.5M12 6.5v1.5M12 16v1.5"/>',
  book: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 19V5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  import: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14"/>',
  export: '<path d="M12 15V4M7.5 8.5L12 4l4.5 4.5M5 19.5h14"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  component: '<path d="M12 3l4 4-4 4-4-4zM5 10l4 4-4 4-4-4zM19 10l4 4-4 4-4-4zM12 17l4 4-4 4-4-4z" transform="scale(.85) translate(2 0)"/>',
  share: '<circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.2 10.8l7.6-3.6M8.2 13.2l7.6 3.6"/>',
  quick: '<path d="M13 3L5 13.5h6L10 21l8-10.5h-6z"/>',
  journal: '<rect x="4" y="5" width="16" height="15.5" rx="2"/><path d="M4 9.5h16M8.5 3v4M15.5 3v4"/><circle cx="12" cy="14.5" r="1.4"/>',
  inbox: '<path d="M3.5 13l2.8-7.5h11.4l2.8 7.5v6H3.5z"/><path d="M3.5 13h5l1.5 2h4l1.5-2h5"/>',
  trash: '<path d="M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13"/>',
  present: '<rect x="3.5" y="4.5" width="17" height="11" rx="1.5"/><path d="M12 15.5V20M8 20h8"/>',
  proposal: '<path d="M7 3.5h10v17H7z"/><path d="M10 8h4M10 12h4M10 16h2"/>',
  graph: '<circle cx="6" cy="7" r="2.2"/><circle cx="18" cy="6" r="2.2"/><circle cx="12" cy="17" r="2.2"/><path d="M8 8l3 7M16.4 7.6L13 15M8.2 7h7.6"/>',
  star: '<path d="M12 4l2.4 5 5.4.6-4 3.7 1.1 5.4L12 16l-4.9 2.7 1.1-5.4-4-3.7 5.4-.6z"/>',
  calendar: '<rect x="4" y="5" width="16" height="15.5" rx="2"/><path d="M4 9.5h16M8.5 3v4M15.5 3v4M8 13h2M12 13h2M8 16.5h2M12 16.5h2"/>',
  whiteboard: '<rect x="3.5" y="4.5" width="17" height="12" rx="1.5"/><path d="M8 20l4-3.5 4 3.5M7 9l3 3 4-4 3 3"/>',
  map: '<circle cx="12" cy="5.5" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/><path d="M12 7.5v4M12 11.5H6v4.5M12 11.5h6v4.5"/>',
  more: '<circle cx="6" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18" cy="12" r="1.4"/>',
  // mini ring
  highlight: '<path d="M4 20h6"/><path d="M14.5 4.5l5 5L11 18H6v-5z"/>',
  comment: '<path d="M4 5h16v11H9l-5 4z"/>',
  task: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 12.5l2.8 2.8L16 9.5"/>',
  ai: '<path d="M12 3l1.8 4.6L18.5 9l-4.7 1.6L12 15l-1.8-4.4L5.5 9l4.7-1.4z"/><path d="M18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8z"/>',
  artifact: '<rect x="8.5" y="4" width="11.5" height="11.5" rx="2"/><rect x="4" y="8.5" width="11.5" height="11.5" rx="2"/>',
  heading: '<path d="M6 5v14M18 5v14M6 12h12"/>',
  list: '<path d="M9 7h11M9 12h11M9 17h11"/><circle cx="5" cy="7" r=".8"/><circle cx="5" cy="12" r=".8"/><circle cx="5" cy="17" r=".8"/>',
  todo: '<rect x="4" y="5" width="6" height="6" rx="1.5"/><path d="M13 8h7M13 16h7"/><rect x="4" y="13" width="6" height="6" rx="1.5"/>',
  quote: '<path d="M7 7h4v4c0 3-1.5 5-4 6M15 7h4v4c0 3-1.5 5-4 6"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M20.5 16l-5-5-9 9"/>',
  embed: '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4"/>',
  one: '<text x="12" y="16.5" text-anchor="middle" font-size="12" font-family="Inter" font-weight="600" stroke="none" fill="currentColor">1</text>',
  two: '<text x="12" y="16.5" text-anchor="middle" font-size="12" font-family="Inter" font-weight="600" stroke="none" fill="currentColor">2</text>',
  three: '<text x="12" y="16.5" text-anchor="middle" font-size="12" font-family="Inter" font-weight="600" stroke="none" fill="currentColor">3</text>',
  react: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 14.5c1 1.2 2.2 1.8 3.5 1.8s2.5-.6 3.5-1.8"/><circle cx="9" cy="10" r=".6"/><circle cx="15" cy="10" r=".6"/>',
  next: '<path d="M9 6l6 6-6 6"/>',
  pen: '<path d="M4 20l4.5-1 10-10-3.5-3.5-10 10z"/>',
};

const NS = 'http://www.w3.org/2000/svg';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icon = (k) => (k && k.trim().startsWith('<') ? k : DIAL_ICONS[k] || DIAL_ICONS.doc);
const pt = (rad, deg) => { const a = (deg * Math.PI) / 180; return [rad * Math.cos(a), rad * Math.sin(a)]; };

/* ---------- ring geometry (same in every app) ---------- */
export const RING = { R: 122, r: 66, GAP: 70, PAD: 1.6, MIN: 4, MAX: 10 };
const START = -90 + RING.GAP / 2, SWEEP = 360 - RING.GAP;
export function segmentPath(a0, a1, capStart, capEnd) {
  const { R, r } = RING;
  const [x0, y0] = pt(R, a0), [x1, y1] = pt(R, a1), [x2, y2] = pt(r, a1), [x3, y3] = pt(r, a0);
  const L = a1 - a0 > 180 ? 1 : 0, h = (R - r) / 2;
  return `M${x0} ${y0} A${R} ${R} 0 ${L} 1 ${x1} ${y1} ${capEnd ? `A${h} ${h} 0 0 1 ${x2} ${y2}` : `L${x2} ${y2}`} A${r} ${r} 0 ${L} 0 ${x3} ${y3} ${capStart ? `A${h} ${h} 0 0 1 ${x0} ${y0}` : ''}Z`;
}
/** Ring items after overflow: past MAX the last slot becomes "More (n)" holding the rest. */
export function ringItems(all) {
  if (all.length <= RING.MAX) return all;
  const extra = all.slice(RING.MAX - 1);
  return [...all.slice(0, RING.MAX - 1), { id: 'more', label: `More (${extra.length})`, icon: 'more', kbd: '', more: true, extra }];
}
/** Segment angles for n items, in degrees. */
export function segmentAngles(n) {
  const step = SWEEP / n;
  return Array.from({ length: n }, (_, i) => [START + i * step + (i ? RING.PAD / 2 : 0), START + (i + 1) * step - (i < n - 1 ? RING.PAD / 2 : 0)]);
}
/** Filter panel groups; a row stays if it or a descendant matches. */
export function filterRows(rows, q) {
  if (!q) return rows;
  const out = [];
  for (const row of rows) {
    const kids = filterRows(row.children || [], q);
    const hit = `${row.label} ${row.meta || ''}`.toLowerCase().includes(q);
    if (hit || kids.length) out.push({ ...row, children: row.children ? kids : undefined, _forceOpen: true });
  }
  return out;
}

/** Drop zone for a pointer over a row: top/bottom quarter reorders, the middle nests. */
export function dropZone(pointerY, rect) {
  const rel = (pointerY - rect.top) / rect.height;
  return rel < 0.25 ? 'before' : rel > 0.75 ? 'after' : 'inside';
}
/** True if `id` is `ancestorId` or sits anywhere under it in `rows`. */
export function isWithin(rows, ancestorId, id) {
  const find = (list) => { for (const r of list || []) { if (r.id === ancestorId) return r; const f = find(r.children); if (f) return f; } return null; };
  const walk = (r) => r.id === id || (r.children || []).some(walk);
  const a = find(rows);
  return !!a && walk(a);
}

/** Phones, small tablets and touch-only devices get the drawer instead of the ring. */
export const COMPACT_QUERY = '(max-width: 860px), (pointer: coarse) and (not (any-pointer: fine))';
export function isCompact() {
  if (typeof matchMedia !== 'function') return false;
  if (matchMedia('(max-width: 860px)').matches) return true;
  return matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;
}
/** Item hint for the drawer list: counts and badges, never keyboard shortcuts. */
export function drawerHint(it) {
  if (typeof it.badge === 'string') return it.badge;
  const k = (it.kbd || '').trim();
  return !k || /^(ctrl|⌘|cmd|alt|shift|option|⌥)/i.test(k) ? '' : k;
}

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const PIN_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4h6l-1 6 3 3H7l3-3z"/><path d="M12 13v7"/></svg>';
const BURGER_SVG = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
const CLOSE_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const MENU_SVG = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" style="color:var(--dial-hint)"><path d="M7 8h10M7 12h10M7 16h10"/></svg>';
const rowIcon = (k) => `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="color:var(--dial-mute)">${icon(k)}</svg>`;

export function createDial(opts) {
  let o = { items: [], panel: null, activeId: null, startClosed: false, corner: false, mount: document.body, ...opts };
  const key = o.app || 'app';
  const root = document.createElement('div');
  root.className = 'hm-dial-root';
  root.dataset.app = key;
  root.innerHTML = `
    <div class="hm-dial">
      <div class="gap-label" aria-hidden="true"></div>
      <svg class="hm-ring" viewBox="-130 -130 260 260" role="menu" id="hm-ring-${key}"></svg>
      <button type="button" class="knob" aria-expanded="true" aria-controls="hm-ring-${key}">
        <span class="face">${MENU_SVG}<span class="label">Menu</span><span class="kbd">Ctrl /</span></span>
      </button>
    </div>
    <section class="hm-flyout hm-fly-panel" aria-hidden="true">
      <div class="fly-head"><input class="filter" autocomplete="off" type="text"><button type="button" class="pin" aria-pressed="false">${PIN_SVG}</button></div>
      <div class="fly-body"></div>
    </section>
    <section class="hm-flyout hm-fly-more" aria-hidden="true"><h3>More</h3><div class="more-list"></div></section>
    <button type="button" class="hm-menu-btn" aria-haspopup="dialog" aria-expanded="false" aria-controls="hm-drawer-${key}">${BURGER_SVG}</button>
    <div class="hm-drawer-backdrop" hidden></div>
    <div class="hm-drawer" id="hm-drawer-${key}" role="dialog" aria-modal="true" tabindex="-1" hidden>
      <div class="dr-head"><span class="dr-title"></span><button type="button" class="dr-close" aria-label="Close menu">${CLOSE_SVG}</button></div>
      <nav class="dr-items"></nav>
    </div>`;
  o.mount.appendChild(root);
  const $ = (s) => root.querySelector(s);
  const dial = $('.hm-dial'), ring = $('.hm-ring'), knob = $('.knob'), lab = $('.face .label'), kbdEl = $('.face .kbd');
  const fly = $('.hm-fly-panel'), more = $('.hm-fly-more'), filter = $('.filter'), pinBtn = $('.pin'), body = $('.fly-body');

  let items = [], segs = [], focus = -1, openFly = null, pinned = store.get(`dial.pin.${key}`) === '1', q = '';
  const expanded = new Set();
  let dragId = null;
  const menuBtn = $('.hm-menu-btn'), drawer = $('.hm-drawer'), backdrop = $('.hm-drawer-backdrop');
  let compact = isCompact(), drawerOpen = false, drawerPanelOpen = false, dq = '', lastFocus = null;
  const allRows = () => (o.panel?.groups || []).flatMap((g) => g.rows || []);
  const clearDrop = () => body.querySelectorAll('.drop-before, .drop-after, .drop-inside').forEach((x) => x.classList.remove('drop-before', 'drop-after', 'drop-inside'));
  const isMobile = () => matchMedia('(max-width: 860px)').matches;

  function paint() {
    segs.forEach((s, i) => {
      const it = items[i];
      const active = it.id === o.activeId || (it.more && it.extra.some((e) => e.id === o.activeId));
      s.classList.toggle('active', !!active);
      s.classList.toggle('open', (openFly === 'panel' && !!it.panel) || (openFly === 'more' && !!it.more));
      if (active) s.setAttribute('aria-current', 'page'); else s.removeAttribute('aria-current');
    });
  }
  const show = (i) => { lab.textContent = i < 0 ? 'Menu' : items[i].label; kbdEl.textContent = i < 0 ? 'Ctrl /' : items[i].kbd || ''; };
  function setFocus(i, move = true) {
    segs.forEach((s) => s.classList.remove('focus'));
    focus = i;
    if (i >= 0) { segs[i].classList.add('focus'); if (move) segs[i].focus({ preventScroll: true }); }
    show(i);
  }

  function layout() {
    items = ringItems(o.items);
    ring.innerHTML = '';
    ring.setAttribute('aria-label', `${o.name || key} menu`);
    const angles = segmentAngles(items.length);
    items.forEach((it, i) => {
      const [a0, a1] = angles[i], mid = (a0 + a1) / 2, [cx, cy] = pt((RING.R + RING.r) / 2, mid);
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', 'seg'); g.setAttribute('role', 'menuitem'); g.setAttribute('tabindex', '-1');
      g.setAttribute('aria-label', it.label + (it.badge && typeof it.badge === 'string' ? `, ${it.badge}` : ''));
      g.dataset.id = it.id;
      if (it.panel || it.more) g.setAttribute('aria-haspopup', 'true');
      let inner = `<path d="${segmentPath(a0, a1, i === 0, i === items.length - 1)}"/><g class="ico" transform="translate(${cx - 10} ${cy - 10}) scale(.833)">${icon(it.icon || it.id)}</g>`;
      if (it.badge) inner += `<circle class="badge" cx="${cx + 9}" cy="${cy - 9}" r="3.5"/>`;
      if (it.panel || it.more) { const [tx, ty] = pt(RING.R - 7, mid); inner += `<circle class="dot" cx="${tx}" cy="${ty}" r="1.8"/>`; }
      g.innerHTML = inner;
      g.addEventListener('mouseenter', () => setFocus(i, false));
      g.addEventListener('mouseleave', () => { if (focus === i) setFocus(-1, false); });
      g.addEventListener('click', () => choose(i));
      ring.appendChild(g);
    });
    segs = [...ring.querySelectorAll('.seg')];
    if (focus >= items.length) focus = -1;
    paint();
    renderMore();
  }

  function renderRows(rows, depth = 0, inDrawer = false) {
    const frag = document.createDocumentFragment();
    for (const row of rows) {
      const wrap = document.createElement('div');
      const el = document.createElement(row.href ? 'a' : 'button');
      if (row.href) el.href = row.href; else el.type = 'button';
      el.className = 'row' + (row.current ? ' current' : '');
      if (row.current) el.setAttribute('aria-current', 'page');
      const hasKids = !!(row.children && row.children.length);
      const open = row._forceOpen || expanded.has(row.id) || (row.open && !expanded.has('!' + row.id));
      const lead = row.swatch ? `<span class="sw"${row.swatch === true ? '' : ` style="background:${esc(row.swatch)}"`}></span>`
        : row.emoji ? `<span class="emoji">${esc(row.emoji)}</span>` : row.icon === false ? '' : rowIcon(row.icon || 'doc');
      el.innerHTML = `${row.tree ? `<span class="twisty" ${hasKids ? 'data-twisty="1" role="button" aria-label="Expand"' : ''}>${hasKids ? (open ? '▾' : '▸') : ''}</span>` : ''}${lead}<span class="t">${esc(row.label)}</span>${row.meta ? `<span class="n">${esc(row.meta)}</span>` : ''}`;
      if (hasKids) el.setAttribute('aria-expanded', String(!!open));
      el.addEventListener('click', (e) => {
        const twisty = e.target.closest('[data-twisty]');
        if (hasKids && (twisty || row.toggleOnly)) {
          e.preventDefault();
          if (open) { expanded.delete(row.id); expanded.add('!' + row.id); } else { expanded.add(row.id); expanded.delete('!' + row.id); }
          renderPanel(); if (drawerOpen) renderDrawer();
          return;
        }
        if (row.href && (e.metaKey || e.ctrlKey || e.shiftKey || e.button)) return;
        e.preventDefault();
        if (inDrawer) closeDrawer(false);
        else if (!pinned || isMobile()) setFly(null);
        o.onRow && o.onRow(row);
      });
      if (row.reorderable && !inDrawer) wireReorder(el, row, rows);
      wrap.appendChild(el);
      if (inDrawer && row.reorderable && o.onMoveTo) {
        // touch: reordering goes through the app's "Move to…", no drag
        wrap.classList.add('dr-row');
        const mv = document.createElement('button');
        mv.type = 'button'; mv.className = 'dr-move'; mv.textContent = 'Move…';
        mv.setAttribute('aria-label', `Move ${row.label}`);
        mv.addEventListener('click', (e) => { e.stopPropagation(); closeDrawer(false); o.onMoveTo(row); });
        wrap.appendChild(mv);
      }
      if (hasKids) {
        const box = document.createElement('div');
        box.className = 'children'; box.hidden = !open;
        if (open) box.appendChild(renderRows(row.children, depth + 1, inDrawer));
        wrap.appendChild(box);
      }
      frag.appendChild(wrap);
    }
    return frag;
  }

  function renderDrawer() {
    $('.dr-title').innerHTML = `${o.mark || ''}<span>${esc(o.name || key)}</span>`;
    drawer.setAttribute('aria-label', `${o.name || key} menu`);
    menuBtn.setAttribute('aria-label', `Open the ${o.name || key} menu`);
    const nav = $('.dr-items');
    const st = drawer.scrollTop;
    nav.innerHTML = '';
    nav.setAttribute('aria-label', o.name || key);
    for (const it of o.items) {
      const b = document.createElement('button');
      b.type = 'button';
      const active = it.id === o.activeId;
      const isPanel = !!(it.panel && o.panel);
      b.className = 'row dr-item' + (active ? ' current' : '');
      b.dataset.id = it.id;
      if (active) b.setAttribute('aria-current', 'page');
      const hint = drawerHint(it);
      b.innerHTML = `<span class="dr-ico">${rowIcon(it.icon || it.id).replace('style="color:var(--dial-mute)"', '')}</span><span class="t">${esc(it.label)}</span>${hint ? `<span class="n">${esc(hint)}</span>` : ''}${it.badge ? '<span class="dr-badge" aria-hidden="true"></span>' : ''}${isPanel ? `<span class="dr-chev" aria-hidden="true">${drawerPanelOpen ? '▾' : '▸'}</span>` : ''}`;
      if (isPanel) {
        b.setAttribute('aria-expanded', String(drawerPanelOpen));
        b.addEventListener('click', () => { drawerPanelOpen = !drawerPanelOpen; renderDrawer(); nav.querySelector(`[data-id="${CSS.escape(it.id)}"]`)?.focus(); });
      } else {
        b.addEventListener('click', () => { closeDrawer(false); o.onSelect && o.onSelect(it); });
      }
      nav.appendChild(b);
      if (isPanel && drawerPanelOpen) nav.appendChild(drawerPanel());
    }
    drawer.scrollTop = st;
  }
  function drawerPanel() {
    const box = document.createElement('div');
    box.className = 'dr-section';
    const f = document.createElement('input');
    f.className = 'filter'; f.type = 'text'; f.autocomplete = 'off'; f.value = dq;
    f.placeholder = o.panel.filter || 'Filter…'; f.setAttribute('aria-label', o.panel.filter || 'Filter');
    const list = document.createElement('div');
    const fill = () => {
      list.innerHTML = '';
      for (const g of o.panel.groups || []) {
        const rows = filterRows(g.rows || [], dq);
        if ((dq || g.hideEmpty) && !rows.length) continue;
        if (g.title) { const h = document.createElement('h3'); h.textContent = g.title; list.appendChild(h); }
        if (rows.length) list.appendChild(renderRows(rows, 0, true));
        else { const d = document.createElement('div'); d.className = 'row empty'; d.textContent = g.empty || 'Nothing here yet'; list.appendChild(d); }
      }
    };
    f.addEventListener('input', () => { dq = f.value.trim().toLowerCase(); fill(); });
    fill();
    box.append(f, list);
    return box;
  }
  const focusables = () => [...drawer.querySelectorAll('button, a[href], input')].filter((x) => !x.disabled && x.getClientRects().length);
  function openDrawer() {
    if (drawerOpen) return;
    drawerOpen = true; lastFocus = document.activeElement;
    renderDrawer();
    drawer.hidden = false; backdrop.hidden = false;
    void drawer.offsetWidth; // start the slide from off-screen
    drawer.classList.add('show'); backdrop.classList.add('show');
    menuBtn.setAttribute('aria-expanded', 'true');
    document.documentElement.classList.add('hm-drawer-open');
    (drawer.querySelector('.dr-item.current') || drawer.querySelector('.dr-item') || drawer).focus();
  }
  function closeDrawer(restore = true) {
    if (!drawerOpen) return;
    drawerOpen = false;
    drawer.classList.remove('show'); backdrop.classList.remove('show');
    menuBtn.setAttribute('aria-expanded', 'false');
    document.documentElement.classList.remove('hm-drawer-open');
    const done = () => { if (!drawerOpen) { drawer.hidden = true; backdrop.hidden = true; } };
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) done(); else setTimeout(done, 220);
    if (restore) (lastFocus && document.contains(lastFocus) && lastFocus !== document.body ? lastFocus : menuBtn).focus();
  }
  menuBtn.addEventListener('click', () => (drawerOpen ? closeDrawer() : openDrawer()));
  $('.dr-close').addEventListener('click', () => closeDrawer());
  backdrop.addEventListener('click', () => closeDrawer());
  drawer.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeDrawer(); return; }
    if (e.key !== 'Tab') return;
    const f = focusables(); if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === drawer)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  // keep focus inside while open
  const onFocusIn = (e) => { if (drawerOpen && !drawer.contains(e.target)) (drawer.querySelector('.dr-item') || drawer).focus(); };
  document.addEventListener('focusin', onFocusIn);
  // swipe left closes
  let sx = null, sy = 0;
  drawer.addEventListener('touchstart', (e) => { const t = e.touches[0]; sx = t.clientX; sy = t.clientY; }, { passive: true });
  drawer.addEventListener('touchend', (e) => {
    if (sx === null) return;
    const t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy; sx = null;
    if (dx < -60 && Math.abs(dx) > Math.abs(dy) * 1.5) closeDrawer();
  }, { passive: true });
  function applyCompact() {
    root.classList.toggle('compact', compact);
    document.documentElement.classList.toggle('hm-dial-compact', compact);
    if (compact) setFly(null); else closeDrawer(false);
  }

  function wireReorder(el, row, siblings) {
    el.draggable = true;
    el.dataset.rowId = row.id;
    el.setAttribute('aria-roledescription', 'Reorderable page');
    el.addEventListener('dragstart', (e) => {
      dragId = row.id; el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', row.label); } catch { /* old browsers */ }
    });
    el.addEventListener('dragend', () => { dragId = null; el.classList.remove('dragging'); clearDrop(); });
    el.addEventListener('dragover', (e) => {
      if (!dragId || dragId === row.id || !row.reorderable || isWithin(allRows(), dragId, row.id)) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'move';
      const zone = dropZone(e.clientY, el.getBoundingClientRect());
      if (!el.classList.contains('drop-' + zone)) { clearDrop(); el.classList.add('drop-' + zone); }
    });
    el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('drop-before', 'drop-after', 'drop-inside'); });
    el.addEventListener('drop', (e) => {
      if (!dragId) return;
      e.preventDefault();
      const zone = dropZone(e.clientY, el.getBoundingClientRect()), id = dragId;
      dragId = null; clearDrop();
      if (id === row.id || isWithin(allRows(), id, row.id)) return;
      if (zone === 'inside') { expanded.add(row.id); expanded.delete('!' + row.id); }
      o.onMove && o.onMove({ id, targetId: row.id, zone });
    });
    // keyboard: Alt+Up/Down reorders among siblings, Ctrl/Cmd Shift M opens the app's Move to…
    el.addEventListener('keydown', (e) => {
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        const i = siblings.findIndex((r) => r.id === row.id), j = i + (e.key === 'ArrowUp' ? -1 : 1);
        e.preventDefault(); e.stopPropagation();
        if (j < 0 || j >= siblings.length) return;
        refocus = row.id;
        o.onMove && o.onMove({ id: row.id, targetId: siblings[j].id, zone: e.key === 'ArrowUp' ? 'before' : 'after' });
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'm' && o.onMoveTo) {
        e.preventDefault(); e.stopPropagation(); o.onMoveTo(row);
      }
    });
  }
  let refocus = null;

  function renderPanel() {
    const p = o.panel;
    if (!p) { body.innerHTML = ''; return; }
    fly.setAttribute('aria-label', p.title || 'List');
    filter.placeholder = p.filter || 'Filter…';
    filter.setAttribute('aria-label', p.filter || 'Filter');
    const st = fly.scrollTop;
    body.innerHTML = '';
    for (const g of p.groups || []) {
      const rows = filterRows(g.rows || [], q);
      if ((q || g.hideEmpty) && !rows.length) continue;
      if (g.title) { const h = document.createElement('h3'); h.textContent = g.title; body.appendChild(h); }
      if (rows.length) body.appendChild(renderRows(rows));
      else { const d = document.createElement('div'); d.className = 'row empty'; d.textContent = g.empty || 'Nothing here yet'; body.appendChild(d); }
    }
    fly.scrollTop = st;
    if (refocus) { const r = body.querySelector(`[data-row-id="${CSS.escape(refocus)}"]`); if (r) { r.focus(); refocus = null; } }
  }

  function renderMore() {
    const box = $('.more-list');
    box.innerHTML = '';
    const m = items.find((i) => i.more);
    if (!m) return;
    for (const it of m.extra) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'row' + (it.id === o.activeId ? ' current' : '');
      b.innerHTML = `<span class="twisty"></span>${rowIcon(it.icon || it.id).replace('style="color:var(--dial-mute)"', '')}<span class="t">${esc(it.label)}</span>${it.kbd ? `<span class="n">${esc(it.kbd)}</span>` : ''}`;
      b.addEventListener('click', () => go(it));
      box.appendChild(b);
    }
  }

  function applyPinned() {
    const docked = pinned && !o.corner && !!o.panel;
    fly.classList.toggle('docked', docked);
    pinBtn.setAttribute('aria-pressed', String(pinned));
    const t = pinned ? 'Unpin: show the list as a panel' : 'Pin the list under the menu';
    pinBtn.title = t; pinBtn.setAttribute('aria-label', t);
    fly.setAttribute('aria-hidden', String(!(docked && !isMobile()) && openFly !== 'panel'));
    root.classList.toggle('pinned', docked);
    o.onPinChange && o.onPinChange(docked);
  }
  function setPinned(v) {
    pinned = v; store.set(`dial.pin.${key}`, v ? '1' : '0');
    if (v && openFly === 'panel' && !isMobile()) openFly = null;
    applyPinned(); syncFly(); paint();
  }
  function syncFly() {
    fly.classList.toggle('show', openFly === 'panel');
    more.classList.toggle('show', openFly === 'more');
    more.setAttribute('aria-hidden', String(openFly !== 'more'));
    applyPinnedAria();
  }
  const applyPinnedAria = () => fly.setAttribute('aria-hidden', String(!(fly.classList.contains('docked') && !isMobile()) && openFly !== 'panel'));
  function setFly(which) {
    if (which === 'panel' && pinned && !o.corner && !isMobile()) { openFly = null; syncFly(); paint(); filter.focus(); return; }
    openFly = which; syncFly(); paint();
    if (which === 'panel') setTimeout(() => filter.focus(), 50);
    if (which === 'more') setTimeout(() => more.querySelector('.row')?.focus(), 50);
  }
  function choose(i) {
    const it = items[i];
    if (it.panel) { setFly(openFly === 'panel' ? null : 'panel'); return; }
    if (it.more) { setFly(openFly === 'more' ? null : 'more'); return; }
    go(it);
  }
  function go(it) {
    setFly(null);
    if (o.corner || isMobile()) setOpen(false);
    o.onSelect && o.onSelect(it);
  }
  function setOpen(open) {
    dial.classList.toggle('closed', !open);
    knob.setAttribute('aria-expanded', String(open));
    knob.setAttribute('aria-label', `${open ? 'Close' : 'Open'} the ${o.name || key} menu`);
    if (!open) { setFocus(-1, false); setFly(null); }
  }
  const isOpen = () => !dial.classList.contains('closed');
  const within = (el) => !!el && root.contains(el);

  // ---------- input ----------
  knob.addEventListener('click', () => setOpen(!isOpen()));
  pinBtn.addEventListener('click', (e) => { e.stopPropagation(); setPinned(!pinned); });
  filter.addEventListener('input', () => { q = filter.value.trim().toLowerCase(); renderPanel(); });
  filter.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); body.querySelector('.row:not(.empty)')?.focus(); }
    if (e.key === 'Enter') { const first = body.querySelector('.row:not(.empty)'); if (first) { e.preventDefault(); first.click(); } }
  });
  const onPanelKey = (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const rows = [...e.currentTarget.querySelectorAll('.row:not(.empty)')].filter((r) => r.offsetParent);
    const i = rows.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    if (e.key === 'ArrowUp' && i === 0 && e.currentTarget === fly) { filter.focus(); return; }
    rows[(i + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length].focus();
  };
  fly.addEventListener('keydown', onPanelKey);
  more.addEventListener('keydown', onPanelKey);

  const onKey = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === '/') {
      e.preventDefault();
      if (compact) { if (drawerOpen) closeDrawer(); else openDrawer(); return; }
      setOpen(!isOpen());
      if (isOpen()) setFocus(Math.max(0, items.findIndex((i) => i.id === o.activeId || (i.more && i.extra.some((x) => x.id === o.activeId)))));
      return;
    }
    if (compact) return;
    if (e.key === 'Escape') {
      if (openFly) { const was = openFly; setFly(null); const i = items.findIndex((x) => (was === 'panel' ? x.panel : x.more)); if (i >= 0 && isOpen()) setFocus(i); else knob.focus(); e.stopPropagation(); return; }
      if (within(document.activeElement) && isOpen() && document.activeElement !== filter) { setOpen(false); knob.focus(); }
      return;
    }
    // ring navigation only while focus is on the ring, so editors keep their arrow keys
    if (!isOpen() || !ring.contains(document.activeElement)) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); setFocus((focus + 1 + items.length) % items.length); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); setFocus((focus - 1 + items.length) % items.length); }
    else if (e.key === 'Home') { e.preventDefault(); setFocus(0); }
    else if (e.key === 'End') { e.preventDefault(); setFocus(items.length - 1); }
    else if ((e.key === 'Enter' || e.key === ' ') && focus >= 0) { e.preventDefault(); choose(focus); }
    else if (e.key === 'Tab') { setFocus(-1, false); }
    else if (/^[1-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey && +e.key <= items.length) { e.preventDefault(); const i = +e.key - 1; setFocus(i); choose(i); }
  };
  const onDocClick = (e) => { if (openFly && !within(e.target)) setFly(null); };
  const mq = matchMedia('(max-width: 860px)'), cq = matchMedia(COMPACT_QUERY);
  const onMq = () => { compact = isCompact(); applyCompact(); applyPinned(); if (mq.matches) setOpen(false); };
  document.addEventListener('keydown', onKey);
  document.addEventListener('click', onDocClick);
  mq.addEventListener?.('change', onMq);
  cq.addEventListener?.('change', onMq);

  function applyChrome() {
    $('.gap-label').innerHTML = `${o.mark || ''}${esc(o.label ?? o.name ?? '')}`;
    dial.classList.toggle('corner', !!o.corner);
    root.dataset.app = key;
  }

  applyChrome(); layout(); renderPanel(); applyPinned(); applyCompact();
  setOpen(!(o.startClosed || o.corner || isMobile()));

  return {
    el: root,
    update(next) {
      const prevCorner = o.corner;
      o = { ...o, ...next };
      applyChrome(); layout(); renderPanel(); applyPinned();
      if (drawerOpen) renderDrawer();
      if (next.corner !== undefined && next.corner !== prevCorner) setOpen(!o.corner && !isMobile());
      if (next.startClosed !== undefined && next.startClosed) setOpen(false);
    },
    setOpen, isOpen,
    openPanel() { if (compact) { drawerPanelOpen = true; if (drawerOpen) renderDrawer(); else openDrawer(); return; } setOpen(true); setFly('panel'); },
    get compact() { return compact; },
    openDrawer, closeDrawer,
    closePanel() { setFly(null); },
    get pinned() { return pinned && !o.corner && !!o.panel; },
    setPinned,
    destroy() {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onDocClick);
      mq.removeEventListener?.('change', onMq);
      cq.removeEventListener?.('change', onMq);
      document.removeEventListener('focusin', onFocusIn);
      closeDrawer(false);
      document.documentElement.classList.remove('hm-dial-compact');
      root.remove();
    },
  };
}

/* ---------- mini ring: 4–6 actions in a small full circle, opened at a point ---------- */
// The last pointer the user used; the mini ring stays shut after a touch.
let lastPointer = 'mouse';
if (typeof document !== 'undefined') document.addEventListener('pointerdown', (e) => { lastPointer = e.pointerType || 'mouse'; }, true);
/** The mini ring is desktop only: not in compact mode, not after touch or pen. */
export function miniRingAllowed(pointerType) {
  const p = pointerType || lastPointer;
  return !isCompact() && p !== 'touch' && p !== 'pen';
}

export function createMiniRing({ accent, onAccent, hint = 'Esc', mount = document.body } = {}) {
  const MR = 80, mr = 34, PAD = 3;
  const arc = (a0, a1) => { const [x0, y0] = pt(MR, a0), [x1, y1] = pt(MR, a1), [x2, y2] = pt(mr, a1), [x3, y3] = pt(mr, a0), L = a1 - a0 > 180 ? 1 : 0;
    return `M${x0} ${y0} A${MR} ${MR} 0 ${L} 1 ${x1} ${y1} L${x2} ${y2} A${mr} ${mr} 0 ${L} 0 ${x3} ${y3}Z`; };
  const el = document.createElement('div');
  el.className = 'hm-mr'; el.setAttribute('role', 'menu');
  if (accent) el.style.setProperty('--mr-accent', accent);
  if (onAccent) el.style.setProperty('--mr-on', onAccent);
  el.innerHTML = '<svg viewBox="-84 -84 168 168"></svg><div class="lab" aria-live="polite"></div>';
  mount.appendChild(el);
  const svg = el.querySelector('svg'), lab = el.querySelector('.lab');
  let items = [], segs = [], focus = -1, open = false, onClose = null, near = false, label = 'Actions';

  const setLabel = (i) => { lab.innerHTML = i < 0 ? `Pick one<small>${esc(hint)}</small>` : `${esc(items[i].label)}${items[i].kbd ? `<small>${esc(items[i].kbd)}</small>` : ''}`; };
  const setF = (i) => { focus = i; segs.forEach((s, k) => s.classList.toggle('f', k === i)); setLabel(i); };
  function build() {
    svg.innerHTML = `<circle r="${MR + 1}" fill="#1d2026"/><circle class="hub" r="${mr}"/>`;
    el.setAttribute('aria-label', label);
    const step = 360 / items.length, start = -90 - step / 2;
    items.forEach((it, i) => {
      const a0 = start + i * step + PAD / 2, a1 = start + (i + 1) * step - PAD / 2, [cx, cy] = pt((MR + mr) / 2, (a0 + a1) / 2);
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', 's'); g.setAttribute('role', 'menuitem'); g.setAttribute('aria-label', it.label);
      g.innerHTML = `<path d="${arc(a0, a1)}"/><g transform="translate(${cx - 9} ${cy - 9}) scale(.75)">${icon(it.icon || it.id)}</g>`;
      g.addEventListener('mouseenter', () => setF(i));
      g.addEventListener('mousedown', (e) => e.preventDefault()); // keep the text selection alive
      g.addEventListener('click', (e) => { e.stopPropagation(); pick(i); });
      svg.appendChild(g);
    });
    segs = [...svg.querySelectorAll('.s')];
  }
  function pick(i) { const it = items[i]; close(); it && it.run && it.run(); }
  function openAt(x, y, list, opts = {}) {
    if (!miniRingAllowed(opts.pointerType)) return false;
    items = list.slice(0, 6); onClose = opts.onClose || null; label = opts.label || 'Actions';
    if (!items.length) return false;
    build();
    // keep inside the viewport and off the thing we're acting on
    const half = 84, m = 8; let px = x, py = y;
    if (opts.avoid) { const a = opts.avoid; py = a.top - half - 6 < m ? a.bottom + half + 6 : a.top - half - 6; px = Math.min(Math.max(x, a.left), a.right); }
    px = Math.min(Math.max(px, half + m), innerWidth - half - m); py = Math.min(Math.max(py, half + m), innerHeight - half - m);
    el.style.left = px + 'px'; el.style.top = py + 'px';
    setF(-1); el.classList.add('show'); open = true; near = false;
    return true;
  }
  function close() { if (!open) return; open = false; el.classList.remove('show'); onClose && onClose(); }

  const onKey = (e) => {
    if (!open) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); setF((focus + 1) % items.length); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); setF((focus - 1 + items.length) % items.length); }
    else if (e.key === 'Enter' && focus >= 0) { e.preventDefault(); e.stopPropagation(); pick(focus); }
    else if (/^[1-6]$/.test(e.key) && +e.key <= items.length) { e.preventDefault(); e.stopPropagation(); pick(+e.key - 1); }
    else if (items.some((it) => it.key && it.key.toLowerCase() === e.key.toLowerCase())) { e.preventDefault(); e.stopPropagation(); pick(items.findIndex((it) => it.key && it.key.toLowerCase() === e.key.toLowerCase())); }
    else if (!['Shift', 'Control', 'Meta', 'Alt'].includes(e.key)) close(); // typing anything else goes back to the document
  };
  const onDown = (e) => { if (open && !el.contains(e.target)) close(); };
  // moving the pointer well away closes it, but only once the pointer has been near:
  // the pointer's own travel to the click point can arrive just after opening.
  const onMove = (e) => {
    if (!open) return;
    const b = el.getBoundingClientRect(), d = Math.hypot(e.clientX - (b.left + b.width / 2), e.clientY - (b.top + b.height / 2));
    if (d < 110) near = true; else if (near && d > 190) close();
  };
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('scroll', close, true);
  document.addEventListener('mousemove', onMove);

  return {
    open: openAt, close,
    get isOpen() { return open; },
    destroy() {
      close();
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('scroll', close, true);
      document.removeEventListener('mousemove', onMove);
      el.remove();
    },
  };
}
