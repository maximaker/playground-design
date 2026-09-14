import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyDocument, makeNode } from './model.ts';
import { applyOp } from './ops.ts';
import { emitJsx } from './jsx.ts';
import { emitHtml } from './html.ts';
import {
  type CodeComponent, codeElementJsx, collectCodeImports, resolvedCodeProps,
} from './code-components.ts';

function docWithComponent(overrides: Partial<CodeComponent> = {}) {
  const doc = createEmptyDocument('Test');
  applyOp(doc, {
    t: 'code-component', action: 'add',
    component: {
      id: 'cc1', name: 'Button', importPath: '@/components/Button', bundle: 'a1',
      exportName: 'default',
      props: [
        { name: 'variant', type: 'enum', values: ['primary', 'ghost'], default: 'primary' },
        { name: 'count', type: 'number' },
        { name: 'disabled', type: 'boolean' },
        { name: 'label', type: 'string' },
      ],
      ...overrides,
    },
  });
  return doc;
}

test('adding a code component is reversible', () => {
  const doc = createEmptyDocument('Test');
  const inverse = applyOp(doc, {
    t: 'code-component', action: 'add',
    component: { id: 'cc1', name: 'Button', importPath: '@/b', bundle: 'a1' },
  });
  assert.equal(doc.codeComponents!.cc1!.name, 'Button');
  applyOp(doc, inverse);
  assert.equal(doc.codeComponents!.cc1, undefined);
});

test('updating a code component is reversible field by field', () => {
  const doc = docWithComponent();
  const inverse = applyOp(doc, {
    t: 'code-component', action: 'update', component: { id: 'cc1', bundle: 'a2' },
  });
  assert.equal(doc.codeComponents!.cc1!.bundle, 'a2');
  assert.equal(doc.codeComponents!.cc1!.name, 'Button', 'fields not mentioned survive an update');
  applyOp(doc, inverse);
  assert.equal(doc.codeComponents!.cc1!.bundle, 'a1');
});

test('props are coerced to their declared type and defaults fill in', () => {
  const doc = docWithComponent();
  const component = doc.codeComponents!.cc1!;
  const node = makeNode({ type: 'code', codeRef: 'cc1', props: { count: '3', disabled: 'true' } });
  const resolved = resolvedCodeProps(component, node);
  assert.equal(resolved.count, 3);
  assert.equal(resolved.disabled, true);
  assert.equal(resolved.variant, 'primary', 'a declared default fills in');
});

test('a prop the component no longer declares is dropped, not passed on', () => {
  const doc = docWithComponent();
  const node = makeNode({ type: 'code', codeRef: 'cc1', props: { gone: 'x', label: 'Save' } });
  const resolved = resolvedCodeProps(doc.codeComponents!.cc1!, node);
  assert.equal(resolved.gone, undefined);
  assert.equal(resolved.label, 'Save');
});

test('an enum value outside the declared set falls back to the default', () => {
  const doc = docWithComponent();
  const node = makeNode({ type: 'code', codeRef: 'cc1', props: { variant: 'nonsense' } });
  assert.equal(resolvedCodeProps(doc.codeComponents!.cc1!, node).variant, 'primary');
});

test('the JSX element uses real prop syntax per type', () => {
  const doc = docWithComponent();
  const jsx = codeElementJsx(doc.codeComponents!.cc1!, { variant: 'ghost', count: 3, disabled: true });
  assert.equal(jsx, '<Button variant="ghost" count={3} disabled />');
});

test('exporting JSX emits the real component with its import', () => {
  const doc = docWithComponent();
  const page = doc.pages[0]!;
  const artboard = doc.nodes[page.artboards[0]!]!;
  const node = makeNode({ type: 'code', codeRef: 'cc1', props: { variant: 'ghost' }, parent: artboard.id });
  applyOp(doc, { t: 'insert', nodes: [node], parent: artboard.id, index: 0 });

  const out = emitJsx(doc, artboard.id, { componentName: 'Screen' });
  assert.match(out, /import Button from "@\/components\/Button";/);
  assert.match(out, /<Button variant="ghost" \/>/);
  assert.doesNotMatch(out, /<div[^>]*>\s*<\/div>\s*<Button/, 'the node itself is replaced, not wrapped');
});

test('export omits props the instance left at the component default', () => {
  const doc = docWithComponent();
  const artboard = doc.nodes[doc.pages[0]!.artboards[0]!]!;
  const node = makeNode({ type: 'code', codeRef: 'cc1', props: { variant: 'primary' }, parent: artboard.id });
  applyOp(doc, { t: 'insert', nodes: [node], parent: artboard.id, index: 0 });
  assert.match(emitJsx(doc, artboard.id), /<Button \/>/,
    'the component already defines its defaults; repeating them freezes today\'s value into the caller');
});

test('named and default exports from one path collapse into one import', () => {
  const doc = docWithComponent();
  applyOp(doc, {
    t: 'code-component', action: 'add',
    component: { id: 'cc2', name: 'Icon', importPath: '@/components/Button', bundle: 'a2', exportName: 'Icon' },
  });
  const artboard = doc.nodes[doc.pages[0]!.artboards[0]!]!;
  for (const ref of ['cc1', 'cc2']) {
    const n = makeNode({ type: 'code', codeRef: ref, parent: artboard.id });
    applyOp(doc, { t: 'insert', nodes: [n], parent: artboard.id, index: 0 });
  }
  assert.deepEqual(collectCodeImports(doc, artboard.id), [
    'import Button, { Icon } from "@/components/Button";',
  ]);
});

test('HTML export marks the mount point rather than emitting empty markup', () => {
  const doc = docWithComponent();
  const artboard = doc.nodes[doc.pages[0]!.artboards[0]!]!;
  const node = makeNode({ type: 'code', codeRef: 'cc1', parent: artboard.id });
  applyOp(doc, { t: 'insert', nodes: [node], parent: artboard.id, index: 0 });

  const { html } = emitHtml(doc, artboard.id);
  assert.match(html, /Button from @\/components\/Button: a code component/);
});
