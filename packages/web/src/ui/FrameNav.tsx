/**
 * The bottom bar of the phone viewer.
 *
 * On a phone the editor is mostly opened to look: a link from a colleague, a
 * check on the bus, a screen held up across a table. The drawing tools are noise
 * there and easy to trigger with a thumb, so this replaces them with the thing a
 * reader needs: which frame this is, and the next one.
 */

import { useEffect, useMemo, useState } from 'react';
import { useCanvas, getDoc } from '../state/store.ts';
import { focusFrame, zoomToFit } from '../hooks/commands.ts';
import { Icon } from './Icon.tsx';

export function FrameNav() {
  const pageId = useCanvas((s) => s.pageId);
  const version = useCanvas((s) => s.version);
  const doc = getDoc();
  const page = doc?.pages.find((p) => p.id === pageId) ?? doc?.pages[0];
  const frames = useMemo(
    () => (page?.artboards ?? []).filter((id) => doc?.nodes[id]?.type === 'artboard'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [page, version],
  );
  const [index, setIndex] = useState(0);

  // A new page starts on its first frame, fitted to the screen.
  useEffect(() => {
    setIndex(0);
    if (frames[0]) requestAnimationFrame(() => focusFrame(frames[0]!));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page?.id, frames.length > 0]);

  if (!doc || !page) return null;
  const go = (next: number) => {
    const i = Math.max(0, Math.min(frames.length - 1, next));
    setIndex(i);
    if (frames[i]) focusFrame(frames[i]!);
  };
  const current = frames[index] ? doc.nodes[frames[index]!] : undefined;

  return (
    <nav className="frame-nav" aria-label="Frames">
      <button className="icon-button" onClick={() => go(index - 1)} disabled={index === 0} aria-label="Previous frame">
        <Icon name="chevronLeft" size={18} />
      </button>
      <button className="frame-nav-name" onClick={() => current && focusFrame(current.id)} title="Fit this frame">
        <strong>{current?.name ?? 'No frames'}</strong>
        <span className="dim tabular">{frames.length ? `${index + 1} / ${frames.length}` : page.name}</span>
      </button>
      <button
        className="icon-button" onClick={() => go(index + 1)}
        disabled={index >= frames.length - 1} aria-label="Next frame"
      ><Icon name="chevronRight" size={18} /></button>
      <span className="frame-nav-divider" />
      <button className="icon-button" onClick={() => zoomToFit()} aria-label="See the whole page" title="Whole page">
        <Icon name="fullscreen" size={16} />
      </button>
      <button
        className="icon-button is-accent" aria-label="Present"
        // From the frame on screen, not the top of the deck.
        onClick={() => useCanvas.getState().setPresent({ pageId: page.id, index })}
      >
        <Icon name="play" size={16} />
      </button>
    </nav>
  );
}
