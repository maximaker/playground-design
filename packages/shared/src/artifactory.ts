/**
 * Artifactory — the sibling UX-artifact studio — publishes read-only share
 * links at `<origin>/#/s/<slug>`. Its chrome-less twin, `#/e/<slug>`, drops the
 * header and footer so the artifact can sit in an embed node beside screens.
 *
 * Kept here, not in the server, so the editor can use the same rule when a
 * share link is pasted.
 */

const SHARE_HASH = /^#\/(?:s|e)\/([A-Za-z0-9_-]+)\/?$/;

/**
 * The embed URL for an Artifactory share link, or null when the string is not
 * one. Accepts the share URL, an already-embed URL, or a bare slug when an
 * origin is supplied.
 */
export function artifactoryEmbedUrl(input: string, origin?: string): string | null {
  const raw = input.trim();
  if (/^[A-Za-z0-9_-]+$/.test(raw)) {
    return origin ? `${origin.replace(/\/+$/, '')}/#/e/${raw}` : null;
  }
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const match = url.hash.match(SHARE_HASH);
  if (!match) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}/#/e/${match[1]}`;
}
