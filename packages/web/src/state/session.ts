/**
 * Who is signed in.
 *
 * One fetch at boot, then a value every screen can read. The cookie is
 * httpOnly, so the client cannot inspect it — `/api/auth/state` is the only way
 * to know, and it is also how the app learns whether this instance has any
 * accounts yet, which decides between "sign in" and "create the first account".
 */

import { useEffect, useState } from 'react';

export interface Account {
  id: string;
  email: string;
  name: string;
  color: string;
  emailVerified: boolean;
}

export interface SessionState {
  /** Null while the first request is in flight — not the same as signed out. */
  loading: boolean;
  user: Account | null;
  /** False on a brand new instance, which offers to create the first account. */
  hasAccounts: boolean;
  /** Whether sign-up needs the shared code the operator configured. */
  signupCodeRequired: boolean;
  /** Set when the server cannot be reached at all, so the UI can say so. */
  error: string | null;
}

export async function fetchSession(): Promise<Omit<SessionState, 'loading'>> {
  try {
    const res = await fetch('/api/auth/state', { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`${res.status}`);
    const body = (await res.json()) as
      { user: Account | null; hasAccounts: boolean; signupCodeRequired?: boolean };
    return {
      user: body.user, hasAccounts: body.hasAccounts,
      signupCodeRequired: !!body.signupCodeRequired, error: null,
    };
  } catch {
    return { user: null, hasAccounts: true, signupCodeRequired: false, error: 'Could not reach the server.' };
  }
}

export function useSession(): SessionState & { refresh: () => Promise<void> } {
  const [state, setState] = useState<SessionState>({
    loading: true, user: null, hasAccounts: true, signupCodeRequired: false, error: null,
  });

  const refresh = async () => {
    const next = await fetchSession();
    setState({ ...next, loading: false });
  };

  useEffect(() => { void refresh(); }, []);

  // A 401 from anywhere else means the session expired while the tab was open;
  // rather than every caller handling that, the window event re-checks once.
  useEffect(() => {
    const onExpired = () => { void refresh(); };
    window.addEventListener('playground:unauthenticated', onExpired);
    return () => window.removeEventListener('playground:unauthenticated', onExpired);
  }, []);

  return { ...state, refresh };
}

/** Announces a 401 so the session can be re-checked once, from anywhere. */
export function sessionExpired(): void {
  window.dispatchEvent(new Event('playground:unauthenticated'));
}

export async function signIn(email: string, password: string): Promise<Account> {
  return post('/api/auth/login', { email, password });
}

export async function signUp(
  email: string, password: string, name: string, code?: string,
): Promise<Account> {
  return post('/api/auth/signup', { email, password, name, code });
}

export async function signOut(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
}

async function post(url: string, body: unknown): Promise<Account> {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => ({}))) as { user?: Account; error?: string };
  if (!res.ok || !parsed.user) throw new Error(parsed.error ?? 'That did not work. Try again.');
  return parsed.user;
}
