/** The wrapper an agent generates: the mount contract, around the real component. */
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import Button from './components/Button.tsx';

const roots = new WeakMap<Element, Root>();

export function mount(element: Element, props: Record<string, unknown>) {
  let root = roots.get(element);
  if (!root) { root = createRoot(element); roots.set(element, root); }
  root.render(createElement(Button, props));
}

export function unmount(element: Element) {
  roots.get(element)?.unmount();
  roots.delete(element);
}
