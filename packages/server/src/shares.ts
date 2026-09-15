/**
 * Share links.
 *
 * A document URL is an edit credential: anyone holding `/d/<id>` can change the
 * document. That makes showing work to someone an all-or-nothing act, which is
 * the wrong shape — most of the time you want them to look, not to edit.
 *
 * A share link is a separate token that grants viewing only. The important
 * consequence is that the viewer must never learn the document id, or the
 * restriction is theatre: they would simply open `/d/<id>` instead. So every
 * endpoint a viewer touches is addressed by token, the server resolves the id
 * on its side, and the document is redacted on the way out.
 *
 * Read-only is enforced on the server, not in the UI. Hiding the toolbar stops
 * an honest viewer from making a mess; refusing the ops is what stops the rest.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { persistence, type ShareRole, type StoredShare } from './persistence.ts';
import { ensureLoaded, getDocument } from './store.ts';
import type { CanvasDocument, OpEnvelope } from '@playground/shared';

/** How stale `lastUsedAt` may get before it is worth another write. */
const LAST_USED_THROTTLE_MS = 60_000;

export interface Share {
  token: string;
  docId: string;
  role: ShareRole;
  label: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

/**
 * Tokens live in a URL, so they are dense base64url rather than the connection
 * codes' human-readable alphabet — nobody reads a share link aloud.
 */
function randomToken(): string {
  return randomBytes(18).toString('base64url');
}

export async function createShare(docId: string, label?: string, role: ShareRole = 'view'): Promise<Share> {
  await ensureLoaded(docId);
  if (!getDocument(docId)) throw new Error(`document ${docId} not found`);

  const share: StoredShare = {
    token: randomToken(),
    docId,
    role,
    label: label?.trim() || null,
    createdAt: Date.now(),
    lastUsedAt: null,
    revoked: false,
  };
  const store = await persistence();
  await store.saveShare(share);
  return toShare(share);
}

export async function listShares(docId: string): Promise<Share[]> {
  const store = await persistence();
  return (await store.loadShares(docId)).filter((s) => !s.revoked).map(toShare);
}

/**
 * Resolves a token to the document it opens, or null.
 *
 * The comparison is constant-time for the same reason the connection codes'
 * is: a timing oracle over a shared secret is a way in, and "there are no
 * accounts yet" is not a reason to leave one lying around.
 */
export async function resolveShare(token: string): Promise<Share | null> {
  if (!token || token.length > 64) return null;
  const store = await persistence();
  const found = await store.loadShare(token);
  if (!found || found.revoked) return null;

  const a = Buffer.from(found.token);
  const b = Buffer.from(token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  await ensureLoaded(found.docId);
  if (!getDocument(found.docId)) return null;

  // Last-used is best-effort: it is for the owner's benefit in the share list,
  // and a failed write here must not stop someone opening the link.
  //
  // Throttled, because a viewer on the polling transport resolves the token
  // several times a minute and this is a storage write each time — precise
  // timestamps are not worth that, and "opened 3m ago" is the same sentence
  // either way.
  if (!found.lastUsedAt || Date.now() - found.lastUsedAt > LAST_USED_THROTTLE_MS) {
    void store.saveShare({ ...found, lastUsedAt: Date.now() }).catch(() => {});
  }
  return toShare(found);
}

export async function revokeShare(token: string): Promise<boolean> {
  const store = await persistence();
  const found = await store.loadShare(token);
  if (!found) return false;
  await store.saveShare({ ...found, revoked: true });
  return true;
}

/**
 * Whether a batch of ops is nothing but someone leaving a remark.
 *
 * Commenting is the reason to send a review link in the first place, so a
 * view-only session is allowed to do it — but only that, and only the additive
 * parts. Deleting or rewriting a thread is not something a link-holder should
 * be able to do to someone else's words.
 *
 * Both transports run this: sockets where they work, and an HTTP endpoint
 * everywhere else, because the deployed product is serverless and cannot hold
 * a socket open at all.
 */
export function viewerMayApply(envelopes: OpEnvelope[]): boolean {
  if (!Array.isArray(envelopes) || envelopes.length === 0) return false;
  return envelopes.every(({ op }) =>
    op?.t === 'comment' && (op.action === 'add' || op.action === 'reply'
      // Resolving is allowed: it is a status, not a rewrite.
      || (op.action === 'update' && Object.keys(op.comment).every((k) => k === 'id' || k === 'resolved'))));
}

/**
 * The document as a viewer may see it.
 *
 * The real id is replaced by the token, because the id *is* the edit
 * credential. Everything else is exactly the document — a viewer is looking at
 * the real thing, live, not at a flattened copy.
 */
export function redactForViewer(doc: CanvasDocument, token: string): CanvasDocument {
  return { ...doc, id: `share_${token}` };
}

function toShare(s: StoredShare): Share {
  return {
    token: s.token, docId: s.docId, role: s.role, label: s.label,
    createdAt: s.createdAt, lastUsedAt: s.lastUsedAt,
  };
}
