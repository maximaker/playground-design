/**
 * Reading a live page as something a document can hold.
 *
 * Everything here runs *inside the page*, handed to a browser by whoever is
 * driving it — the server's import tool, or a script. That is the constraint
 * that shapes the file: no imports, no module-scope references, nothing but
 * what the page itself provides.
 *
 * What it produces is not the site's markup. It is a simplified tree with the
 * *computed* styles inlined, which is the only honest way to read a page built
 * with utility classes: the classes are not the design, the values they resolve
 * to are. Several of the rules below are scars — each one is a way the obvious
 * approach produced a document that was not the page.
 */

export interface PageShot {
  title: string;
  /** The document's full height at the width it was read. */
  height: number;
  /** Styles for the wrapper the sections go into. */
  wrapper: string;
  /** One entry per top-level band of the page. */
  sections: string[];
}

export function extractPage(): PageShot {
  const KEEP = ['display', 'flex-direction', 'flex-wrap', 'align-items', 'justify-content', 'gap',
    'grid-template-columns', 'padding', 'margin', 'max-width', 'min-height', 'background-color',
    'background-image', 'color', 'font-family', 'font-size', 'font-weight', 'line-height',
    'letter-spacing', 'text-transform', 'text-align', 'white-space', 'border-radius', 'border', 'box-shadow',
    'position', 'top', 'left', 'right', 'bottom', 'overflow', 'aspect-ratio', 'flex', 'width',
    'grid-column', 'grid-row', 'align-self', 'justify-self', 'order'];
  const DEF: Record<string, string> = {
    display: 'block', 'flex-direction': 'row', 'flex-wrap': 'nowrap', 'align-items': 'normal',
    'justify-content': 'normal', gap: 'normal', padding: '0px', margin: '0px',
    'background-color': 'rgba(0, 0, 0, 0)', 'background-image': 'none', 'border-radius': '0px',
    'box-shadow': 'none', position: 'static', overflow: 'visible', 'text-transform': 'none',
    'letter-spacing': 'normal', 'text-align': 'start', 'aspect-ratio': 'auto', 'max-width': 'none',
    'min-height': '0px', flex: '0 1 auto', 'grid-template-columns': 'none', 'white-space': 'normal',
    top: 'auto', left: 'auto', right: 'auto', bottom: 'auto', width: 'auto',
    // A feature tile that spans two columns and two rows is not a tile the size
    // of the others. Its width used to be recorded, which faked the span; once
    // widths went, the gallery lost three hundred pixels until the span itself
    // was read.
    'grid-column': 'auto', 'grid-row': 'auto', 'align-self': 'auto',
    'justify-self': 'auto', order: '0',
  };
  const INHERIT = ['color', 'font-family', 'font-size', 'font-weight', 'line-height'];
  /*
   * Tags the browser's own stylesheet gives a box to.
   *
   * Everything here is a *computed* style, so a property equal to its initial
   * value is normally worth nothing and is dropped. That reasoning breaks for
   * exactly these tags: the site zeroes their margins in its reset, the zero
   * looks like the initial value and is dropped, and the document then renders
   * them with the UA's margins instead — which is where the recurring 32px on
   * every page's first band came from (a <figure>, quietly 1em away from its
   * neighbours). For these, a zero is a fact and gets written down.
   */
  const UA_BOX: Record<string, string[]> = {
    p: ['margin'], h1: ['margin'], h2: ['margin'], h3: ['margin'], h4: ['margin'],
    h5: ['margin'], h6: ['margin'], figure: ['margin'], figcaption: [], blockquote: ['margin'],
    ul: ['margin', 'padding'], ol: ['margin', 'padding'], dl: ['margin'], dd: ['margin'],
    pre: ['margin'], form: ['margin'], fieldset: ['margin', 'padding'], hr: ['margin'],
    button: ['margin', 'padding'], input: ['margin'], select: ['margin'], textarea: ['margin'],
  };
  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'link', 'meta']);
  const TAGS = new Set(['section', 'div', 'header', 'footer', 'nav', 'main', 'article', 'aside',
    'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'p', 'span', 'a', 'button', 'strong', 'em',
    'blockquote', 'figure', 'figcaption', 'details', 'summary', 'label', 'form', 'br']);
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  /*
   * Lengths are rounded so a document is not full of 21.6px, but type is not.
   * A 26.4px line height read as 26px is four hundredths of a line lost per
   * line, which is a band twenty pixels short by the bottom of it — and a
   * 12.16px label rounded to 12px wraps a word differently. Anything that
   * decides where text breaks keeps its fraction.
   */
  const EXACT = /^(font-size|line-height|letter-spacing|word-spacing)$/;
  const round = (prop: string, v: string) =>
    EXACT.test(prop) ? v : v.replace(/(\d+\.\d+)px/g, (_, n) => `${Math.round(Number(n))}px`);
  // Widths and heights round up: a box a fraction narrower than its content
  // reflows it, while a fraction wider is invisible.
  const ceilPx = (n: number) => `${Math.ceil(n)}px`;

  function styleOf(el: Element, skip: string[] = [], root = false): string {
    const ua = UA_BOX[el.tagName.toLowerCase()] ?? [];
    const cs = getComputedStyle(el);
    const parent = el.parentElement;
    const ps = parent ? getComputedStyle(parent) : null;
    const out = [];
    for (const p of KEEP) {
      const v = cs.getPropertyValue(p).trim();
      if (!v || skip.includes(p)) continue;
      if (DEF[p] === v && !ua.includes(p)) continue;
      // The root carries the typography everything under it inherits; there is
      // no page above it to inherit from once it is in a document.
      if (!root && INHERIT.includes(p) && ps && ps.getPropertyValue(p).trim() === v) continue;
      if (p === 'border' && /0px none/.test(v)) continue;
      if (p === 'width' && v.endsWith('px') && parent && Math.abs(parseFloat(v) - parent.clientWidth) < 2) continue;
      /*
       * A box with anything inside it sizes itself. The computed width is what
       * this window happened to give it, and writing it down pins a chip or a
       * button row to a measurement that is a fraction of a pixel out — every
       * badge on the site wrapped onto a second line, and the row of call to
       * action links wrapped because its two children now added up to one pixel
       * more than the width recorded for the row. Only empty boxes, which have
       * nothing to size to, keep a width.
       */
      if (p === 'width' && el.childNodes.length) continue;
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
      /*
       * A width rounded down is a width the content no longer fits in: one chip
       * at 174.4px became 174px and wrapped onto a second line, and because its
       * row stretches, every chip beside it doubled in height too.
       */
      out.push(`${p}:${p === 'width' || p === 'min-height' || p === 'max-width'
        ? v.replace(/(\d+\.\d+)px/g, (_, n) => ceilPx(Number(n)))
        : round(p, v)}`);
    }
    if (/^(ul|ol|li)$/.test(el.tagName.toLowerCase())) {
      // A list without its site's `list-style: none` grows bullets it never had.
      out.push(`list-style:${cs.listStyleType} ${cs.listStylePosition}`);
    }
    const opacity = cs.opacity;
    if (opacity !== '0' && opacity !== '1') out.push(`opacity:${opacity}`);
    return out.join(';');
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

  function walk(el: Element, depth: number, parentTag: string): string {
    // An <svg> reports a lowercase tagName, which is how one spent two hours
    // being not-skipped: it came through as an empty div, collapsed to zero
    // height, and the button it sat in wrapped onto a second line.
    const lower = el.tagName.toLowerCase();
    if (SKIP.has(lower)) return '';
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return '';
    const boxTag = INLINE_ONLY.has(parentTag) ? 'span' : 'div';
    const asBlock = boxTag === 'span' ? 'display:block;' : '';
    if (lower === 'svg') {
      /*
       * An icon is not worth reconstructing, but its box is: dropped, the row
       * it sits in loses a column and the label beside it rewraps. So it keeps
       * the space it occupied, tinted with the colour it was drawn in.
       */
      const box = el.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) return '';
      return `<${boxTag} style="display:inline-block;flex:none;width:${ceilPx(box.width)};`
        + `height:${ceilPx(box.height)};background-color:currentColor;opacity:0.25;border-radius:2px"></${boxTag}>`;
    }
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
          : `width:${ceilPx(box.width)};height:${ceilPx(box.height)}`;
      const display = cs.display === 'inline' ? 'display:inline-block;' : asBlock;
      return `<${boxTag} style="${display}${styleOf(el)};background-color:#e7ded1;border-radius:${cs.borderRadius};${size}"></${boxTag}>`;
    }
    let tag = TAGS.has(lower) ? lower : 'div';
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
    const marker = (pseudo: string): string => {
      const ps = getComputedStyle(el, pseudo);
      const content = ps.content;
      if (!content || content === 'none' || content === 'normal') return '';
      if (ps.display === 'none') return '';
      const text = /^["']/.test(content) ? content.slice(1, -1) : '';
      const box = [
        `display:${ps.display === 'inline' ? 'inline' : ps.display}`,
        // A decorative quote mark is usually lifted out of the flow. Copied
        // without that, it stands on top of the card and pushes the text down.
        ps.position !== 'static' ? `position:${ps.position}` : '',
        ...(ps.position !== 'static'
          ? (['top', 'right', 'bottom', 'left'] as const)
            .map((side) => (ps[side] !== 'auto' ? `${side}:${ps[side]}` : ''))
          : []),
        ps.width !== 'auto' ? `width:${ps.width}` : '',
        ps.height !== 'auto' ? `height:${ps.height}` : '',
        ps.backgroundColor !== 'rgba(0, 0, 0, 0)' ? `background-color:${ps.backgroundColor}` : '',
        ps.borderRadius !== '0px' ? `border-radius:${ps.borderRadius}` : '',
        ps.color ? `color:${ps.color}` : '',
        ps.fontSize ? `font-size:${ps.fontSize}` : '',
        ps.opacity !== '1' ? `opacity:${ps.opacity}` : '',
      ].filter(Boolean).join(';');
      if (!text && !/background-color|width/.test(box)) return '';
      const rounded = box
        .split(';')
        .map((d) => { const i = d.indexOf(':'); return i < 0 ? d : `${d.slice(0, i)}:${round(d.slice(0, i), d.slice(i + 1))}`; })
        .join(';');
      return `<span style="${rounded}">${esc(text)}</span>`;
    };

    let inner = marker('::before');
    for (const n of el.childNodes) {
      if (n.nodeType === 3) {
        const t = (n.textContent ?? '').replace(/\s+/g, ' ');
        if (t.trim()) inner += esc(t);
      } else if (n.nodeType === 1 && depth < 16) inner += walk(n as Element, depth + 1, tag);
    }
    inner += marker('::after');
    // An accordion the page opens for the reader is open in the design too.
    if (tag === 'details' && (el as HTMLDetailsElement).open) {
      return `<details open${style ? ` style="${style}"` : ''}>${inner}</details>`;
    }
    // A line break is empty by nature and is the whole point of the element.
    if (tag === 'br') return '<br />';
    if (!inner.trim() && !/background|border|aspect/.test(style)) return '';
    if (!inner.trim()) {
      /*
       * A decorative box — a rule, a dot, the 18px mark beside a badge — has
       * nothing inside to give it a height, and `height` is deliberately not
       * read for elements in general (every element computes one, and writing
       * them all down would freeze the design solid). Empty ones are the safe
       * exception, and without it the badge collapsed and its label wrapped.
       */
      const box = el.getBoundingClientRect();
      const size = `width:${ceilPx(box.width)};height:${ceilPx(box.height)};flex:none`;
      return `<${tag} style="${style ? `${style};` : ''}${size}"></${tag}>`;
    }
    return `<${tag}${style ? ` style="${style}"` : ''}>${inner}</${tag}>`;
  }

  const main = document.querySelector('main') || document.body;
  const sections = [...main.children]
    .map((el) => walk(el, 1, 'div'))
    .filter((html) => html.trim().length > 0);
  return {
    title: document.title,
    height: Math.ceil(document.body.scrollHeight),
    wrapper: styleOf(main, [], true),
    sections,
  };
}

/** The site's own custom properties, so the import arrives tokenised. */
export function readPageVars(): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules as unknown as CSSStyleRule[]) {
        if (rule.selectorText !== ':root' && rule.selectorText !== 'html') continue;
        for (const p of rule.style) {
          if (p.startsWith('--')) vars[p.slice(2)] = rule.style.getPropertyValue(p).trim();
        }
      }
    } catch { /* a cross-origin sheet has no readable rules */ }
  }
  return vars;
}
