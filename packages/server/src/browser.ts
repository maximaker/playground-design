/**
 * The headless browser, shared.
 *
 * Playwright is an optional dependency: the server runs without it and simply
 * cannot render or import live pages, which is the right behaviour on a
 * serverless host where no browser can be installed. Everything that needs one
 * asks here, so there is one browser process and one place that knows how to
 * fail politely.
 */

export interface PlaywrightElement { screenshot(opts: Record<string, unknown>): Promise<Uint8Array> }

export interface PlaywrightPage {
  setContent(html: string, opts?: { waitUntil?: string }): Promise<void>;
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  evaluate<T = unknown, A = unknown>(fn: ((arg: A) => T) | string, arg?: A): Promise<T>;
  $(selector: string): Promise<PlaywrightElement | null>;
  screenshot(opts: Record<string, unknown>): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface PlaywrightContext {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
}

export interface PlaywrightBrowser {
  newContext(opts: Record<string, unknown>): Promise<PlaywrightContext>;
  close(): Promise<void>;
}

export interface PlaywrightModule {
  chromium: { launch(opts?: Record<string, unknown>): Promise<PlaywrightBrowser> };
}

let playwrightCache: PlaywrightModule | null | undefined;
let browserPromise: Promise<PlaywrightBrowser> | null = null;

export async function tryLoadPlaywright(): Promise<PlaywrightModule | null> {
  if (playwrightCache !== undefined) return playwrightCache;
  try {
    playwrightCache = (await import(/* @vite-ignore */ 'playwright' as string)) as PlaywrightModule;
  } catch {
    playwrightCache = null;
  }
  return playwrightCache;
}

export async function getBrowser(pw: PlaywrightModule) {
  // One browser, reused: launching per screenshot costs ~400ms and agents take
  // screenshots in tight loops while checking their own work.
  if (!browserPromise) {
    browserPromise = pw.chromium.launch({ args: ['--font-render-hinting=none'] }).catch((err: unknown) => {
      browserPromise = null;
      throw new Error(
        `Playwright is installed but Chromium failed to launch (${err instanceof Error ? err.message : err}). `
        + 'Run "npx playwright install chromium".',
      );
    });
  }
  return browserPromise;
}

/** Closes the shared browser, if one was ever launched. */
export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  const browser = await browserPromise.catch(() => null);
  await browser?.close().catch(() => {});
  browserPromise = null;
}
