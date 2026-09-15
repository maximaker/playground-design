/**
 * Signs the checks and demo scripts in.
 *
 * The API needs an account now, and thirty-odd scripts were written when it did
 * not. Rather than thread credentials through each one, importing this module
 * installs two things:
 *
 *  - a `fetch` that carries a session cookie per origin, and that logs in and
 *    retries once when a request comes back 401;
 *  - a Playwright `page.goto` that makes sure the browser has that same cookie
 *    before it navigates, so a script that drives the editor is signed in too.
 *
 * Both are lazy: nothing logs in until something actually needs to. A script
 * that only talks MCP never creates an account, because a connection code is
 * its own credential and always was.
 *
 * Credentials come from PLAYGROUND_EMAIL / PLAYGROUND_PASSWORD. The defaults are
 * for a local instance; against a real one, set them — the fallback would
 * otherwise create a stray account on your server.
 */

const EMAIL = process.env.PLAYGROUND_EMAIL ?? 'checks@playground.local';
const PASSWORD = process.env.PLAYGROUND_PASSWORD ?? 'local-checks-password';

/** origin → cookie header. */
const cookies = new Map();
/** origin → in-flight login, so twenty parallel requests cause one sign-up. */
const pending = new Map();

const realFetch = globalThis.fetch.bind(globalThis);

async function login(origin) {
  if (cookies.has(origin)) return cookies.get(origin);
  if (pending.has(origin)) return pending.get(origin);

  const attempt = (async () => {
    const body = JSON.stringify({ email: EMAIL, password: PASSWORD, name: 'Checks' });
    const headers = { 'content-type': 'application/json' };
    // Sign up first: on a fresh instance that also claims the seeded document,
    // which is what the checks expect to find. An existing account answers 409
    // and the login below picks it up.
    let res = await realFetch(`${origin}/api/auth/signup`, { method: 'POST', headers, body });
    if (!res.ok) res = await realFetch(`${origin}/api/auth/login`, { method: 'POST', headers, body });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`could not sign in to ${origin} as ${EMAIL} (${res.status}) ${detail.slice(0, 160)}`);
    }
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
    if (!cookie) throw new Error(`${origin} accepted the sign-in but set no cookie`);
    cookies.set(origin, cookie);
    return cookie;
  })();

  pending.set(origin, attempt);
  try { return await attempt; } finally { pending.delete(origin); }
}

globalThis.fetch = async function signedInFetch(input, init = {}) {
  const url = typeof input === 'string' ? input : input.url;
  let origin;
  try { origin = new URL(url).origin; } catch { return realFetch(input, init); }

  const withCookie = (cookie) => ({
    ...init,
    headers: { ...(init.headers ?? {}), ...(cookie ? { cookie } : {}) },
  });

  const first = await realFetch(input, withCookie(cookies.get(origin)));
  if (first.status !== 401) return first;

  // 401 once is the signal to log in; 401 twice is a real failure and is
  // returned as-is rather than retried in a loop.
  await login(origin);
  return realFetch(input, withCookie(cookies.get(origin)));
};

/** The cookie header for an origin, for callers that bypass fetch — WebSockets. */
export async function sessionCookie(origin) {
  return cookies.get(origin) ?? await login(origin);
}

// --- Playwright ---------------------------------------------------------------
//
// `chromium` is a module singleton, so wrapping its methods here reaches every
// script that imports it.

try {
  const { chromium } = await import('playwright');
  const launch = chromium.launch.bind(chromium);
  chromium.launch = async (...args) => {
    const browser = await launch(...args);
    const newPage = browser.newPage.bind(browser);
    browser.newPage = async (...pageArgs) => wrapPage(await newPage(...pageArgs));
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (...ctxArgs) => {
      const context = await newContext(...ctxArgs);
      const ctxPage = context.newPage.bind(context);
      context.newPage = async () => wrapPage(await ctxPage());
      return context;
    };
    return browser;
  };
} catch {
  // No Playwright in this script's dependency graph; the fetch half still works.
}

function wrapPage(page) {
  const goto = page.goto.bind(page);
  page.goto = async (url, ...rest) => {
    try {
      const origin = new URL(url).origin;
      if (url.startsWith('http')) {
        const cookie = await sessionCookie(origin);
        const [name, value] = cookie.split('=');
        await page.context().addCookies([{ name, value, url: origin }]);
      }
    } catch {
      // A file:// URL, or an instance that needs no account. Navigate anyway.
    }
    return goto(url, ...rest);
  };
  return page;
}
