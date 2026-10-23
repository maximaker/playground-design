/**
 * Where a link says to present from.
 *
 * A share link carries it in the path, /s/<token>/<page>/<frame>, so what
 * people are sent is a plain address; the editor's own presentations keep the
 * ?present=<page>&frame=<n> query. Page ids lose their "p_" in the path.
 */
export interface PresentTarget { pageId: string; frame: number }

const PATH = /^\/s\/[\w-]+\/([\w-]+)(?:\/(\d+))?\/?$/;

export function presentFromUrl(url: URL = new URL(window.location.href)): PresentTarget | null {
  const m = PATH.exec(url.pathname);
  if (m) return { pageId: `p_${m[1]}`, frame: Math.max(1, Number(m[2] ?? 1)) };
  const q = url.searchParams.get('present');
  return q ? { pageId: q, frame: Math.max(1, Number(url.searchParams.get('frame') ?? 1)) } : null;
}

/** A share link that opens a page as a presentation. */
export function sharePresentUrl(shareUrl: string, pageId: string, frame = 1): string {
  const u = new URL(shareUrl, window.location.origin);
  u.search = '';
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/${pageId.replace(/^p_/, '')}${frame > 1 ? `/${frame}` : ''}`;
  return u.toString();
}

/** The same address with the frame changed, in whichever form it came. */
export function withPresent(url: URL, target: PresentTarget | null): URL {
  const next = new URL(url);
  const m = /^(\/s\/[\w-]+)/.exec(next.pathname);
  if (m && PATH.test(next.pathname)) {
    next.pathname = target ? new URL(sharePresentUrl(m[1]!, target.pageId, target.frame)).pathname : m[1]!;
    return next;
  }
  if (target) {
    next.searchParams.set('present', target.pageId);
    next.searchParams.set('frame', String(target.frame));
  } else {
    next.searchParams.delete('present');
    next.searchParams.delete('frame');
  }
  return next;
}
