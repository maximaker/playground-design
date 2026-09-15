/** In-memory persistence. Used as a fallback and by tests; nothing survives a restart. */

import type { CanvasDocument } from '@playground/shared';
import type {
  DocSummary, Persistence, StoredAsset, StoredConnection, StoredMembership, StoredProject,
  StoredSession, StoredShare, StoredSnapshot, StoredThumbnail, StoredUser,
} from './persistence.ts';

export class MemoryPersistence implements Persistence {
  readonly kind = 'memory' as const;
  readonly durable = false;

  private docs = new Map<string, { doc: CanvasDocument; updatedAt: number }>();
  private connections = new Map<string, StoredConnection>();
  private shares = new Map<string, StoredShare>();
  private projects = new Map<string, StoredProject>();
  private assets = new Map<string, StoredAsset>();
  private snapshots = new Map<string, StoredSnapshot>();
  private users = new Map<string, StoredUser>();
  private thumbnails = new Map<string, StoredThumbnail>();
  private sessions = new Map<string, StoredSession>();
  private memberships = new Map<string, StoredMembership>();

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
        projectId: doc.projectId,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async saveConnection(conn: StoredConnection) { this.connections.set(conn.code, conn); }
  async loadConnections(docId?: string) {
    return [...this.connections.values()].filter((c) => !docId || c.docId === docId);
  }
  async loadConnection(code: string) { return this.connections.get(code) ?? null; }

  async saveThumbnail(t: StoredThumbnail) { this.thumbnails.set(t.docId, t); }
  async loadThumbnail(docId: string) { return this.thumbnails.get(docId) ?? null; }

  async saveUser(u: StoredUser) { this.users.set(u.id, u); }
  async loadUser(id: string) { return this.users.get(id) ?? null; }
  async loadUserByEmail(email: string) {
    const wanted = email.toLowerCase();
    return [...this.users.values()].find((u) => u.email.toLowerCase() === wanted) ?? null;
  }
  async countUsers() { return this.users.size; }
  async listUsers(ids?: string[]) {
    const all = [...this.users.values()].sort((a, b) => a.createdAt - b.createdAt);
    return ids ? all.filter((u) => ids.includes(u.id)) : all;
  }

  async saveSession(s: StoredSession) { this.sessions.set(s.token, s); }
  async loadSession(token: string) { return this.sessions.get(token) ?? null; }
  async deleteSession(token: string) { this.sessions.delete(token); }
  async deleteSessionsForUser(userId: string) {
    for (const [token, s] of this.sessions) if (s.userId === userId) this.sessions.delete(token);
  }

  async saveMembership(m: StoredMembership) { this.memberships.set(`${m.docId}:${m.userId}`, m); }
  async loadMembership(docId: string, userId: string) {
    return this.memberships.get(`${docId}:${userId}`) ?? null;
  }
  async loadMemberships(opts: { docId?: string; userId?: string }) {
    return [...this.memberships.values()].filter((m) =>
      (!opts.docId || m.docId === opts.docId) && (!opts.userId || m.userId === opts.userId));
  }
  async deleteMembership(docId: string, userId: string) {
    this.memberships.delete(`${docId}:${userId}`);
  }

  async saveProject(project: StoredProject) { this.projects.set(project.id, project); }
  async loadProjects() {
    return [...this.projects.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  async deleteProject(id: string) { return this.projects.delete(id); }

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
