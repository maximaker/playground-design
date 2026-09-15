/**
 * Accounts, sessions and who may open which document.
 *
 * Email and password, kept entirely inside this instance: no mail service and
 * no third party, because a self-hosted server with neither must still be able
 * to sign its owner in. Two consequences are deliberate:
 *
 *  - An address is recorded but never verified. `emailVerifiedAt` exists and
 *    stays null; nothing gates on it. An instance with no SMTP that refused
 *    unverified accounts would refuse every account it ever created.
 *  - Password reset is not a self-service flow, for the same reason. It is a
 *    command the operator runs on the server.
 *
 * The shape anticipates the other two sign-in methods. A magic link sets
 * `emailVerifiedAt` and leaves `passwordHash` null; an OAuth identity becomes a
 * row pointing at the same user. Neither needs this file's callers to change.
 *
 * Passwords are hashed with scrypt — in Node's standard library, memory-hard,
 * and the sensible choice when adding a native bcrypt dependency to a project
 * that otherwise has none is not.
 */

import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { MemberRole, StoredInvite, StoredMembership, StoredUser } from './persistence.ts';
import { persistence } from './persistence.ts';
import { listDocuments } from './store.ts';

const scryptAsync = promisify(scrypt) as (
  password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number },
) => Promise<Buffer>;

/** Cost parameters. N=16384 is ~100ms here, which is the right order for a login. */
const SCRYPT = { N: 16_384, r: 8, p: 1 };
const KEY_LENGTH = 64;

export const SESSION_COOKIE = 'playground_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** How stale `lastSeenAt` may get before the rolling expiry is written back. */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Presence colours. Assigned at sign-up and stored, so a person is the same
 * colour to everyone in the document and the same colour tomorrow — a colour
 * picked per connection makes "the green cursor" meaningless.
 */
const COLORS = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6'];

export class AuthError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

/** What the client is told about a person. Never includes the hash. */
export interface PublicUser {
  id: string;
  email: string;
  name: string;
  color: string;
  emailVerified: boolean;
}

export function publicUser(u: StoredUser): PublicUser {
  return {
    id: u.id, email: u.email, name: u.name, color: u.color,
    emailVerified: u.emailVerifiedAt !== null,
  };
}

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEY_LENGTH, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [scheme, n, r, p, salt, key] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length,
    { N: Number(n), r: Number(r), p: Number(p) });
  // Constant time: a fast "wrong" and a slow "wrong" are a password oracle.
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/** Deliberately permissive: this rejects typos, not unusual-but-valid addresses. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const MIN_PASSWORD = 10;

export function checkPassword(password: string): void {
  // Length only. Composition rules ("one number, one symbol") push people
  // towards `Password1!` and are not what makes a password hard to guess.
  if (password.length < MIN_PASSWORD) {
    throw new AuthError(`Use at least ${MIN_PASSWORD} characters.`);
  }
  if (password.length > 200) throw new AuthError('That password is too long.');
}

/**
 * An optional shared code that sign-up requires.
 *
 * A public instance with open sign-up hands the first person who finds it an
 * account — and on a fresh instance the first account claims every document on
 * it. Setting PLAYGROUND_SIGNUP_CODE closes that window without needing an
 * invitation system, which is the thing worth having before this is on the
 * internet rather than after.
 */
export function signupCodeRequired(): boolean {
  return !!process.env.PLAYGROUND_SIGNUP_CODE;
}

