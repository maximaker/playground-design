/**
 * Reading a live page as a document.
 *
 * Injected into the site, so nothing here runs in Node — it is written as plain
 * functions that Playwright evaluates in the page. Shared by the importer and
 * the re-import, which must agree exactly: a fidelity fix is worth nothing if
 * only one of them has it.
 */

/** The page-building part of the extractor, injected into the site. */
function extractor() {
  const KEEP = ['display', 'flex-direction', 'flex-wrap', 'align-items', 'justify-content', 'gap',
    'grid-template-columns', 'padding', 'margin', 'max-width', 'min-height', 'background-color',
    'background-image', 'color', 'font-family', 'font-size', 'font-weight', 'line-height',
    'letter-spacing', 'text-transform', 'text-align', 'border-radius', 'border', 'box-shadow',
    'position', 'top', 'left', 'right', 'bottom', 'overflow', 'aspect-ratio', 'flex', 'width'];
  const DEF = {
    display: 'block', 'flex-direction': 'row', 'flex-wrap': 'nowrap', 'align-items': 'normal',
    'justify-content': 'normal', gap: 'normal', padding: '0px', margin: '0px',
    'background-color': 'rgba(0, 0, 0, 0)', 'background-image': 'none', 'border-radius': '0px',
    'box-shadow': 'none', position: 'static', overflow: 'visible', 'text-transform': 'none',
    'letter-spacing': 'normal', 'text-align': 'start', 'aspect-ratio': 'auto', 'max-width': 'none',
    'min-height': '0px', flex: '0 1 auto', 'grid-template-columns': 'none',
    top: 'auto', left: 'auto', right: 'auto', bottom: 'auto', width: 'auto',
  };
  const INHERIT = ['color', 'font-family', 'font-size', 'font-weight', 'line-height'];
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'SVG']);
  const TAGS = new Set(['section', 'div', 'header', 'footer', 'nav', 'main', 'article', 'aside',
    'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'p', 'span', 'a', 'button', 'strong', 'em',
    'blockquote', 'figure', 'figcaption', 'details', 'summary', 'label', 'form', 'br']);
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const round = (v) => v.replace(/(\d+\.\d+)px/g, (_, n) => `${Math.round(Number(n))}px`);

  function styleOf(el, skip = []) {
    const cs = getComputedStyle(el);
    const parent = el.parentElement;
    const ps = parent ? getComputedStyle(parent) : null;
    const out = [];
    for (const p of KEEP) {
      const v = cs.getPropertyValue(p).trim();
      if (!v || DEF[p] === v || skip.includes(p)) continue;
      if (INHERIT.includes(p) && ps && ps.getPropertyValue(p).trim() === v) continue;
      if (p === 'border' && /0px none/.test(v)) continue;
      if (p === 'width' && v.endsWith('px') && parent && Math.abs(parseFloat(v) - parent.clientWidth) < 2) continue;
      if (p === 'position' && v === 'relative' && cs.top === 'auto' && cs.left === 'auto') continue;
      if (p === 'grid-template-columns' && /px/.test(v)) {
        /*
         * Resolved track sizes are this window's answer, not the design's — but
         * equal fractions are a different design. A hero whose columns are 8:5
         * became 1:1, which reflowed the headline and the paragraph under it
         * into a narrow column that is nothing like the page. Keeping the
         * *proportions* as fr units is both responsive and the same layout.
         */
        const tracks = v.split(' ').map(parseFloat).filter((n) => n > 0);
        const min = Math.min(...tracks);
        out.push(tracks.length
          ? `grid-template-columns:${tracks.map((t) => `${(t / min).toFixed(2)}fr`).join(' ')}`
          : `grid-template-columns:repeat(${v.split(' ').length}, minmax(0, 1fr))`);
        continue;
      }
      out.push(`${p}:${v}`);
    }
    const opacity = cs.opacity;
    if (opacity !== '0' && opacity !== '1') out.push(`opacity:${opacity}`);
    return round(out.join(';'));
  }

  /*
   * A <div> inside a <p> is not a nesting error, it is a *parse* error: every
   * HTML parser closes the paragraph before the div. The avatar in the hero was
   * emitted as a div inside the byline's <p>, so it left the paragraph, lost
   * the 54px box the flex row gave it, and rendered as a 1136px square — which
   * was most of the home page's height difference.
   *
   * So anything written inside an inline element is a <span> carrying its
   * computed display, which is legal there and lays out identically.
   */
  const INLINE_ONLY = new Set(['p', 'span', 'a', 'strong', 'em', 'b', 'i', 'label', 'summary', 'figcaption']);

  function walk(el, depth, parentTag) {
    if (SKIP.has(el.tagName)) return '';
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return '';
    const boxTag = INLINE_ONLY.has(parentTag) ? 'span' : 'div';
    const asBlock = boxTag === 'span' ? 'display:block;' : '';
    if (el.tagName === 'IMG' || el.tagName === 'PICTURE') {
      /*
       * A placeholder that occupies what the image occupied.
       *
       * Dropping the image's own styles and giving the box an aspect ratio
       * turned every `position: absolute; inset: 0` cover image into a block in
       * the flow — the home page's hero grew by 1641px, because a 1440-wide box
       * at the image's ratio is 960 tall where the real one filled a 691px
       * frame. So: keep the styles, and only ask for a ratio when the thing is
       * actually in the flow and free to choose its own height.
       */
      const box = el.getBoundingClientRect();
      const fills = cs.position === 'absolute' || cs.position === 'fixed';
      const ratio = box.width && box.height ? (box.width / box.height).toFixed(2) : '1.5';
      // A 54px avatar is not a fluid image: only one that already fills its
      // parent gets to keep doing that, and the rest keep the box they had.
      const parentWidth = el.parentElement?.clientWidth ?? 0;
      const fluid = parentWidth > 0 && Math.abs(box.width - parentWidth) < 2;
      const size = fills ? 'width:100%;height:100%'
        : fluid ? `aspect-ratio:${ratio};width:100%`
          : `width:${Math.round(box.width)}px;height:${Math.round(box.height)}px`;
      const display = cs.display === 'inline' ? 'display:inline-block;' : asBlock;
      return `<${boxTag} style="${display}${styleOf(el)};background-color:#e7ded1;border-radius:${cs.borderRadius};${size}"></${boxTag}>`;
    }
    let tag = TAGS.has(el.tagName.toLowerCase()) ? el.tagName.toLowerCase() : 'div';
    if (INLINE_ONLY.has(parentTag) && !INLINE_ONLY.has(tag) && tag !== 'br') tag = 'span';
    // A span standing in for a block keeps the block's layout explicitly.
    const style = (tag === 'span' && cs.display !== 'inline' ? `display:${cs.display};` : '')
      + styleOf(el);
    /*
     * Markers drawn with ::before are content here.
     *
     * A bulleted item is usually a two-column grid whose first column holds a
     * pseudo-element. Dropped, the text lands in the marker's column and wraps
     * at sixty pixels — one line became eight. A document has no pseudo
     * elements, so the marker is written as a real one.
     */
    const marker = (pseudo) => {
      const ps = getComputedStyle(el, pseudo);
      const content = ps.content;
      if (!content || content === 'none' || content === 'normal') return '';
      if (ps.display === 'none') return '';
      const text = /^["']/.test(content) ? content.slice(1, -1) : '';
      const box = [
        `display:${ps.display === 'inline' ? 'inline' : ps.display}`,
        ps.width !== 'auto' ? `width:${ps.width}` : '',
        ps.height !== 'auto' ? `height:${ps.height}` : '',
        ps.backgroundColor !== 'rgba(0, 0, 0, 0)' ? `background-color:${ps.backgroundColor}` : '',
        ps.borderRadius !== '0px' ? `border-radius:${ps.borderRadius}` : '',
        ps.color ? `color:${ps.color}` : '',
        ps.fontSize ? `font-size:${ps.fontSize}` : '',
        ps.opacity !== '1' ? `opacity:${ps.opacity}` : '',
      ].filter(Boolean).join(';');
      if (!text && !/background-color|width/.test(box)) return '';
      return `<span style="${round(box)}">${esc(text)}</span>`;
    };

    let inner = marker('::before');
    for (const n of el.childNodes) {
      if (n.nodeType === 3) {
        const t = n.textContent.replace(/\s+/g, ' ');
        if (t.trim()) inner += esc(t);
      } else if (n.nodeType === 1 && depth < 16) inner += walk(n, depth + 1, tag);
    }
    inner += marker('::after');
    if (!inner.trim() && !/background|border|aspect/.test(style)) return '';
    return `<${tag}${style ? ` style="${style}"` : ''}>${inner}</${tag}>`;
  }

  const main = document.querySelector('main') || document.body;
  const sections = [...main.children]
    .map((el) => walk(el, 1, 'div'))
    .filter((html) => html.trim().length > 0);
  return {
    title: document.title,
    height: Math.ceil(document.body.scrollHeight),
    wrapper: styleOf(main),
    sections,
  };
}

/** The site's own custom properties, so the import arrives tokenised. */
function readVars() {
  const vars = {};
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules) {
        if (rule.selectorText !== ':root' && rule.selectorText !== 'html') continue;
        for (const p of rule.style) {
          if (p.startsWith('--')) vars[p.slice(2)] = rule.style.getPropertyValue(p).trim();
        }
      }
    } catch { /* a cross-origin sheet has no readable rules */ }
  }
  return vars;
}


export { extractor, readVars };
