/**
 * Importing a page as a browser sees it.
 *
 * The static importer fetches markup and stylesheets and parses them, which was
 * fine when pages shipped their own CSS. On anything built with utility classes
 * it produces unstyled markup: the classes are not the design, and without a
 * layout engine nothing resolves them. It also cannot see anything a script
 * draws, and a page that reveals its sections on scroll arrives invisible.
 *
 * So this one drives the browser the server already uses for thumbnails: it
 * loads the page at a real width, scrolls it end to end so the reveals have
 * run, and reads the computed styles. The reading itself lives in shared, in
 * `page-extract.ts`, because the same code has to run for the tool and for the
 * scripts that built the first import — a fidelity fix is worth nothing if only
 * one of them has it.
 */

import { extractPage, readPageVars, type PageShot, type Token } from '@playground/shared';
import { getBrowser, tryLoadPlaywright } from './browser.ts';
import { assertPublicUrl, ImportError } from './import.ts';

export interface LivePage extends PageShot { route: string }

export interface LiveImport {
  pages: LivePage[];
  /** The site's own custom properties, which become the document's tokens. */
  vars: Record<string, string>;
  warnings: string[];
}

const SETTLE = `(async () => {
  for (let y = 0; y < document.body.scrollHeight; y += 600) {
    window.scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 40));
  }
  window.scrollTo(0, 0);
  await new Promise((r) => setTimeout(r, 500));
})()`;

/**
 * Reads one page, or several routes of the same site.
 *
 * Returns null when there is no browser to drive, so the caller can fall back
 * to the static importer rather than failing: a serverless host has no
 * Chromium and a worse import is better than none.
 */
export async function importUrlLive(
  raw: string,
  opts: { width?: number; routes?: string[] } = {},
): Promise<LiveImport | null> {
  const width = Math.min(3840, Math.max(320, Math.round(opts.width ?? 1440)));
  const first = await assertPublicUrl(raw);

  const pw = await tryLoadPlaywright();
  if (!pw) return null;

  const routes = (opts.routes?.length ? opts.routes : [first.pathname || '/'])
    .map((r) => r.trim())
    .filter(Boolean);
  for (const route of routes) {
    if (!route.startsWith('/')) {
      throw new ImportError(`Routes are paths on the same site, so they start with "/" (got "${route}").`);
    }
  }

  const browser = await getBrowser(pw);
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
  const warnings: string[] = [];
  const pages: LivePage[] = [];
  let vars: Record<string, string> = {};

  try {
    const page = await context.newPage();
    for (const route of routes) {
      const url = new URL(route, first).toString();
      await assertPublicUrl(url);
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
      } catch {
        warnings.push(`${route} did not finish loading in 30s; imported what had arrived.`);
      }
      await page.evaluate(SETTLE as unknown as () => unknown).catch(() => {});
      if (!Object.keys(vars).length) vars = await page.evaluate(readPageVars);
      const shot = await page.evaluate(extractPage);
      if (!shot.sections.length) warnings.push(`${route} produced no sections — is it client-rendered behind a login?`);
      pages.push({ ...shot, route });
    }
  } finally {
    await context.close();
  }

  return { pages, vars, warnings };
}

/** `#f0451f` as `rgb(240, 69, 31)`, which is how a computed style spells it. */
function toRgb(hex: string): string | null {
  const m = /^#?([\da-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

const colourVars = (vars: Record<string, string>) =>
  Object.entries(vars).filter(([, v]) => /^#[\da-f]{6}$/i.test(v.trim()));
const radiusVars = (vars: Record<string, string>) =>
  Object.entries(vars).filter(([, v]) => /^\d+(\.\d+)?px$/.test(v.trim()));
const fontVars = (vars: Record<string, string>) =>
  Object.entries(vars).filter(([, v]) => /["']/.test(v));

/**
 * The site's variables as the document's tokens.
 *
 * This is the whole point of importing into this tool rather than screenshotting
 * it: a page whose author wrote `--olive` should arrive with a token called
 * olive, not with ninety copies of #7d8b53.
 */
export function tokensFromVars(vars: Record<string, string>): Token[] {
  return [
    ...colourVars(vars).map(([name, value]): Token => ({
      name: `color.${name}`, group: 'color', values: { default: value },
    })),
    ...radiusVars(vars).map(([name, value]): Token => ({
      name: `radius.${name.replace(/^r-/, '')}`, group: 'radius', values: { default: value },
    })),
    ...fontVars(vars).map(([name, value]): Token => ({
      name: `font.${name}`, group: 'font', values: { default: value },
    })),
  ];
}

/** Rewrites resolved values back to the names the site gave them. */
export function tokenise(html: string, vars: Record<string, string>): string {
  let out = html;
  for (const [name, value] of colourVars(vars)) {
    const rgb = toRgb(value);
    if (rgb) out = out.split(rgb).join(`var(--color-${name})`);
    out = out.split(value.toLowerCase()).join(`var(--color-${name})`);
  }
  for (const [name, value] of radiusVars(vars)) {
    out = out.replace(new RegExp(`border-radius:${value}(?=[;"])`, 'g'),
      `border-radius:var(--radius-${name.replace(/^r-/, '')})`);
  }
  return out;
}