export async function createAccount(
  email: string, password: string, name?: string, code?: string,
): Promise<{ user: StoredUser; claimed: number }> {
  const expected = process.env.PLAYGROUND_SIGNUP_CODE;
  if (expected && code !== expected) {
    throw new AuthError('That sign-up code is not right.', 403);
  }
  const store = await persistence();
  const normalised = email.trim().toLowerCase();
  if (!EMAIL.test(normalised)) throw new AuthError('That does not look like an email address.');
  checkPassword(password);
  if (await store.loadUserByEmail(normalised)) {
    throw new AuthError('There is already an account with that address.', 409);
  }

  const first = (await store.countUsers()) === 0;
  const user: StoredUser = {
    id: `u_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    email: normalised,
    name: (name ?? '').trim() || normalised.split('@')[0]!,
    passwordHash: await hashPassword(password),
    createdAt: Date.now(),
    emailVerifiedAt: null,
    color: COLORS[(await store.countUsers()) % COLORS.length]!,
  };
  await store.saveUser(user);

  // The first account adopts whatever was already here. Before accounts every
  // document belonged to nobody; leaving them unowned would mean an instance
  // that is private for new work and wide open for everything that came before.
  const claimed = first ? await claimUnownedDocuments(user.id) : 0;
  return { user, claimed };
}

export async function authenticate(email: string, password: string): Promise<StoredUser> {
  const store = await persistence();
  const user = await store.loadUserByEmail(email.trim().toLowerCase());
  // Hash anyway when the address is unknown, so that a missing account and a
  // wrong password take the same time and cannot be told apart.
  const ok = await verifyPassword(password, user?.passwordHash ?? await unknownAccountHash());
  if (!user || !ok) throw new AuthError('That email and password do not match.', 401);
  return user;
}

let decoyHash: string | null = null;
async function unknownAccountHash(): Promise<string> {
  decoyHash ??= await hashPassword(randomBytes(16).toString('hex'));
  return decoyHash;
}

/**
 * Sets a password from outside a request — the operator's escape hatch, since
 * there is no mail service to send a reset link with.
 */
export async function setPassword(email: string, password: string): Promise<void> {
  const store = await persistence();
  const user = await store.loadUserByEmail(email.trim().toLowerCase());
  if (!user) throw new AuthError('No account with that address.', 404);
  checkPassword(password);
  user.passwordHash = await hashPassword(password);
  await store.saveUser(user);
  // Every existing session used the old password's authority.
  await store.deleteSessionsForUser(user.id);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export async function startSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  await (await persistence()).saveSession({
    token, userId, createdAt: now, expiresAt: now + SESSION_TTL_MS, lastSeenAt: now,
  });
  return token;
}

export async function endSession(token: string): Promise<void> {
  await (await persistence()).deleteSession(token);
}

/** The signed-in user for a session token, or null. Expired sessions are cleaned up. */
export async function sessionUser(token: string | undefined): Promise<StoredUser | null> {
  if (!token) return null;
  const store = await persistence();
  const session = await store.loadSession(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    await store.deleteSession(token);
    return null;
  }
  const user = await store.loadUser(session.userId);
  if (!user) return null;

  // Rolling expiry, written back at most hourly: someone using the app daily
  // should not be logged out on day 31, and a write per request would be one
  // database write per request.
  if (Date.now() - session.lastSeenAt > TOUCH_INTERVAL_MS) {
    session.lastSeenAt = Date.now();
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    await store.saveSession(session);
  }
  return user;
}

/** Parses one cookie out of a Cookie header, for the WebSocket handshake. */
export function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

const RANK: Record<MemberRole, number> = { viewer: 1, editor: 2, owner: 3 };

export function atLeast(role: MemberRole | null, needed: MemberRole): boolean {
  return !!role && RANK[role] >= RANK[needed];
}

export async function roleFor(docId: string, userId: string): Promise<MemberRole | null> {
  const m = await (await persistence()).loadMembership(docId, userId);
  return m?.role ?? null;
}

export async function grant(docId: string, userId: string, role: MemberRole): Promise<void> {
  await (await persistence()).saveMembership({ docId, userId, role, createdAt: Date.now() });
}

export async function revokeMembership(docId: string, userId: string): Promise<void> {
  await (await persistence()).deleteMembership(docId, userId);
}

export async function membersOf(docId: string): Promise<{ user: PublicUser; role: MemberRole }[]> {
  const store = await persistence();
  const memberships = await store.loadMemberships({ docId });
  const users = await store.listUsers(memberships.map((m) => m.userId));
  const byId = new Map(users.map((u) => [u.id, u]));
  return memberships
    .map((m) => ({ user: byId.get(m.userId), role: m.role }))
    .filter((e): e is { user: StoredUser; role: MemberRole } => !!e.user)
    .map((e) => ({ user: publicUser(e.user), role: e.role }))
    .sort((a, b) => RANK[b.role] - RANK[a.role] || a.user.name.localeCompare(b.user.name));
}

export async function documentsFor(userId: string): Promise<Map<string, MemberRole>> {
  const memberships = await (await persistence()).loadMemberships({ userId });
  return new Map(memberships.map((m: StoredMembership) => [m.docId, m.role]));
}

/**
 * Hands every document that nobody owns to one user.
 *
 * Runs once, for the first account. "Unowned" means no membership row at all,
 * so a document someone has already been given access to is never reassigned.
 */
export async function claimUnownedDocuments(userId: string): Promise<number> {
  const store = await persistence();
  const all = await listDocuments();
  const owned = new Set((await store.loadMemberships({})).map((m) => m.docId));
  let claimed = 0;
  for (const doc of all) {
    if (owned.has(doc.id)) continue;
    await grant(doc.id, userId, 'owner');
    claimed++;
  }
  return claimed;
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export interface InviteView {
  token: string;
  role: MemberRole;
  email: string | null;
  createdAt: number;
  expiresAt: number;
  accepted: boolean;
  revoked: boolean;
}

export async function createInvite(
  docId: string, invitedBy: string, role: MemberRole, email?: string | null,
): Promise<StoredInvite> {
  const invite: StoredInvite = {
    token: randomBytes(18).toString('base64url'),
    docId,
    role,
    email: email?.trim().toLowerCase() || null,
    invitedBy,
    createdAt: Date.now(),
    // Invitations that live forever are credentials nobody remembers issuing.
    expiresAt: Date.now() + INVITE_TTL_MS,
    acceptedBy: null,
    acceptedAt: null,
    revoked: false,
  };
  await (await persistence()).saveInvite(invite);
  return invite;
}

export async function invitesFor(docId: string): Promise<InviteView[]> {
  const invites = await (await persistence()).loadInvites(docId);
  return invites.map((i) => ({
    token: i.token, role: i.role, email: i.email, createdAt: i.createdAt, expiresAt: i.expiresAt,
    accepted: !!i.acceptedBy, revoked: i.revoked,
  }));
}

export async function revokeInvite(token: string): Promise<void> {
  const store = await persistence();
  const invite = await store.loadInvite(token);
  if (!invite) return;
  await store.saveInvite({ ...invite, revoked: true });
}

/** Reads an invitation without using it, for the "you have been invited" screen. */
export async function readInvite(token: string): Promise<StoredInvite | null> {
  const invite = await (await persistence()).loadInvite(token);
  if (!invite || invite.revoked) return null;
  return invite;
}

/**
 * Uses an invitation.
 *
 * Single use, and bound to the address when one was given: an invite passed on
 * to someone else should stop at the person it names. Accepting twice is not an
 * error — someone following their own link again should land in the document,
 * not on a failure.
 */
export async function acceptInvite(token: string, user: StoredUser): Promise<StoredInvite> {
  const store = await persistence();
  const invite = await store.loadInvite(token);
  if (!invite || invite.revoked) throw new AuthError('That invitation has been withdrawn.', 404);
  if (invite.expiresAt < Date.now()) throw new AuthError('That invitation has expired.', 410);
  if (invite.email && invite.email !== user.email.toLowerCase()) {
    throw new AuthError(`That invitation is for ${invite.email}.`, 403);
  }
  if (invite.acceptedBy && invite.acceptedBy !== user.id) {
    throw new AuthError('That invitation has already been used.', 409);
  }

  // Never demote: someone who is already an owner and follows a viewer link
  // stays an owner.
  const current = await roleFor(invite.docId, user.id);
  if (!atLeast(current, invite.role)) await grant(invite.docId, user.id, invite.role);
  await store.saveInvite({ ...invite, acceptedBy: user.id, acceptedAt: Date.now() });
  return invite;
}

/** Whether this instance has any accounts yet — the signal to offer sign-up. */
export async function hasAccounts(): Promise<boolean> {
  return (await (await persistence()).countUsers()) > 0;
}
