/**
 * Renders one document node as a real DOM element inside an artboard iframe.
 *
 * Everything here is the browser doing the work: flexbox is flexbox, text wraps
 * under the real font, media queries resolve against the iframe's width. The
 * editor never simulates layout, which is the whole premise of the tool.
 */

import { createElement, memo, useCallback, useEffect, useRef } from 'react';
import { type ExpandedNode, type NodeId, expandNode } from '@canvas/shared';
import { useCanvas, getDoc, getNodeById } from '../state/store.ts';
import { toReactStyle } from './styles.ts';

const VOID_TAGS = new Set(['img', 'br', 'hr', 'input', 'source', 'track', 'wbr']);

interface Props { id: NodeId; isRoot?: boolean }

export const NodeView = memo(function NodeView({ id, isRoot }: Props) {
  // `version` is what makes this re-render: the document is mutated in place.
  useCanvas((s) => s.version);
  const doc = getDoc();
  const node = getNodeById(id);
  if (!doc || !node || !node.visible) return null;

  // Expansion resolves component instances, slots and overrides, so the canvas
  // renders exactly what export emits.
  const expanded = expandNode(doc, node);
  if (!expanded) return null;
  return <ExpandedView expanded={expanded} isRoot={isRoot} />;
});

const ExpandedView = memo(function ExpandedView({ expanded, isRoot }: { expanded: ExpandedNode; isRoot?: boolean }) {
  const editingText = useCanvas((s) => s.editingText);
  const node = expanded.node;

  const style = toReactStyle(node.styles);
  const props: Record<string, unknown> = {
    ...sanitizedAttrs(node.attrs),
    // The key is the editor-facing identity: for a node inside an instance it
    // addresses the override, not the shared definition node.
    'data-node-id': expanded.key,
    style: isRoot ? { ...style, width: '100%', height: '100%' } : style,
  };

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
    expanded.children.map((child) => <ExpandedView key={child.key} expanded={child} />),
  );
});

/** Attributes that must not reach the DOM — they would break editing or escape the canvas. */
const BLOCKED_ATTRS = new Set(['style', 'class', 'contenteditable', 'onclick', 'onload', 'onerror']);

function sanitizedAttrs(attrs: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) {
    const key = k.toLowerCase();
    if (BLOCKED_ATTRS.has(key) || key.startsWith('on')) continue;
    if (key === 'data-x' || key === 'data-y') continue;
    out[k] = v;
  }
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
  const latest = useRef<string>(original.current);

  const commit = useCallback(() => {
    if (committed.current) return;
    committed.current = true;
    const live = ref.current;
    const next = live?.isConnected ? (live.textContent ?? latest.current) : latest.current;
    // setNodeText routes to a text op or an instance override depending on what
    // this key addresses, so editing inside a component does the right thing.
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
