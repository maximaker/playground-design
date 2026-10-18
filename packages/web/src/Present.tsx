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
import type { BoardSide, CanvasDocument, NodeId, Page } from '@playground/shared';
import { boardOf, getArtboardPosition, getArtboardSize, makeComment } from '@playground/shared';
import { useCanvas, getDoc, getNodeById } from './state/store.ts';
import { useArtboardFrame } from './canvas/frame.ts';
import { NodeView } from './canvas/NodeView.tsx';
import { CommentPin, CommentComposer, authorName } from './canvas/CommentPin.tsx';
import { Icon } from './ui/Icon.tsx';
import { artboardSurface } from './canvas/surface.ts';

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

  // On a phone a frame is read with a finger: as wide as the screen, scrolled.
  const [scaling, setScaling] = useState<Scaling>(() => (window.innerWidth <= 700 ? 'fill' : 'fit'));
  const swipe = useRef<{ x: number; y: number; at: number } | null>(null);
  const swiped = useRef(false);
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
  const links = useMemo(
    () => (doc && page && current ? linksFrom(doc, page, current, frames) : []),
    [doc, page, current, frames],
  );

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
    // A pointer resting on the bar is using it: keep it until the pointer leaves.
    const hide = () => {
      if (document.querySelector('.present-bar:hover')) hideTimer.current = window.setTimeout(hide, 800);
      else setChrome(false);
    };
    hideTimer.current = window.setTimeout(hide, 2600);
  }, []);

  // Keyed on presenting at all, not on the slide: moving to the next slide
  // re-ran this and woke the bar on every arrow press, even in full screen.
  const presenting = !!present;
  useEffect(() => {
    if (!presenting) return;
    wake();
    const measure = () => {
      const box = stageRef.current?.getBoundingClientRect();
      // The stage's padding is not room for the frame: a fit to the outer box
      // overflows it by exactly that much, cut off on the right.
      const cs = stageRef.current ? getComputedStyle(stageRef.current) : null;
      const padX = cs ? parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) : 0;
      const padY = cs ? parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) : 0;
      setSize(box && box.width
        ? { width: box.width - padX, height: box.height - padY }
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
  }, [presenting, wake]);

  const onKey = useCallback((e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    const typing = target?.tagName === 'TEXTAREA' || target?.tagName === 'INPUT';
    if (typing && e.key !== 'Escape') return;
    const keys = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', ' ', 'Home', 'End',
      'Escape', 'PageDown', 'PageUp', 'f', 'c'];
    if (!keys.includes(e.key) || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    e.stopPropagation();
    // Navigating is not asking for the controls; only the pointer brings them back.
    if (e.key === 'f' || e.key === 'c') wake();
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
      // Only a pointer moving into the bottom band, where the bar lives, shows
      // it. Moving over the slide, or the slide changing under a still pointer
      // (browsers report that as a move), leaves the presentation clean.
      onPointerMove={(e) => {
        if (!(e.movementX || e.movementY)) return;
        if (e.clientY > window.innerHeight - 140) wake();
      }}
      role="dialog"
      aria-label={`Presenting ${doc.name}`}
    >
      <div
        className="present-stage"
        ref={stageRef}
        // A horizontal swipe moves through the deck; a vertical one scrolls the frame.
        onPointerDown={(e) => {
          if (e.pointerType !== 'mouse') swipe.current = { x: e.clientX, y: e.clientY, at: Date.now() };
        }}
        onPointerUp={(e) => {
          const start = swipe.current;
          swipe.current = null;
          if (!start) return;
          const dx = e.clientX - start.x, dy = e.clientY - start.y;
          if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.5 && Date.now() - start.at < 700) {
            swiped.current = true;
            go(index + (dx < 0 ? 1 : -1));
          }
        }}
        onClick={(e) => {
          if (swiped.current) { swiped.current = false; return; }
          // A click advances, the way it does in every presentation — unless
          // comments are on, where a click is where the comment goes.
          if (showComments) return;
          if ((e.target as HTMLElement).closest('.present-bar')) return;
          // A screen that the board connects onward is a prototype: a click
          // follows the connector nearest to where you clicked, not the deck.
          const frameEl = (e.target as HTMLElement).closest<HTMLElement>('.present-frame');
          if (frameEl && links.length) {
            const r = frameEl.getBoundingClientRect();
            const px = (e.clientX - r.left) / r.width;
            const py = (e.clientY - r.top) / r.height;
            const nearest = links
              .map((l) => ({ l, d: Math.hypot(SIDE_POINT[l.side].x - px, SIDE_POINT[l.side].y - py) }))
              .sort((a, b) => a.d - b.d)[0]!.l;
            return go(nearest.index);
          }
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
          links={showComments ? EMPTY : links}
          onLink={go}
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
          <button className="icon-button" onClick={() => go(index - 1)} disabled={index === 0} aria-label="Previous frame" title="Previous  ←">
            <Icon name="chevronLeft" size={14} />
          </button>
          <span className="present-counter tabular">{index + 1} / {frames.length}</span>
          <button
            className="icon-button" onClick={() => go(index + 1)}
            disabled={index === frames.length - 1} aria-label="Next frame" title="Next  →"
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

        <button
          className="present-scale-cycle"
          onClick={() => {
            const order: Scaling[] = ['fill', 'fit', 'actual'];
            setScaling(order[(order.indexOf(scaling) + 1) % order.length]!);
            setCustom(null);
          }}
          aria-label="Change scaling"
        >{SCALING.find((x) => x.value === scaling)?.label}</button>

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
          <Icon name="fullscreen" size={14} />
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
function PresentFrame({ id, width, height, scale, scaling, comments, links, onLink }: {
  id: NodeId; width: number; height: number; scale: number; scaling: Scaling; comments: boolean;
  links: Link[]; onLink: (index: number) => void;
}) {
  const { frameRef, body } = useArtboardFrame(id, true, { register: false });
  const node = getNodeById(id);
  const surface = artboardSurface(node);
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
      className={`present-frame is-${scaling}${surface.clear ? ' is-clear' : ''}`}
      style={{
        width: width * scale, height: height * scale,
        background: surface.sheet,
        // The radius is the artboard's, in its own pixels, so it scales with it.
        borderRadius: surface.radius ? `calc(${surface.radius} * ${scale})` : undefined,
        overflow: surface.radius ? 'hidden' : undefined,
      }}
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
            width, height, border: 0, display: 'block', background: surface.sheet,
            pointerEvents: 'none',
          }}
        />
        {body && createPortal(<NodeView id={id} isRoot />, body)}
      </div>

      {links.length > 0 && (
        <div className="present-links">
          {SIDES.map((side) => {
            const here = links.filter((l) => l.side === side);
            if (!here.length) return null;
            return (
              <div key={side} className={`present-link-group is-${side}`}>
                {here.map((l) => (
                  <button
                    key={l.id}
                    className="present-link"
                    onClick={(e) => { e.stopPropagation(); onLink(l.index); }}
                    title={`Go to ${l.targetName}`}
                  >{l.label || l.targetName} <span aria-hidden>→</span></button>
                ))}
              </div>
            );
          })}
        </div>
      )}

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

/** A connector on the board read as a prototype link out of the current screen. */
interface Link { id: string; index: number; label?: string; targetName: string; side: BoardSide }

const SIDES: BoardSide[] = ['top', 'right', 'bottom', 'left'];
/** Where each side's hotspot sits, as a fraction of the frame. */
const SIDE_POINT: Record<BoardSide, { x: number; y: number }> = {
  top: { x: 0.5, y: 0 }, right: { x: 1, y: 0.5 }, bottom: { x: 0.5, y: 1 }, left: { x: 0, y: 0.5 },
};

/**
 * The connectors that leave `from` for another frame on the page — and the
 * double-headed ones that arrive at it, which go both ways. The side is the
 * one the connector leaves from, given or worked out the way the board does.
 */
function linksFrom(doc: CanvasDocument, page: Page, from: NodeId, frames: NodeId[]): Link[] {
  const out: Link[] = [];
  for (const item of boardOf(page)) {
    if (item.type !== 'connector' || item.from.kind !== 'artboard' || item.to.kind !== 'artboard') continue;
    let target: NodeId | null = null;
    let side: BoardSide | undefined;
    // Going back along a two-way connector, its label names the forward step
    // ("Pay"), so the hint names where you are going instead.
    let reverse = false;
    if (item.from.id === from) { target = item.to.id; side = item.fromSide; }
    else if (item.to.id === from && item.arrow === 'both') { target = item.from.id; side = item.toSide; reverse = true; }
    if (!target || target === from) continue;
    const index = frames.indexOf(target);
    const a = doc.nodes[from];
    const b = doc.nodes[target];
    if (index < 0 || !a || !b) continue;
    out.push({
      id: item.id, index, label: reverse ? undefined : item.label?.trim() || undefined,
      targetName: b.name ?? 'Next screen',
      side: side ?? facing(a, b),
    });
  }
  return out;
}

function facing(a: Parameters<typeof getArtboardSize>[0], b: Parameters<typeof getArtboardSize>[0]): BoardSide {
  const pa = getArtboardPosition(a), sa = getArtboardSize(a);
  const pb = getArtboardPosition(b), sb = getArtboardSize(b);
  const gapX = Math.max(pb.x - (pa.x + sa.width), pa.x - (pb.x + sb.width));
  const gapY = Math.max(pb.y - (pa.y + sa.height), pa.y - (pb.y + sb.height));
  const ca = { x: pa.x + sa.width / 2, y: pa.y + sa.height / 2 };
  const cb = { x: pb.x + sb.width / 2, y: pb.y + sb.height / 2 };
  return gapX >= gapY ? (cb.x >= ca.x ? 'right' : 'left') : (cb.y >= ca.y ? 'bottom' : 'top');
}
