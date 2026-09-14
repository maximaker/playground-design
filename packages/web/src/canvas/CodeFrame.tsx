/**
 * Renders one of the project's real React components on the canvas.
 *
 * The bundle is somebody else's code, so it runs in an iframe sandboxed with
 * `allow-scripts` and deliberately *without* `allow-same-origin`. That pair
 * gives it an opaque origin: it cannot touch this document, the parent page,
 * cookies or storage, even though the module is served from our host.
 *
 * The frame reports its content size back over postMessage and we size the box
 * to match, so a component hugs its own content the way it will in the app.
 * Nothing about the component's layout is simulated here either — it is React
 * rendering React.
 */

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { CodeComponent } from '@playground/shared';

interface Props {
  component: CodeComponent;
  props: Record<string, unknown>;
  /** Let pointer events reach the component instead of selecting the node. */
  interactive?: boolean;
  /** False when the node sets its own width, in which case the frame fills it. */
  hug?: boolean;
  onNaturalSize?: (size: { width: number; height: number }) => void;
}

type FrameMessage =
  | { playground: string; type: 'size'; width: number; height: number }
  | { playground: string; type: 'error'; message: string }
  | { playground: string; type: 'ready' };

export const CodeFrame = memo(function CodeFrame({ component, props, interactive, hug = true, onNaturalSize }: Props) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  // The module handshake carries props too, so keep the latest ones reachable
  // from an effect that must not re-run when they change.
  const propsRef = useRef(props);
  propsRef.current = props;
  const [size, setSize] = useState(component.naturalSize ?? { width: 0, height: 0 });
  const [error, setError] = useState<string | null>(null);

  // A token per mount, so a page with ten instances can tell their messages
  // apart — the sandbox has an opaque origin, so `event.source` is all we would
  // otherwise have, and it is unreliable across reloads.
  const token = useMemo(() => Math.random().toString(36).slice(2), [component.bundle]);

  const [source, setSource] = useState<string | null>(() => bundleCache.get(component.bundle) ?? null);

  // Re-registering a component points the node at a new bundle; the old source
  // must not linger, or every instance keeps rendering yesterday's code.
  useEffect(() => {
    setSource(bundleCache.get(component.bundle) ?? null);
    setError(null);
    setSize(component.naturalSize ?? { width: 0, height: 0 });
  }, [component.bundle]);

  // The sandbox has an opaque origin, so every request it makes is cross-origin
  // — and Chrome's private-network rules block an opaque origin from reaching
  // localhost outright, so a bundle URL simply cannot be imported from inside.
  // The parent fetches it instead (same-origin, cached once per bundle) and the
  // frame imports a blob it creates itself, which needs no network at all.
  useEffect(() => {
    if (source !== null) return;
    let cancelled = false;
    loadBundle(component.bundle).then(
      (text) => { if (!cancelled) setSource(text); },
      (err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); },
    );
    return () => { cancelled = true; };
  }, [component.bundle, source]);

  const srcdoc = useMemo(() => frameDocument(token), [token]);

  useEffect(() => {
    // The frame is portalled into an artboard iframe, so `parent` inside the
    // sandbox is *that* window, not the top one. Listening on the top window
    // silently hears nothing, which shows up as components stuck at zero height.
    const host = frameRef.current?.ownerDocument.defaultView ?? window;

    const onMessage = (event: MessageEvent<FrameMessage>) => {
      const data = event.data;
      if (!data || typeof data !== 'object' || data.playground !== token) return;
      if (data.type === 'error') { setError(String(data.message)); return; }
      if (data.type === 'ready') {
        // Send straight away rather than waiting for the next poll tick.
        const text = bundleCache.get(component.bundle);
        if (text !== undefined) {
          frameRef.current?.contentWindow?.postMessage(
            { playground: token, type: 'module', source: text, props: propsRef.current }, '*',
          );
        }
        return;
      }
      setError(null);
      const next = { width: Math.ceil(data.width), height: Math.ceil(data.height) };
      setSize((prev) => (prev.width === next.width && prev.height === next.height ? prev : next));
      onNaturalSize?.(next);
    };
    host.addEventListener('message', onMessage as EventListener);
    return () => host.removeEventListener('message', onMessage as EventListener);
  }, [token, component.bundle, onNaturalSize]);

  // Props change far more often than the bundle does, and re-creating the frame
  // for a prop change would throw away component state and flash. Send them in.
  useEffect(() => {
    frameRef.current?.contentWindow?.postMessage({ playground: token, type: 'props', props }, '*');
  }, [token, JSON.stringify(props)]);

  // The frame polls for the module until it arrives rather than waiting for a
  // load event, because a srcdoc frame can be ready before React's effect runs.
  useEffect(() => {
    if (source === null) return;
    let stop = false;
    const send = () => {
      if (stop) return;
      // Props ride along: a separate props message sent before the frame's
      // listener existed is simply lost, and the instance then renders the
      // component's defaults forever — which looks like working code.
      frameRef.current?.contentWindow?.postMessage(
        { playground: token, type: 'module', source, props: propsRef.current }, '*',
      );
    };
    send();
    const timer = window.setInterval(send, 120);
    const done = window.setTimeout(() => window.clearInterval(timer), 3000);
    return () => { stop = true; window.clearInterval(timer); window.clearTimeout(done); };
  }, [token, source]);

  if (error) {
    return (
      <div
        style={{
          font: '12px ui-monospace, monospace', color: '#b42318', background: '#fef3f2',
          border: '1px dashed #fda29b', borderRadius: 6, padding: '8px 10px', maxWidth: 360,
        }}
      >
        <strong>{component.name}</strong> failed to render: {error}
      </div>
    );
  }

  return (
    <iframe
      ref={frameRef}
      title={component.name}
      // Read by the end-to-end check to tell "React never re-rendered" apart
      // from "the sandbox never applied it" — two failures that look identical.
      data-code-props={JSON.stringify(props)}
      sandbox="allow-scripts"
      srcDoc={srcdoc}
      scrolling="no"
      style={{
        display: 'block',
        border: 0,
        // Zero until the frame reports back; a default guess would show every
        // component at the wrong size for a frame and then jump.
        // Hugging uses the reported width; a node with its own width fills it.
        width: hug ? size.width || 'auto' : '100%',
        height: size.height || 0,
        colorScheme: 'normal',
        pointerEvents: interactive ? 'auto' : 'none',
      }}
    />
  );
});

