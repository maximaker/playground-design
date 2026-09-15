/**
 * Presentation mode.
 *
 * A design tool has to be able to show the work to people who are not editing
 * it: a stakeholder in a meeting, a developer on a call, a client on a link.
 * Figma's Present is the shape everyone knows, so the gestures are its
 * gestures — arrows and space to move, Escape to leave, a bar that gets out of
 * the way until you move the mouse.
 *
 * What is different here is what a frame *is*. These are real browser
 * viewports, so presenting one is not showing a picture of a design at some
 * zoom: it is the page, at its own width, scaled. `Fit` scales it down to the
 * window, `Actual size` shows it at 1:1, and `Fill width` is what a screenshot
 * in a deck never is — the design responding to the width it is given.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { NodeId } from '@playground/shared';
import { getArtboardPosition, getArtboardSize, makeComment } from '@playground/shared';
import { useCanvas, getDoc, getNodeById } from './state/store.ts';
import { useArtboardFrame } from './canvas/frame.ts';
import { NodeView } from './canvas/NodeView.tsx';
import { CommentPin, CommentComposer, authorName } from './canvas/CommentPin.tsx';
import { Icon } from './ui/Icon.tsx';

type Scaling = 'fit' | 'fill' | 'actual';

/** One shared empty list, so an absent value is a stable reference. */
const EMPTY: never[] = [];

const SCALING: { value: Scaling; label: string; hint: string }[] = [
  { value: 'fit', label: 'Fit', hint: 'The whole frame, scaled to the window' },
  { value: 'fill', label: 'Fill width', hint: 'The frame at the window’s width — the design responds to it' },
  { value: 'actual', label: 'Actual size', hint: 'One to one, scrollable' },
];

