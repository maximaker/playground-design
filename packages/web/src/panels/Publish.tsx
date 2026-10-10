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
import QRCode from 'qrcode';
import { Modal } from '../ui/Modal.tsx';
import { getDoc, useCanvas } from '../state/store.ts';
import { Icon } from '../ui/Icon.tsx';

export interface Publication {
  slug: string;
  artboardId: string | null;
  description: string | null;
  updatedAt: number;
  url: string;
}

export function Publish({ canPublish, onChange }: { canPublish: boolean; onChange?: (pub: Publication | null) => void }) {
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
    p.artboards.map((id) => ({ id, name: doc?.nodes[id]?.name ?? id, page: p.name, empty: !doc?.nodes[id]?.children.length })));

  const refresh = useCallback(async () => {
    if (!docId) return;
    const res = await fetch(`/api/documents/${docId}/publish`);
    if (!res.ok) return;
    const body = (await res.json()) as { publication: Publication | null };
    setPub(body.publication);
    onChange?.(body.publication);
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
    setArtboardId(selected ?? (artboards.find((a) => !a.empty) ?? artboards[0])?.id ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, version, pub]);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast('Link copied', 'success');
      return true;
    } catch {
      toast('Could not reach the clipboard — select the link and copy it.', 'error');
      return false;
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
      onChange?.(body.publication);
      setSlug(body.publication.slug);
      if (pub) toast('Page settings saved', 'success');
      // The dialog itself now shows the link, the code and Open — a toast that
      // also claims a copy is only true when the clipboard agreed.
      else toast('Your page is live', 'success');
    } finally {
      setBusy(false);
    }
  };

  const unpublish = async () => {
    if (!docId) return;
    await fetch(`/api/documents/${docId}/publish`, { method: 'DELETE' });
    setPub(null);
    onChange?.(null);
    toast('The page is offline — the link no longer works', 'info');
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

  const screenPicker = artboards.length > 1 && (
    <label className="field">
      <span className="field-label">Which page to put online</span>
      <select className="input" value={artboardId} onChange={(e) => setArtboardId(e.target.value)}>
        {artboards.map((a) => (
          <option key={a.id} value={a.id}>
            {doc && doc.pages.length > 1 ? `${a.page} / ${a.name}` : a.name}{a.empty ? ' (empty)' : ''}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <section className="publish">
      {pub ? (
        <div className="publish-live">
          <QrCode url={pub.url} />
          <div className="publish-live-text">
            <span className="live-chip"><span className="live-dot" /> Live</span>
            <strong>Your page is online</strong>
            <a className="publish-url" href={pub.url} target="_blank" rel="noreferrer">{pub.url.replace(/^https?:\/\//, '')}</a>
            <div className="publish-actions">
              <a className="button primary" href={pub.url} target="_blank" rel="noreferrer">
                <Icon name="link" size={13} /> Open page
              </a>
              <button className="button" onClick={() => copy(pub.url)}>Copy link</button>
            </div>
            <p className="dim publish-note">Changes you make show up on the page by themselves within a minute. Scan the code to open it on your phone.</p>
          </div>
        </div>
      ) : (
        <p className="publish-intro">
          Get a public link anyone can open — no account needed. After that, your edits show up on it by themselves.
        </p>
      )}

      {screenPicker}

      <details className="publish-more">
        <summary>Page address and description</summary>
        <div className="publish-fields">
          <label className="field">
            <span className="field-label">Address</span>
            <span className="publish-slug">
              <span className="dim">/p/</span>
              <input
                className="input"
                value={slug}
                placeholder="my-page"
                onChange={(e) => setSlug(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
              />
            </span>
          </label>
          <label className="field is-wide">
            <span className="field-label">Short description, shown when the link is shared</span>
            <input
              className="input"
              value={description}
              placeholder="What this page is about"
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
            />
          </label>
        </div>
      </details>

      <div className="publish-actions">
        <button className={`button${pub ? '' : ' primary'}`} onClick={publish} disabled={busy || !artboardId}>
          {busy ? 'One moment…' : pub ? 'Save settings' : 'Put it online'}
        </button>
        {pub && <button className="button subtle" onClick={unpublish}>Take it offline</button>}
      </div>
    </section>
  );
}

function QrCode({ url }: { url: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void QRCode.toDataURL(url, { margin: 1, width: 240 }).then((d) => { if (live) setSrc(d); }).catch(() => {});
    return () => { live = false; };
  }, [url]);
  return src ? <img className="publish-qr" src={src} alt={`QR code for ${url}`} width={120} height={120} /> : <span className="publish-qr" />;
}

/** Publishing as its own step — the top bar's "Publish" — rather than a section of Share. */
export function PublishDialog({ onClose, onChange }: { onClose: () => void; onChange?: (pub: Publication | null) => void }) {
  const docId = useCanvas((s) => s.docId);
  const [role, setRole] = useState<string | null>(null);
  useEffect(() => {
    if (!docId) return;
    void fetch(`/api/documents/${docId}/members`)
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { role?: string } | null) => setRole(b?.role ?? null))
      .catch(() => setRole(null));
  }, [docId]);
  return (
    <Modal title="Put your page online" onClose={onClose}>
      {role === null ? <p className="dim">Loading…</p> : <Publish canPublish={role === 'owner'} onChange={onChange} />}
    </Modal>
  );
}
