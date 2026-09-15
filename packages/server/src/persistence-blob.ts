/**
 * Vercel Blob persistence, for serverless deployments.
 *
 * Serverless functions have no filesystem and no shared memory, so every read
 * has to come from durable storage. Documents are small JSON, which suits Blob
 * well; the cost is that Blob is eventually consistent and has no transactions,
 * so two writers editing one document can clobber each other. That is stated in
 * the README rather than papered over.
 *
 * Everything is stored with private access and read back through the SDK's
 * authenticated `get`, so a document is reachable only through the app — not by
 * anyone who guesses a blob URL.
 *
 * Blob meters operations, and a `list` plus a `get` per entry is the expensive
 * shape. Listing the library was doing exactly that on every request — and
 * `/api/projects` did it twice, once for the projects and once to count the
 * documents in them — which is enough to burn a month's allowance in an
 * afternoon of testing. The collection listings are therefore cached for a few
 * seconds. Single-document reads are never cached: a document is read straight
 * after it is written and a stale copy there would be a lost edit.
 */

import { createHash } from 'node:crypto';
import type { CanvasDocument } from '@playground/shared';
import type {
  DocSummary, Persistence, StoredAsset, StoredConnection, StoredMembership, StoredProject,
  StoredSession, StoredShare, StoredSnapshot, StoredThumbnail, StoredUser,
} from './persistence.ts';

type BlobModule = typeof import('@vercel/blob');

export class BlobPersistence implements Persistence {
  readonly kind = 'blob' as const;
  readonly durable = true;
  private blobPromise: Promise<BlobModule> | null = null;

  /**
   * Short-lived cache for collection listings.
   *
   * Deliberately brief: long enough to collapse the several listings a single
   * page load makes, short enough that a document created in one tab shows up
   * in another without anyone waiting. Invalidated outright on any write to the
   * collection, so it never hides your own change from you.
   */
  private listCache = new Map<string, { at: number; value: unknown }>();

  private static readonly LIST_TTL_MS = 4000;

