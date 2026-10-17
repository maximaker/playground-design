/**
 * Colours inside a vector layer's SVG markup: listing them for the properties
 * panel, and swapping one for another (a hex, or a document token).
 *
 * Colours live in three places in real SVG — presentation attributes
 * (`fill="#F25A12"`), inline styles (`style="fill:#F25A12"`) and `<style>`
 * blocks — and all three are read and rewritten. A token can only be used
 * from CSS (`var()` is not valid in a presentation attribute), so an
 * attribute that becomes a token moves into the element's style.
 */

const COLOR_PROPS = ['fill', 'stroke', 'stop-color', 'flood-color', 'lighting-color', 'color'];
const SKIP = /^(none|transparent|currentcolor|inherit|initial|unset|context-fill|context-stroke)$|^url\(/i;

/** The vector's whole markup: its own attributes around its inner SVG. */
export function vectorMarkup(attrs: Record<string, string>, inner: string): string {
  const a = Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${v.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`)
    .join('');
  return `<svg${a}>${inner}</svg>`;
}

const norm = (c: string) => c.trim().replace(/\s+/g, ' ').toLowerCase();

/** Every distinct colour the markup paints with, in order of first use. */
export function svgColors(markup: string): string[] {
  const seen = new Map<string, string>();
  const add = (raw: string) => {
    const c = raw.trim();
    if (!c || SKIP.test(c)) return;
    if (!seen.has(norm(c))) seen.set(norm(c), c);
  };
  const attrRe = new RegExp(`\\s(${COLOR_PROPS.join('|')})\\s*=\\s*"([^"]*)"`, 'gi');
  for (const m of markup.matchAll(attrRe)) add(m[2]!);
  const declRe = new RegExp(`(?:^|[;{\\s"])(${COLOR_PROPS.join('|')})\\s*:\\s*([^;}"]+)`, 'gi');
  for (const m of markup.matchAll(declRe)) add(m[2]!.replace(/\s*!important\s*$/i, ''));
  return [...seen.values()];
}

/** Replaces one colour with another everywhere it is painted. */
export function replaceSvgColor(markup: string, from: string, to: string): string {
  const target = norm(from);
  const isVar = /^var\(/i.test(to.trim());
  const props = COLOR_PROPS.join('|');

  // Declarations, in inline styles and <style> blocks alike.
  let out = markup.replace(
    new RegExp(`((?:^|[;{\\s"])(?:${props})\\s*:\\s*)([^;}"]+)`, 'gi'),
    (all, head: string, value: string) => (norm(value.replace(/\s*!important\s*$/i, '')) === target ? head + to : all),
  );

  // Presentation attributes, one start tag at a time so a token can move into
  // that element's own style.
  out = out.replace(/<[a-zA-Z][^>]*>/g, (tag) => {
    const moved: string[] = [];
    let t = tag.replace(new RegExp(`\\s(${props})\\s*=\\s*"([^"]*)"`, 'gi'), (all, prop: string, value: string) => {
      if (norm(value) !== target) return all;
      if (!isVar) return ` ${prop}="${to}"`;
      moved.push(`${prop.toLowerCase()}:${to}`);
      return '';
    });
    if (moved.length) {
      if (/\sstyle\s*=\s*"/i.test(t)) t = t.replace(/(\sstyle\s*=\s*")([^"]*)"/i, (_m, h: string, s: string) => `${h}${s.trim().replace(/;?$/, ';')}${moved.join(';')}"`);
      else t = t.replace(/(\/?>)$/, ` style="${moved.join(';')}"$1`);
    }
    return t;
  });
  return out;
}
