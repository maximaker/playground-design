/** In-memory persistence. Used as a fallback and by tests; nothing survives a restart. */

import type { CanvasDocument } from '@playground/shared';
import type {
  DocSummary, Persistence, StoredAsset, StoredConnection, StoredShare, StoredSnapshot,
} from './persistence.ts';

export class MemoryPersistence implements Persistence {
  readonly kind = 'memory' as const;
  readonly durable = false;

  private docs = new Map<string, { doc: CanvasDocument; updatedAt: number }>();
  private connections = new Map<string, StoredConnection>();
  private shares = new Map<string, StoredShare>();
  private assets = new Map<string, StoredAsset>();
  private snapshots = new Map<string, StoredSnapshot>();

  async loadDocument(id: string) { return this.docs.get(id)?.doc ?? null; }
  async saveDocument(doc: CanvasDocument) {
    this.docs.set(doc.id, { doc: structuredClone(doc), updatedAt: Date.now() });
  }
  async deleteDocument(id: string) { this.docs.delete(id); }
  async listDocuments(): Promise<DocSummary[]> {
    return [...this.docs.values()]
      .map(({ doc, updatedAt }) => ({
        id: doc.id, name: doc.name, rev: doc.rev, updatedAt,
        nodeCount: Object.keys(doc.nodes).length,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async saveConnection(conn: StoredConnection) { this.connections.set(conn.code, conn); }
  async loadConnections(docId?: string) {
    return [...this.connections.values()].filter((c) => !docId || c.docId === docId);
  }
  async loadConnection(code: string) { return this.connections.get(code) ?? null; }

  async saveShare(share: StoredShare) { this.shares.set(share.token, share); }
  async loadShares(docId: string) {
    return [...this.shares.values()].filter((s) => s.docId === docId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  async loadShare(token: string) { return this.shares.get(token) ?? null; }

  async saveAsset(asset: StoredAsset) { this.assets.set(asset.id, asset); }
  async loadAsset(id: string) { return this.assets.get(id) ?? null; }

  async saveSnapshot(s: StoredSnapshot) { this.snapshots.set(s.id, s); }
  async loadSnapshots(docId: string) {
    return [...this.snapshots.values()]
      .filter((s) => s.docId === docId)
      .map(({ data, ...rest }) => { void data; return rest; })
      .sort((a, b) => b.ts - a.ts);
  }
  async loadSnapshot(docId: string, id: string) {
    const s = this.snapshots.get(id);
    return s && s.docId === docId ? s : null;
  }
}