export function Present() {
  const present = useCanvas((s) => s.present);
  const setPresent = useCanvas((s) => s.setPresent);
  const doc = getDoc();

  const [scaling, setScaling] = useState<Scaling>('fit');
  /*
   * A zoom the person set themselves, which overrides the scaling mode until
   * they pick one again. Presenting is not only showing: it is also "hold on,
   * let me get closer to that", and a mode with three fixed sizes cannot do it.
   */
  const [custom, setCustom] = useState<number | null>(null);
  const [showComments, setShowComments] = useState(false);
  const [chrome, setChrome] = useState(true);
  // Measured from the stage, not the window: the stage has padding, and a
  // "fit" computed from the window is a frame that overflows it by that much.
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  const hideTimer = useRef<number>(0);
  // Read by the wheel handler, which is installed once and must not close over
  // a stale fit — the window can be resized under it.
  const fittedRef = useRef(1);

  const page = doc?.pages.find((p) => p.id === present?.pageId) ?? doc?.pages[0];
  const frames = useMemo(
    () => (page?.artboards ?? []).filter((id) => !!doc?.nodes[id]),
    [page, doc],
  );
  const index = Math.min(present?.index ?? 0, Math.max(0, frames.length - 1));
  const current = frames[index];

  const go = useCallback((next: number) => {
    if (!present) return;
    const index = Math.max(0, Math.min(frames.length - 1, next));
    if (index === present.index) return;
    // A zoom belongs to the frame you were looking at, not to the deck.
    setCustom(null);
    setPresent({ ...present, index });
  }, [present, frames.length, setPresent]);

  // The bar gets out of the way of the thing it is describing, and comes back
  // the moment the pointer moves — the convention every player and every
  // presentation tool shares.
  const wake = useCallback(() => {
    setChrome(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setChrome(false), 2600);
  }, []);

  useEffect(() => {
    if (!present) return;
    wake();
    const measure = () => {
      const box = stageRef.current?.getBoundingClientRect();
      setSize(box && box.width
        ? { width: box.width, height: box.height }
        : { width: window.innerWidth, height: window.innerHeight });
    };
    measure();
    const observer = stageRef.current ? new ResizeObserver(measure) : null;
    if (stageRef.current) observer?.observe(stageRef.current);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      window.clearTimeout(hideTimer.current);
    };
  }, [present, wake]);

  const onKey = useCallback((e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    const typing = target?.tagName === 'TEXTAREA' || target?.tagName === 'INPUT';
    if (typing && e.key !== 'Escape') return;
    const keys = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', ' ', 'Home', 'End',
      'Escape', 'PageDown', 'PageUp', 'f', 'c'];
    if (!keys.includes(e.key) || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    e.stopPropagation();
    wake();
    if (e.key === 'Escape') {
      if (useCanvas.getState().draftComment) return useCanvas.getState().setDraftComment(null);
      return exit(setPresent);
    }
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ' || e.key === 'PageDown') go(index + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') go(index - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(frames.length - 1);
    else if (e.key === 'f') void toggleFullscreen();
    else if (e.key === 'c') setShowComments((v) => !v);
  }, [index, frames.length, go, setPresent, wake]);

  useEffect(() => {
    if (!present) return;
    // Capture, because the editor's own shortcuts are still listening: `f`
    // would otherwise pick up the frame tool behind the presentation.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [present, onKey]);

  /*
   * And the same handler inside the frame.
   *
   * An artboard is a real iframe, and clicking one moves focus into its
   * document — after which its key events belong to that window and never
   * reach this one. It showed up as the arrows going dead at Actual size,
   * where you click to scroll around before trying to move on.
   */
  useEffect(() => {
    if (!present) return;
    let frameDoc: Document | null = null;
    const attach = () => {
      const next = document.querySelector<HTMLIFrameElement>('.present-frame iframe')?.contentDocument ?? null;
      if (next === frameDoc) return;
      frameDoc?.removeEventListener('keydown', onKey, true);
      frameDoc = next;
      frameDoc?.addEventListener('keydown', onKey, true);
    };
    attach();
    // The frame is replaced on every move through the deck, so this keeps up
    // with it rather than assuming the one that was there when it started.
    const timer = window.setInterval(attach, 400);
    return () => {
      window.clearInterval(timer);
      frameDoc?.removeEventListener('keydown', onKey, true);
    };
  }, [present, onKey]);

  /*
   * Zoom on ⌘/Ctrl-wheel, which is also what a trackpad pinch sends.
   *
   * A native listener because React registers wheel as passive, where
   * preventDefault does nothing but warn — and without it the browser zooms
   * the whole window, which is the thing this tool has to stop doing.
   *
   * The point under the cursor is held by measuring where it lands after the
   * new scale and scrolling back by the difference. Computing it in advance
   * means predicting what the centring margins will do, which is a second
   * layout algorithm to keep in step with the first.
   */
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !present) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const frame = stage.querySelector<HTMLElement>('.present-frame');
      if (!frame) return;
      const rect = frame.getBoundingClientRect();
      const at = { x: (e.clientX - rect.left), y: (e.clientY - rect.top) };
      setCustom((previous) => {
        const from = previous ?? fittedRef.current;
        const next = Math.min(4, Math.max(0.05, from * (1 - e.deltaY / 400)));
        const k = next / from;
        requestAnimationFrame(() => {
          const after = frame.getBoundingClientRect();
          stage.scrollLeft += (after.left + at.x * k) - e.clientX;
          stage.scrollTop += (after.top + at.y * k) - e.clientY;
        });
        return next;
      });
      wake();
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [present, wake]);

  if (!present || !doc || !page || !current) return null;

  const node = doc.nodes[current];
  const { width, height } = node ? getArtboardSize(node) : { width: 0, height: 0 };
  const fitted = scaling === 'actual' ? 1
    : scaling === 'fill' ? size.width / Math.max(1, width)
      : Math.min(size.width / Math.max(1, width), size.height / Math.max(1, height));
  const scale = custom ?? fitted;
  fittedRef.current = fitted;

  return createPortal(
    <div
      className={`present${chrome ? '' : ' is-idle'}`}
      onPointerMove={wake}
      role="dialog"
      aria-label={`Presenting ${doc.name}`}
    >
      <div
        className="present-stage"
        ref={stageRef}
        onClick={(e) => {
          // A click advances, the way it does in every presentation — unless
          // comments are on, where a click is where the comment goes.
          if (showComments) return;
          if ((e.target as HTMLElement).closest('.present-bar')) return;
          go(index + 1);
        }}
      >
        <PresentFrame
          id={current}
          width={width}
          height={height}
          scale={scale}
          scaling={scaling}
          comments={showComments}
        />
      </div>

      <div className="present-bar" onClick={(e) => e.stopPropagation()}>
        <button className="icon-button" onClick={() => exit(setPresent)} aria-label="Leave presentation" title="Leave  Esc">
          <Icon name="close" size={14} />
        </button>

        <span className="present-title">
          <strong>{node?.name}</strong>
          <span className="dim">{width} × {height}</span>
        </span>

        <span className="present-nav">
          <button className="icon-button" onClick={() => go(index - 1)} disabled={index === 0} aria-label="Previous frame">
            <Icon name="chevronLeft" size={14} />
          </button>
          <span className="present-counter tabular">{index + 1} / {frames.length}</span>
          <button
            className="icon-button" onClick={() => go(index + 1)}
            disabled={index === frames.length - 1} aria-label="Next frame"
          ><Icon name="chevronRight" size={14} /></button>
        </span>

        {doc.pages.length > 1 && (
          <select
            className="input select present-page"
            value={page.id}
            aria-label="Page"
            onChange={(e) => setPresent({ pageId: e.target.value, index: 0 })}
          >
            {doc.pages.map((p) => (
              <option key={p.id} value={p.id}>{p.name} · {p.artboards.length}</option>
            ))}
          </select>
        )}

        <div className="segmented is-auto present-scaling">
          {SCALING.map((s) => (
            <button
              key={s.value}
              className={scaling === s.value ? 'is-active' : ''}
              title={s.hint}
              onClick={() => { setScaling(s.value); setCustom(null); }}
            >{s.label}</button>
          ))}
        </div>

        {custom !== null && (
          <button
            className="present-zoom tabular"
            onClick={() => setCustom(null)}
            title="Back to the scaling mode"
          >{Math.round(scale * 100)}%</button>
        )}

        <button
          className={`icon-button${showComments ? ' is-active' : ''}`}
          onClick={() => setShowComments((v) => !v)}
          aria-pressed={showComments}
          title="Comments  C"
          aria-label="Comments"
        ><Icon name="comment" size={14} /></button>

        <button className="icon-button" onClick={() => void toggleFullscreen()} title="Full screen  F" aria-label="Full screen">
          <Icon name="frame" size={14} />
        </button>
      </div>

      {showComments && (
        <p className="present-hint">Click the design to leave a comment · C to stop</p>
      )}
    </div>,
    document.body,
  );
}