/** One in-flight fetch and one cached copy per bundle, however many instances. */
const bundleCache = new Map<string, string>();
const inFlight = new Map<string, Promise<string>>();

function loadBundle(assetId: string): Promise<string> {
  const cached = bundleCache.get(assetId);
  if (cached !== undefined) return Promise.resolve(cached);

  let pending = inFlight.get(assetId);
  if (!pending) {
    pending = fetch(`/assets/${assetId}`)
      .then((r) => {
        if (!r.ok) throw new Error(`the bundle could not be loaded (${r.status})`);
        return r.text();
      })
      .then((text) => { bundleCache.set(assetId, text); inFlight.delete(assetId); return text; })
      .catch((err) => { inFlight.delete(assetId); throw err; });
    inFlight.set(assetId, pending);
  }
  return pending;
}

/**
 * The page the bundle runs in. Kept as a string rather than a served file so a
 * code component works identically on the SQLite server and on serverless,
 * where there is no place to put a second HTML entry point.
 */
function frameDocument(token: string): string {
  return `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; background: transparent; }
  body { display: inline-block; }
  /*
   * The content is measured at its natural width, not the frame's.
   *
   * Without this the frame is a feedback loop: we size the iframe from what the
   * component reported, and the component then lays out inside that width, so
   * it can shrink but never grow. A longer label or a larger size prop simply
   * wrapped inside the old box and reported the old number — the component
   * looked frozen while React was handing it the right props all along.
   */
  #root { display: inline-block; width: max-content; }
</style>
<div id="root"></div>
<script type="module">
  const token = ${JSON.stringify(token)};
  const root = document.getElementById('root');
  const send = (msg) => parent.postMessage({ playground: token, ...msg }, '*');

  const report = () => {
    const rect = root.getBoundingClientRect();
    send({ type: 'size', width: rect.width, height: rect.height });
  };

  window.onerror = (message) => send({ type: 'error', message: String(message) });
  window.onunhandledrejection = (e) => send({ type: 'error', message: String(e.reason) });

  let mod = null;
  let props = {};
  let loading = false;

  // Props and the module arrive independently; render whenever we have both
  // rather than assuming an order.
  // React renders asynchronously, so measuring in a microtask reads the old
  // box — and the ResizeObserver callback can fire on that same stale layout.
  // Measuring again over the next two frames is cheap and removes the race;
  // without it the canvas stayed exactly one prop change behind.
  const scheduleReport = () => {
    report();
    requestAnimationFrame(() => { report(); requestAnimationFrame(report); });
    setTimeout(report, 200);
  };

  const render = () => { if (mod) { mod.mount(root, props); scheduleReport(); } };

  window.addEventListener('message', async (event) => {
    const data = event.data;
    if (!data || data.playground !== token) return;

    if (data.type === 'props') { props = data.props ?? {}; render(); return; }

    // The parent keeps offering the module until we have it, so ignore repeats.
    if (data.type !== 'module' || mod || loading) return;
    loading = true;
    if (data.props) props = data.props;
    try {
      // A blob this document creates is same-origin to it, so the import needs
      // no network — which an opaque origin may not have in any case.
      const url = URL.createObjectURL(new Blob([data.source], { type: 'text/javascript' }));
      mod = await import(url);
      URL.revokeObjectURL(url);
      if (typeof mod.mount !== 'function') throw new Error('the bundle does not export mount(element, props)');
      render();
    } catch (err) {
      loading = false;
      send({ type: 'error', message: err && err.message ? err.message : String(err) });
    }
  });

  new ResizeObserver(scheduleReport).observe(root);
  send({ type: 'ready' });
</script>`;
}
