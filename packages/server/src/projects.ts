/**
 * Projects: a folder for documents.
 *
 * Nothing clever — a name and a membership field on each document. It exists
 * because a flat list stops being a library somewhere around thirty files, and
 * the tool is designed to make files quickly.
 *
 * Two deliberate restraints:
 *
 * - Membership is library metadata, not design content. It is set through the
 *   REST API rather than through an op, so filing a document is not something
 *   the canvas can undo, does not enter version history, and is not replayed to
 *   everyone editing it.
 * - Deleting a project never deletes documents. Losing work to a tidy-up is the
 *   kind of surprise that makes people stop trusting a tool; the documents come
 *   back as unfiled.
 */

import { newId } from '@playground/shared';
import { persistence, type StoredProject } from './persistence.ts';
import { ensureLoaded, getDocument, listDocuments, touchDocument } from './store.ts';

export interface Project extends StoredProject {
  /** How many documents are filed here, for the library UI. */
  documentCount: number;
}

export class ProjectError extends Error {}

const MAX_NAME = 80;

export async function listProjects(): Promise<Project[]> {
  const store = await persistence();
  // The store's listing, not the raw persistence one: filing is written to the
  // cached document and flushed later, so storage lags behind by up to a flush
  // interval and a freshly filed document would not be counted.
  const [projects, docs] = await Promise.all([store.loadProjects(), listDocuments()]);
  const counts = new Map<string, number>();
  for (const d of docs) {
    if (d.projectId) counts.set(d.projectId, (counts.get(d.projectId) ?? 0) + 1);
  }
  return projects.map((p) => ({ ...p, documentCount: counts.get(p.id) ?? 0 }));
}

export async function createProject(name: string): Promise<Project> {
  const clean = cleanName(name);
  const project: StoredProject = { id: newId('proj'), name: clean, createdAt: Date.now() };
  const store = await persistence();
  await store.saveProject(project);
  return { ...project, documentCount: 0 };
}

export async function renameProject(id: string, name: string): Promise<Project | null> {
  const store = await persistence();
  const existing = (await store.loadProjects()).find((p) => p.id === id);
  if (!existing) return null;
  const updated = { ...existing, name: cleanName(name) };
  await store.saveProject(updated);
  return { ...updated, documentCount: (await listProjects()).find((p) => p.id === id)?.documentCount ?? 0 };
}

/** Deletes the project and unfiles its documents; never deletes a document. */
export async function deleteProject(id: string): Promise<{ deleted: boolean; unfiled: number }> {
  const store = await persistence();
  const docs = (await listDocuments()).filter((d) => d.projectId === id);
  for (const summary of docs) await fileDocument(summary.id, null);
  const deleted = await store.deleteProject(id);
  return { deleted, unfiled: docs.length };
}

/**
 * Moves a document into a project, or out of all of them with `null`.
 *
 * The write goes through the document, since that is where membership lives —
 * which also means it survives every backend without a join table.
 */
export async function fileDocument(docId: string, projectId: string | null): Promise<void> {
  await ensureLoaded(docId);
  const doc = getDocument(docId);
  if (!doc) throw new ProjectError(`document ${docId} not found`);

  if (projectId !== null) {
    const store = await persistence();
    const exists = (await store.loadProjects()).some((p) => p.id === projectId);
    if (!exists) throw new ProjectError(`project ${projectId} not found`);
  }

  if (projectId === null) delete doc.projectId;
  else doc.projectId = projectId;

  await touchDocument(docId);
}

function cleanName(name: string): string {
  const clean = name.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME);
  if (!clean) throw new ProjectError('a project needs a name');
  return clean;
}