/**
 * The frame itself.
 *
 * Rendered at its true size and scaled with a transform rather than by shrinking
 * the viewport, which is the whole point: at 40% the media queries still resolve
 * against 1440px, so what is on screen is the desktop layout made small and not
 * the mobile layout.
 */
function PresentFrame({ id, width, height, scale, scaling, comments }: {
  id: NodeId; width: number; height: number; scale: number; scaling: Scaling; comments: boolean;
}) {
  const { frameRef, body } = useArtboardFrame(id, true, { register: false });
  const node = getNodeById(id);
  const doc = getDoc();
  // Not `s.doc?.comments ?? []`: that returns a fresh array every time the
  // selector runs, which the store reads as a change, which re-renders, which
  // runs the selector — the loop React reports as "maximum update depth".
  const allComments = useCanvas((s) => s.doc?.comments) ?? EMPTY;
  const setDraftComment = useCanvas((s) => s.setDraftComment);
  const setOpenComment = useCanvas((s) => s.setOpenComment);
  const readOnly = useCanvas((s) => s.readOnly);

  const origin = node ? getArtboardPosition(node) : { x: 0, y: 0 };

  // Comments live in canvas coordinates, so the ones that belong to this frame
  // are the ones standing inside its rectangle — which means a comment left
  // here is in the right place on the canvas too, and the other way round.
  const mine = allComments.filter((c) =>
    c.x >= origin.x && c.x <= origin.x + width && c.y >= origin.y && c.y <= origin.y + height);

  const place = (e: React.MouseEvent) => {
    if (!comments || readOnly || !doc) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const local = { x: (e.clientX - rect.left) / scale, y: (e.clientY - rect.top) / scale };
    setOpenComment(null);
    setDraftComment(makeComment({
      pageId: doc.pages.find((p) => p.artboards.includes(id))?.id ?? doc.pages[0]!.id,
      x: origin.x + local.x,
      y: origin.y + local.y,
      author: authorName(),
      text: '',
    }));
  };

  return (
    <div
      className={`present-frame is-${scaling}`}
      style={{ width: width * scale, height: height * scale }}
    >
      <div
        className="present-frame-inner"
        style={{ width, height, transform: `scale(${scale})`, transformOrigin: 'top left' }}
        onClick={place}
      >
        <iframe
          ref={frameRef}
          title={node?.name ?? 'Frame'}
          // Presented frames are for looking at: nothing here edits the
          // document, so the frame does not need to reach back out of itself.
          sandbox="allow-same-origin allow-scripts"
          /*
           * Transparent to the pointer.
           *
           * An iframe swallows every event that happens over it — clicks never
           * reach the presentation, ⌘-wheel never reaches the zoom, and a click
           * moves focus into that document, after which the arrow keys belong
           * to it. Since a presented frame is for looking at, the cheapest
           * correct answer is for it not to take the pointer at all.
           */
          style={{
            width, height, border: 0, display: 'block', background: '#fff',
            pointerEvents: 'none',
          }}
        />
        {body && createPortal(<NodeView id={id} isRoot />, body)}
      </div>

      {comments && (
        <div
          className="present-comments"
          style={{ left: -origin.x * scale, top: -origin.y * scale }}
        >
          {mine.map((c) => <CommentPin key={c.id} comment={c} scale={scale} />)}
          <CommentComposer scale={scale} />
        </div>
      )}
    </div>
  );
}

function exit(setPresent: (v: null) => void): void {
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  setPresent(null);
}

async function toggleFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    // Denied by the browser, or unsupported. The view is already full-window.
  }
}
