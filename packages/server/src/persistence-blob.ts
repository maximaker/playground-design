/**
 * Vercel Blob persistence, for serverless deployments.
 *
 * Serverless functions have no filesystem and no shared memory, so every read
 * has to come from durable storage. Documents are small JSON, which suits Blob
 * well; the cost is that Blob is eventually consistent and has no transactions,
 * so two writers editing one document can clobber each other. That is stated in
 * the README rather than papered over.
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
      access: 'public',
      token: this.token,
      contentType: 'application/json',
      // Paths are our own ids; a random suffix would make them unfindable.
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 0,
    });
  }

  private async getJson<T>(path: string): Promise<T | null> {
    const { head } = await this.blob();
    try {
      const meta = await head(path, { token: this.token });
      const res = await fetch(`${meta.url}?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      // `head` throws for a blob that does not exist.
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
    const summaries = await Promise.all(
      blobs.map(async (b) => {
        try {
          const res = await fetch(`${b.url}?t=${Date.now()}`, { cache: 'no-store' });
          return res.ok ? ((await res.json()) as DocSummary) : null;
        } catch { return null; }
      }),
    );
    return summaries.filter((s): s is DocSummary => !!s).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async saveConnection(c: StoredConnection) { await this.putJson(`connections/${c.code}.json`, c); }
  async loadConnection(code: string) { return this.getJson<StoredConnection>(`connections/${code}.json`); }

  async loadConnections(docId?: string): Promise<StoredConnection[]> {
    const { list } = await this.blob();
    const { blobs } = await list({ prefix: 'connections/', token: this.token, limit: 500 });
    const all = await Promise.all(
      blobs.map(async (b) => {
        try {
          const res = await fetch(`${b.url}?t=${Date.now()}`, { cache: 'no-store' });
          return res.ok ? ((await res.json()) as StoredConnection) : null;
        } catch { return null; }
      }),
    );
    return all.filter((c): c is StoredConnection => !!c && (!docId || c.docId === docId));
  }

  async saveAsset(a: StoredAsset) {
    const { put } = await this.blob();
    await put(`assets/${a.id}`, a.bytes, {
      access: 'public', token: this.token, contentType: a.mime,
      addRandomSuffix: false, allowOverwrite: true,
    });
    await this.putJson(`assets/${a.id}.meta.json`, {
      id: a.id, docId: a.docId, mime: a.mime, name: a.name, createdAt: a.createdAt,
    });
  }

  async loadAsset(id: string): Promise<StoredAsset | null> {
    const meta = await this.getJson<Omit<StoredAsset, 'bytes'>>(`assets/${id}.meta.json`);
    if (!meta) return null;
    const { head } = await this.blob();
    try {
      const info = await head(`assets/${id}`, { token: this.token });
      const res = await fetch(info.url);
      if (!res.ok) return null;
      return { ...meta, bytes: Buffer.from(await res.arrayBuffer()) };
    } catch { return null; }
  }

  async saveSnapshot(s: StoredSnapshot) { await this.putJson(`snapshots/${s.docId}/${s.id}.json`, s); }

  async loadSnapshots(docId: string) {
    const { list } = await this.blob();
    const { blobs } = await list({ prefix: `snapshots/${docId}/`, token: this.token, limit: 100 });
    const all = await Promise.all(
      blobs.map(async (b) => {
        try {
          const res = await fetch(`${b.url}?t=${Date.now()}`, { cache: 'no-store' });
          if (!res.ok) return null;
          const { data, ...rest } = (await res.json()) as StoredSnapshot;
          void data;
          return rest;
        } catch { return null; }
      }),
    );
    return all.filter((s): s is Omit<StoredSnapshot, 'data'> => !!s).sort((a, b) => b.ts - a.ts);
  }

  async loadSnapshot(docId: string, id: string) {
    return this.getJson<StoredSnapshot>(`snapshots/${docId}/${id}.json`);
  }
}
