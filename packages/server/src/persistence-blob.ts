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
 */

import type { CanvasDocument } from '@playground/shared';
import type {
  DocSummary, Persistence, StoredAsset, StoredConnection, StoredSnapshot,
} from './persistence.ts';

type BlobModule = typeof import('@vercel/blob');

export class BlobPersistence implements Persistence {
  readonly kind = 'blob' as const;
  readonly durable = true;
  private blobPromise: Promise<BlobModule> | null = null;

  constructor(private token: string) {}

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
    await this.putJson(`docs/${doc.id}.json`, doc);
    await this.putJson(`index/${doc.id}.json`, {
      id: doc.id, name: doc.name, rev: doc.rev, updatedAt: Date.now(),
      nodeCount: Object.keys(doc.nodes).length,
    } satisfies DocSummary);
  }

  async deleteDocument(id: string) {
    const { del } = await this.blob();
    await Promise.allSettled([
      del(`docs/${id}.json`, { token: this.token }),
      del(`index/${id}.json`, { token: this.token }),
    ]);
  }

  async listDocuments(): Promise<DocSummary[]> {
    const { list } = await this.blob();
    const { blobs } = await list({ prefix: 'index/', token: this.token, limit: 200 });
    const summaries = await Promise.all(blobs.map((b) => this.getJson<DocSummary>(b.pathname)));
    return summaries.filter((s): s is DocSummary => !!s).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async saveConnection(c: StoredConnection) { await this.putJson(`connections/${c.code}.json`, c); }
  async loadConnection(code: string) { return this.getJson<StoredConnection>(`connections/${code}.json`); }

  async loadConnections(docId?: string): Promise<StoredConnection[]> {
    const { list } = await this.blob();
    const { blobs } = await list({ prefix: 'connections/', token: this.token, limit: 500 });
    const all = await Promise.all(blobs.map((b) => this.getJson<StoredConnection>(b.pathname)));
    return all.filter((c): c is StoredConnection => !!c && (!docId || c.docId === docId));
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
