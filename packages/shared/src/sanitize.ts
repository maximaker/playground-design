/**
 * Vector markup is the one place raw HTML reaches the canvas verbatim: an SVG's
 * innerHTML is kept as-is because re-authoring it as nodes loses detail.
 *
 * `parseHtml` already drops <script> elements, but markup can also arrive
 * through set_vector, paste, or a document restored from an older build — and
 * inline event handlers survive all of those. Artboards that host a code
 * component run with scripts enabled, so "the artboard cannot execute anything"
 * stopped being true for the whole canvas; this is the replacement guarantee,
 * applied at render and at export rather than trusted at the entry points.
 */

const SCRIPT = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;
const OPEN_SCRIPT = /<script\b[^>]*\/?>/gi;
/** on* handler attributes, quoted or bare. */
const HANDLER = /\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
/** javascript: in href/src, with the usual whitespace obfuscation. */
const JS_URL = /((?:xlink:)?href|src)\s*=\s*(["']?)\s*j[\s-]*a[\s-]*v[\s-]*a[\s-]*s[\s-]*c[\s-]*r[\s-]*i[\s-]*p[\s-]*t[\s-]*:/gi;

export function sanitizeMarkup(markup: string): string {
  return markup
    .replace(SCRIPT, '')
    .replace(OPEN_SCRIPT, '')
    .replace(HANDLER, '')
    .replace(JS_URL, '$1=$2#blocked:');
}
