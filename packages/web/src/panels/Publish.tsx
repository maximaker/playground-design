/**
 * Publishing a document to a plain URL.
 *
 * The third answer to "who can see this", after people and share links, and the
 * only one that reaches someone with no account and no link from you: a page on
 * the web. Because the document is already HTML and CSS, publishing is not an
 * export — the page is rendered from the document on request, so the link keeps
 * up with the work.
 *
 * Which artboard becomes the page is a choice, not a guess. It defaults to
 * whatever is selected, because "publish this one" is what someone means when
 * they have a screen in front of them.
 */

import { useCallback, useEffect, useState } from 'react';
import { artboardOf } from '@playground/shared';
import { getDoc, useCanvas } from '../state/store.ts';
import { Icon } from '../ui/Icon.tsx';

interface Publication {
  slug: string;
  artboardId: string | null;
  description: string | null;
  updatedAt: number;
  url: string;
}

export function Publish({ canPublish }: { canPublish: boolean }) {
  const docId = useCanvas((s) => s.docId);
  const selection = useCanvas((s) => s.selection);
  const version = useCanvas((s) => s.version);
  const toast = useCanvas((s) => s.toast);
  const doc = getDoc();

  const [pub, setPub] = useState<Publication | null>(null);
  const [artboardId, setArtboardId] = useState<string>('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);

  const artboards = (doc?.pages ?? []).flatMap((p) =>
    p.artboards.map((id) => ({ id, name: doc?.nodes[id]?.name ?? id, page: p.name })));

  const refresh = useCallback(async () => {
    if (!docId) return;
    const res = await fetch(`/api/documents/${docId}/publish`);
    if (!res.ok) return;
    const body = (await res.json()) as { publication: Publication | null };
    setPub(body.publication);
    if (body.publication) {
      setSlug(body.publication.slug);
      setDescription(body.publication.description ?? '');
      if (body.publication.artboardId) setArtboardId(body.publication.artboardId);
    }
  }, [docId]);

  useEffect(() => { void refresh(); }, [refresh]);

  // What is selected is the likeliest thing to want published, so it is the
  // default — but never overrides a choice already published.
  useEffect(() => {
    if (pub?.artboardId || artboardId) return;
    const selected = selection[0] && doc ? artboardOf(doc, selection[0].split('::')[0]!) : null;
    setArtboardId(selected ?? artboards[0]?.id ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, version, pub]);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast('Link copied', 'info');
    } catch {
      toast('Could not reach the clipboard — select the link and copy it.', 'error');
    }
  };

  const publish = async () => {
    if (!docId) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/documents/${docId}/publish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          artboardId: artboardId || undefined,
          slug: slug.trim() || undefined,
          description: description.trim() || undefined,
        }),
      });
      const body = (await res.json()) as { publication?: Publication; error?: string };
      if (!res.ok || !body.publication) { toast(body.error ?? 'Could not publish', 'error'); return; }
      setPub(body.publication);
      setSlug(body.publication.slug);
      if (!pub) await copy(body.publication.url);
      toast(pub ? 'Published page updated' : 'Published', 'info');
    } finally {
      setBusy(false);
    }
  };

  const unpublish = async () => {
    if (!docId) return;
    await fetch(`/api/documents/${docId}/publish`, { method: 'DELETE' });
    setPub(null);
    toast('The link no longer works', 'info');
  };

  if (!canPublish) {
    return (
      <p className="panel-hint" style={{ padding: 0 }}>
        {pub
          ? <>This document is published at <a href={pub.url} target="_blank" rel="noreferrer">{pub.url}</a>.</>
          : 'Only an owner can publish this document to the web.'}
      </p>
    );
  }

  return (
    <section className="publish">
      <div className="publish-fields">
        <label className="field">
          <span className="field-label">Which screen</span>
          <select className="input" value={artboardId} onChange={(e) => setArtboardId(e.target.value)}>
            {artboards.map((a) => (
              <option key={a.id} value={a.id}>
                {doc && doc.pages.length > 1 ? `${a.page} / ${a.name}` : a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Address</span>
          <span className="publish-slug">
            <span className="dim">/p/</span>
            <input
              className="input"
              value={slug}
              placeholder="northsignal"
              onChange={(e) => setSlug(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
            />
          </span>
        </label>
      </div>

      <label className="field is-wide">
        <span className="field-label">Description, for link previews and search</span>
        <input
          className="input"
          value={description}
          placeholder="What this page is"
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </label>

      <div className="publish-actions">
        <button className="button primary" onClick={publish} disabled={busy || !artboardId}>
          {busy ? 'One moment…' : pub ? 'Update the page' : 'Publish'}
        </button>
        {pub && (
          <>
            <a className="button" href={pub.url} target="_blank" rel="noreferrer">
              <Icon name="link" size={13} /> Open
            </a>
            <button className="button subtle" onClick={() => copy(pub.url)}>Copy link</button>
            <button className="button subtle" onClick={unpublish}>Unpublish</button>
          </>
        )}
      </div>

      {pub && (
        <div className="code-display">
          <code>{pub.url}</code>
        </div>
      )}

      <p className="panel-hint" style={{ padding: 0 }}>
        {pub
          ? 'Anyone with this address can read the page — no account needed. It re-renders from the document, so edits appear within a minute.'
          : 'A public page with no editor and no sign-in. It stays in step with the document, so there is nothing to re-publish after an edit.'}
      </p>
    </section>
  );
}
