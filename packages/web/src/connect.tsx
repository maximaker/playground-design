/**
 * heymax connect in the browser (kit/docs/connect.md): the kit's custom
 * elements, shown only once /api/connect/status answers 200. Off (404), signed
 * out (401) or a share-link viewer: nothing renders and the app is unchanged.
 */

import { useEffect, useRef, useState } from 'react';
import { defineConnectElements, searchEverywhere } from './kit-connect/ui.js';
import type { ConnectItem } from './kit-connect/connect.js';
import './kit-connect/connect.css';

export type { ConnectItem };
export { searchEverywhere };

type HmAttrs = React.HTMLAttributes<HTMLElement> & { ref?: React.Ref<HTMLElement> } & Record<string, unknown>;
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'hm-linked-work': HmAttrs;
      'hm-unfurl': HmAttrs;
      'hm-connect-search': HmAttrs;
    }
  }
}

let status: Promise<boolean> | null = null;

/** Asked once per page load; the elements are defined the first time it says yes. */
export function connectStatus(): Promise<boolean> {
  status ??= fetch('/api/connect/status', { credentials: 'include' })
    .then((r) => {
      if (r.ok) defineConnectElements();
      return r.ok;
    })
    .catch(() => false);
  return status;
}

export function useConnectEnabled(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    void connectStatus().then((v) => { if (live) setOn(v); });
    return () => { live = false; };
  }, []);
  return on;
}

/** The Linked work panel for one of Playground's items. */
export function LinkedWork({ type, id, title, url }: { type: 'doc' | 'project'; id: string; title: string; url: string }) {
  const on = useConnectEnabled();
  if (!on) return null;
  return (
    <div className="connect-linked">
      <hm-linked-work uri={`heymax://playground/${type}/${id}`} item-title={title} item-url={url} />
    </div>
  );
}

/** heymax page URLs and URIs found in a piece of text. */
const HEYMAX_REF = /(heymax:\/\/[a-z]+\/[a-z-]+\/[A-Za-z0-9_.:-]+|https:\/\/(?:studio-os|artifactory|playground|notes)\.heymax\.im\/[^\s<>"')]*)/g;
export function heymaxRefs(text: string): string[] {
  return [...new Set(text.match(HEYMAX_REF) ?? [])].slice(0, 3);
}

/** Unfurl cards for the heymax links in `text`, or nothing. */
export function Unfurls({ text }: { text: string }) {
  const on = useConnectEnabled();
  const refs = on ? heymaxRefs(text) : [];
  if (!refs.length) return null;
  return (
    <div className="connect-unfurls">
      {refs.map((r) => <hm-unfurl key={r} href={r} />)}
    </div>
  );
}

/**
 * The family ⌘K, for screens without a palette of their own.
 *
 * The kit's `hotkey` attribute binds a document listener that outlives the
 * element, and the library unmounts when a document opens (whose editor has
 * its own ⌘K). So the key is bound here instead, for as long as this is mounted.
 */
export function ConnectSearch() {
  const on = useConnectEnabled();
  const ref = useRef<HTMLElement & { open?: (q?: string) => void }>(null);
  useEffect(() => {
    if (!on) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'k' && ref.current?.open) {
        e.preventDefault();
        ref.current.open();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [on]);
  if (!on) return null;
  return <hm-connect-search ref={ref} self="playground" />;
}
