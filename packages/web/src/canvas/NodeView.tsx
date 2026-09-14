/**
 * Renders one document node as a real DOM element inside an artboard iframe.
 *
 * Everything here is the browser doing the work: flexbox is flexbox, text wraps
 * under the real font, media queries resolve against the iframe's width. The
 * editor never simulates layout, which is the whole premise of the tool.
 *
 * Each node subscribes to its own change counter rather than a document-wide
 * one, so editing one element re-renders one element. Subscribing everything to
 * a single counter is the obvious approach and it is quadratic in practice — on
 * a thousand-layer page it put a drag at single-digit frames per second.
 */

import { createElement, memo, useCallback, useEffect, useRef } from 'react';
import { type ExpandedNode, type NodeId, expandInstance } from '@playground/shared';
import { useCanvas, getDoc, getNodeById } from '../state/store.ts';
import { toReactStyle } from './styles.ts';

const VOID_TAGS = new Set(['img', 'br', 'hr', 'input', 'source', 'track', 'wbr']);

/** Attributes that must not reach the DOM — they would break editing or escape the canvas. */
const BLOCKED_ATTRS = new Set(['style', 'class', 'contenteditable', 'onclick', 'onload', 'onerror']);

interface Props { id: NodeId; isRoot?: boolean }

export const NodeView = memo(function NodeView({ id, isRoot }: Props) {
  // Two subscriptions: this node's own content, and the structure counter that
  // covers child lists, tokens and component definitions.
  useCanvas((s) => s.nodeVersions[id] ?? 0);
  useCanvas((s) => s.structureVersion);

  const editingText = useCanvas((s) => s.editingText);
  const node = getNodeById(id);
  const doc = getDoc();
  if (!doc || !node || !node.visible) return null;

  // Instances render a definition, so they expand; everything else renders its
  // own children as their own subscribers.
  if (node.type === 'instance') {
    const expanded = expandInstance(doc, node);
    if (!expanded) return null;
    return <ExpandedView expanded={expanded} isRoot={isRoot} editingText={editingText} />;
  }

  const props = domProps(node.attrs, id, node.styles, isRoot);

  if (node.type === 'vector') {
    return createElement(node.tag, { ...props, dangerouslySetInnerHTML: { __html: node.text ?? '' } });
  }
  if (VOID_TAGS.has(node.tag)) {
    return createElement(node.tag, props);
  }
  if (node.type === 'text') {
    if (editingText === id) {
      return <EditableText nodeKey={id} tag={node.tag} text={node.text ?? ''} attrs={props} />;
    }
    return createElement(node.tag, props, node.text ?? '');
  }

  return createElement(
    node.tag,
    props,
    node.children.map((childId) => <NodeView key={childId} id={childId} />),
  );
});

/**
 * Renders the expansion of a component instance. Everything under an instance
 * re-renders together, which is fine: an instance is a small subtree, and its
 * parts do not have independent identities in the document.
 */
const ExpandedView = memo(function ExpandedView({ expanded, isRoot, editingText }: {
  expanded: ExpandedNode;
  isRoot?: boolean;
  editingText: string | null;
}) {
  const node = expanded.node;
  const props = domProps(node.attrs, expanded.key, node.styles, isRoot);

  if (node.type === 'vector') {
    return createElement(node.tag, { ...props, dangerouslySetInnerHTML: { __html: node.text ?? '' } });
  }
  if (VOID_TAGS.has(node.tag)) {
    return createElement(node.tag, props);
  }
  if (node.type === 'text') {
    if (editingText === expanded.key) {
      return <EditableText nodeKey={expanded.key} tag={node.tag} text={node.text ?? ''} attrs={props} />;
    }
    return createElement(node.tag, props, node.text ?? '');
  }

  return createElement(
    node.tag,
    props,
    expanded.children.map((child) => (
      <ExpandedView key={child.key} expanded={child} editingText={editingText} />
    )),
  );
});

function domProps(
  attrs: Record<string, string>,
  key: string,
  styles: Record<string, string>,
  isRoot?: boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    const lower = k.toLowerCase();
    if (BLOCKED_ATTRS.has(lower) || lower.startsWith('on')) continue;
    if (lower === 'data-x' || lower === 'data-y') continue;
    out[k] = v;
  }
  const style = toReactStyle(styles);
  // The editor-facing identity: for a node inside an instance this addresses
  // the override, not the shared definition node.
  out['data-node-id'] = key;
  out.style = isRoot ? { ...style, width: '100%', height: '100%' } : style;
  return out;
}

/**
 * In-place text editing.
 *
 * The element is contentEditable while focused and the document is updated once,
 * on commit, so a long edit is a single undo step rather than one per keystroke.
 * Commit runs on blur *and* on unmount: relying on blur alone silently loses the
 * edit whenever focus moves without a focusout on this element, which is exactly
 * what happens when the user clicks elsewhere on the canvas.
 */
function EditableText({ nodeKey, tag, text, attrs }: {
  nodeKey: string; tag: string; text: string; attrs: Record<string, unknown>;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const setText = useCanvas((s) => s.setNodeText);
  const setEditingText = useCanvas((s) => s.setEditingText);
  const original = useRef<string>(text);
  const committed = useRef(false);
  // Tracked as it is typed. Reading the DOM at commit time is not safe: by the
  // time an unmount cleanup runs, the element can already be detached, and
  // reading it then yields an empty string that would wipe the user's text.
  const latest = useRef<string>(text);

  const commit = useCallback(() => {
    if (committed.current) return;
    committed.current = true;
    const live = ref.current;
    const next = live?.isConnected ? (live.textContent ?? latest.current) : latest.current;
    if (next !== original.current) setText(nodeKey, next);
  }, [setText, nodeKey]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Focus the iframe's window first; focusing an element inside an iframe that
    // does not itself have focus is a no-op in some browsers.
    const view = el.ownerDocument.defaultView;
    view?.focus();
    el.focus({ preventScroll: true });

    const selection = view?.getSelection();
    if (selection) {
      const range = el.ownerDocument.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
    }

    return () => { commit(); };
  }, [commit]);

  const onBlur = useCallback(() => {
    commit();
    setEditingText(null);
  }, [commit, setEditingText]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      // Cancel: restore the original text and suppress the unmount commit.
      committed.current = true;
      if (ref.current) ref.current.textContent = original.current;
      setEditingText(null);
      e.preventDefault();
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      commit();
      setEditingText(null);
      e.preventDefault();
    }
    e.stopPropagation();
  }, [commit, setEditingText]);

  return createElement(tag, {
    ...attrs,
    ref,
    contentEditable: true,
    suppressContentEditableWarning: true,
    onBlur,
    onKeyDown,
    onInput: (e: React.FormEvent<HTMLElement>) => { latest.current = e.currentTarget.textContent ?? ''; },
    onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
  }, original.current);
}
