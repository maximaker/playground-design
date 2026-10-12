import { SESSION_COOKIE, cookieValue, sessionUser } from './accounts.ts';
import type { StoredUser } from './persistence.ts';
import { persistence } from './persistence.ts';

/**
 * Single sign-on for the heymax family.
 *
 * With ID_URL set (https://id.heymax.im), who someone is comes from the
 * identity service's .heymax.im session: the request's cookie is forwarded to
 * its get-session endpoint and the person it names is mapped onto our own user
 * by email. Documents, memberships and shares stay ours.
 *
 * Without ID_URL the app's own accounts sign people in, as before.
 * LOCAL_LOGIN=true keeps them working alongside SSO while it beds in.
 */
const ID_URL = (process.env.ID_URL ?? '').replace(/\/$/, '');
const OWNER_EMAIL = process.env.OWNER_EMAIL?.trim().toLowerCase();
const LOCAL_LOGIN = process.env.LOCAL_LOGIN === 'true';

export const idUrl = ID_URL || null;

// Sign-out happens at the identity service; a cached answer is all that can
// keep someone signed in here after it, and a minute bounds that.
const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; userId: string | null }>();

function idCookie(header: string): string | null {
  const m = header.match(/(?:^|;\s*)((?:__Secure-)?heymax\.session_token)=([^;]+)/);
  return m ? `${m[1]}=${m[2]}` : null;
}

async function localUserFor(email: string): Promise<StoredUser | null> {
  const store = await persistence();
  const match = await store.loadUserByEmail(email.toLowerCase());
  if (match) return match;
  // The owner's address here may differ from the one they sign in with: the
  // first account on the instance is theirs.
  if (OWNER_EMAIL && email.toLowerCase() === OWNER_EMAIL) {
    const users = await store.listUsers();
    return users.sort((a, b) => a.createdAt - b.createdAt)[0] ?? null;
  }
  return null;
}

async function fromIdentityService(cookie: string): Promise<string | null> {
  const res = await fetch(`${ID_URL}/api/auth/get-session`, { headers: { cookie } });
  if (!res.ok) return null;
  const body = (await res.json()) as { user?: { email?: string } } | null;
  if (!body?.user?.email) return null;
  return (await localUserFor(body.user.email))?.id ?? null;
}

/** The signed-in user for a request's Cookie header, from whichever sign-in is active. */
export async function userFromCookies(header: string | undefined): Promise<StoredUser | null> {
  const local = () => sessionUser(cookieValue(header, SESSION_COOKIE));
  if (!ID_URL) return local();

  const cookie = idCookie(header ?? '');
  if (cookie) {
    let hit = cache.get(cookie);
    if (!hit || Date.now() - hit.at > CACHE_MS) {
      hit = { at: Date.now(), userId: await fromIdentityService(cookie).catch(() => null) };
      cache.set(cookie, hit);
      if (cache.size > 500) cache.delete(cache.keys().next().value!);
    }
    if (hit.userId) {
      const user = await (await persistence()).loadUser(hit.userId);
      if (user) return user;
    }
  }
  return LOCAL_LOGIN ? local() : null;
}