  private async cachedList<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.listCache.get(key);
    if (hit && Date.now() - hit.at < BlobPersistence.LIST_TTL_MS) return hit.value as T;
    const value = await load();
    this.listCache.set(key, { at: Date.now(), value });
    return value;
  }

  private invalidate(key: string): void {
    this.listCache.delete(key);
  }

  private token: string;

  // Assigned in the body rather than declared as a parameter property: Node
  // runs this project's TypeScript by stripping types, and a parameter property
  // is not erasable syntax — it throws ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX. It
  // never surfaced because Vercel bundles this file with esbuild and no other
  // environment had a Blob token to load it with, but a self-hosted instance
  // pointed at Blob storage would have crashed on its first read.
  constructor(token: string) {
    this.token = token;
  }

  private async blob(): Promise<BlobModule> {
    if (!this.blobPromise) this.blobPromise = import('@vercel/blob');
    return this.blobPromise;
  }

  private async putJson(path: string, value: unknown): Promise<void> {
    const { put } = await this.blob();
    await put(path, JSON.stringify(value), {
      access: 'private',
      token: this.token,
      contentType: 'application/json',
      // Paths are our own ids; a random suffix would make them unfindable.
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 0,
    });
  }

  private async getJson<T>(path: string): Promise<T | null> {
    const { get } = await this.blob();
    try {
      // `useCache: false` because a document is read straight after it is
      // written, and a cached copy would hand back the previous revision.
      const result = await get(path, { access: 'private', token: this.token, useCache: false });
      if (!result) return null;
      return (await new Response(result.stream).json()) as T;
    } catch {
      // `get` throws rather than returning null for a blob that does not exist.
      return null;
    }
  }

  async loadDocument(id: string) { return this.getJson<CanvasDocument>(`docs/${id}.json`); }

  async saveDocument(doc: CanvasDocument) {
    this.invalidate('documents');
    await this.putJson(`docs/${doc.id}.json`, doc);
    await this.putJson(`index/${doc.id}.json`, {
      id: doc.id, name: doc.name, rev: doc.rev, updatedAt: Date.now(),
      nodeCount: Object.keys(doc.nodes).length,
      projectId: doc.projectId,
    } satisfies DocSummary);
  }

  async deleteDocument(id: string) {
    this.invalidate('documents');
    const { del, list } = await this.blob();
    await Promise.allSettled([
      del(`docs/${id}.json`, { token: this.token }),
      del(`index/${id}.json`, { token: this.token }),
    ]);

    // Assets belong to the document, and nothing else will ever reach them
    // again — SQLite deletes them by foreign key, and without this Blob simply
    // accumulated them. A bundled code component is well over a hundred
    // kilobytes, so a few abandoned documents is most of a small store.
    try {
      const { blobs } = await list({ prefix: 'assets/', token: this.token, limit: 1000 });
      const metas = blobs.filter((b) => b.pathname.endsWith('.meta.json'));
      const mine: string[] = [];
      for (const meta of metas) {
        const value = await this.getJson<{ id: string; docId: string | null }>(meta.pathname);
        if (value?.docId === id) mine.push(value.id);
      }
      await Promise.allSettled(mine.flatMap((assetId) => [
        del(`assets/${assetId}`, { token: this.token }),
        del(`assets/${assetId}.meta.json`, { token: this.token }),
      ]));
    } catch {
      // Best effort. Failing to tidy up must not fail the deletion itself.
    }
  }

  async listDocuments(): Promise<DocSummary[]> {
    return this.cachedList('documents', async () => {
      const { list } = await this.blob();
      const { blobs } = await list({ prefix: 'index/', token: this.token, limit: 200 });
      const summaries = await Promise.all(blobs.map((b) => this.getJson<DocSummary>(b.pathname)));
      return summaries.filter((s): s is DocSummary => !!s).sort((a, b) => b.updatedAt - a.updatedAt);
    });
  }

  async saveConnection(c: StoredConnection) { await this.putJson(`connections/${c.code}.json`, c); }
  async loadConnection(code: string) { return this.getJson<StoredConnection>(`connections/${code}.json`); }

  async loadConnections(docId?: string): Promise<StoredConnection[]> {
    const { list } = await this.blob();
    const { blobs } = await list({ prefix: 'connections/', token: this.token, limit: 500 });
    const all = await Promise.all(blobs.map((b) => this.getJson<StoredConnection>(b.pathname)));
    return all.filter((c): c is StoredConnection => !!c && (!docId || c.docId === docId));
  }

  async saveThumbnail(t: StoredThumbnail): Promise<void> {
    const { put } = await this.blob();
    const path = `thumbnails/${t.docId}/${encodeURIComponent(t.key)}`;
    await put(path, t.bytes, {
      access: 'private', token: this.token, contentType: t.mime,
      addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 0,
    });
    // The stamp lives beside the bytes: Blob has no metadata to hang it on.
    await this.putJson(`${path}.json`, { stamp: t.stamp, mime: t.mime, createdAt: t.createdAt });
  }

  async loadThumbnail(docId: string, key: string): Promise<StoredThumbnail | null> {
    const path = `thumbnails/${docId}/${encodeURIComponent(key)}`;
    const meta = await this.getJson<{ stamp: string; mime: string; createdAt: number }>(`${path}.json`);
    if (!meta) return null;
    const { get } = await this.blob();
    try {
      const result = await get(path, { access: 'private', token: this.token, useCache: false });
      if (!result) return null;
      const bytes = Buffer.from(await new Response(result.stream).arrayBuffer());
      return { docId, key, stamp: meta.stamp, mime: meta.mime, bytes, createdAt: meta.createdAt };
    } catch {
      return null;
    }
  }

  // --- Accounts -------------------------------------------------------------
  //
  // Users are indexed by id and, separately, by a hash of the address, because
  // Blob has no queries: finding an account by email any other way means
  // listing every user and reading each one.

  async saveUser(u: StoredUser): Promise<void> {
    this.invalidate('users');
    await this.putJson(`users/${u.id}.json`, u);
    await this.putJson(`users-by-email/${emailKey(u.email)}.json`, { id: u.id });
  }

  async loadUser(id: string) { return this.getJson<StoredUser>(`users/${id}.json`); }

  async loadUserByEmail(email: string): Promise<StoredUser | null> {
    const ref = await this.getJson<{ id: string }>(`users-by-email/${emailKey(email)}.json`);
    return ref ? this.loadUser(ref.id) : null;
  }

  async countUsers(): Promise<number> {
    return (await this.listUsers()).length;
  }

  async listUsers(ids?: string[]): Promise<StoredUser[]> {
    if (ids) {
      const loaded = await Promise.all(ids.map((id) => this.loadUser(id)));
      return loaded.filter((u): u is StoredUser => !!u);
    }
    return this.cachedList('users', async () => {
      const { list } = await this.blob();
      const { blobs } = await list({ prefix: 'users/', token: this.token, limit: 500 });
      const loaded = await Promise.all(blobs.map((b) => this.getJson<StoredUser>(b.pathname)));
      return loaded.filter((u): u is StoredUser => !!u).sort((a, b) => a.createdAt - b.createdAt);
    });
  }

  async saveSession(s: StoredSession): Promise<void> {
    await this.putJson(`sessions/${s.token}.json`, s);
  }

  async loadSession(token: string) { return this.getJson<StoredSession>(`sessions/${token}.json`); }

  async deleteSession(token: string): Promise<void> {
    const { del } = await this.blob();
    try { await del(`sessions/${token}.json`, { token: this.token }); } catch { /* already gone */ }
  }

  async deleteSessionsForUser(userId: string): Promise<void> {
    const { list, del } = await this.blob();
    const { blobs } = await list({ prefix: 'sessions/', token: this.token, limit: 1000 });
    const loaded = await Promise.all(blobs.map(async (b) =>
      ({ path: b.pathname, session: await this.getJson<StoredSession>(b.pathname) })));
    for (const { path, session } of loaded) {
      if (session?.userId !== userId) continue;
      try { await del(path, { token: this.token }); } catch { /* already gone */ }
    }
  }

  async saveMembership(m: StoredMembership): Promise<void> {
    this.invalidate('memberships');
    await this.putJson(`memberships/${m.docId}__${m.userId}.json`, m);
  }

  async loadMembership(docId: string, userId: string) {
    return this.getJson<StoredMembership>(`memberships/${docId}__${userId}.json`);
  }

  async loadMemberships(opts: { docId?: string; userId?: string }): Promise<StoredMembership[]> {
    const all = await this.cachedList('memberships', async () => {
      const { list } = await this.blob();
      const { blobs } = await list({ prefix: 'memberships/', token: this.token, limit: 1000 });
      const loaded = await Promise.all(blobs.map((b) => this.getJson<StoredMembership>(b.pathname)));
      return loaded.filter((m): m is StoredMembership => !!m);
    });
    return all.filter((m) =>
      (!opts.docId || m.docId === opts.docId) && (!opts.userId || m.userId === opts.userId));
  }

  async deleteMembership(docId: string, userId: string): Promise<void> {
    const { del } = await this.blob();
    this.invalidate('memberships');
    try { await del(`memberships/${docId}__${userId}.json`, { token: this.token }); }
    catch { /* already gone */ }
  }

  async saveProject(p: StoredProject) {
    this.invalidate('projects');
    await this.putJson(`projects/${p.id}.json`, p);
  }

  async loadProjects(): Promise<StoredProject[]> {
    return this.cachedList('projects', async () => {
      const { list } = await this.blob();
      const { blobs } = await list({ prefix: 'projects/', token: this.token, limit: 200 });
      const all = await Promise.all(blobs.map((b) => this.getJson<StoredProject>(b.pathname)));
      return all.filter((p): p is StoredProject => !!p).sort((a, b) => a.name.localeCompare(b.name));
    });
  }

  async deleteProject(id: string): Promise<boolean> {
    const { del } = await this.blob();
    if (!(await this.getJson<StoredProject>(`projects/${id}.json`))) return false;
    this.invalidate('projects');
    await del(`projects/${id}.json`, { token: this.token });
    return true;
  }

  async saveShare(s: StoredShare) {
    this.invalidate('shares');
    await this.putJson(`shares/${s.token}.json`, s);
  }
  async loadShare(token: string) { return this.getJson<StoredShare>(`shares/${token}.json`); }

  async loadShares(docId: string): Promise<StoredShare[]> {
    const all = await this.cachedList('shares', async () => {
      const { list } = await this.blob();
      const { blobs } = await list({ prefix: 'shares/', token: this.token, limit: 500 });
      const loaded = await Promise.all(blobs.map((b) => this.getJson<StoredShare>(b.pathname)));
      return loaded.filter((s): s is StoredShare => !!s);
    });
    return all.filter((s) => s.docId === docId).sort((a, b) => b.createdAt - a.createdAt);
  }

  async saveAsset(a: StoredAsset) {
    const { put } = await this.blob();
    await put(`assets/${a.id}`, a.bytes, {
      access: 'private', token: this.token, contentType: a.mime,
      addRandomSuffix: false, allowOverwrite: true,
    });
    await this.putJson(`assets/${a.id}.meta.json`, {
      id: a.id, docId: a.docId, mime: a.mime, name: a.name, createdAt: a.createdAt,
    });
  }

  async loadAsset(id: string): Promise<StoredAsset | null> {
    const meta = await this.getJson<Omit<StoredAsset, 'bytes'>>(`assets/${id}.meta.json`);
    if (!meta) return null;
    const { get } = await this.blob();
    try {
      const result = await get(`assets/${id}`, { access: 'private', token: this.token });
      if (!result) return null;
      return { ...meta, bytes: Buffer.from(await new Response(result.stream).arrayBuffer()) };
    } catch { return null; }
  }

  async saveSnapshot(s: StoredSnapshot) { await this.putJson(`snapshots/${s.docId}/${s.id}.json`, s); }

  async loadSnapshots(docId: string) {
    const { list } = await this.blob();
    const { blobs } = await list({ prefix: `snapshots/${docId}/`, token: this.token, limit: 100 });
    const all = await Promise.all(blobs.map((b) => this.getJson<StoredSnapshot>(b.pathname)));
    return all
      .filter((s): s is StoredSnapshot => !!s)
      .map(({ data, ...rest }) => { void data; return rest; })
      .sort((a, b) => b.ts - a.ts);
  }

  async loadSnapshot(docId: string, id: string) {
    return this.getJson<StoredSnapshot>(`snapshots/${docId}/${id}.json`);
  }
}

/**
 * A blob-safe key for an email address.
 *
 * Addresses contain characters that are awkward in a path and are
 * case-insensitive in practice, so the key is a hash of the lower-cased
 * address rather than the address itself. It also keeps the address out of
 * a listing that only needs to answer "does this account exist".
 */
function emailKey(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 32);
}
