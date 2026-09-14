/**
 * The properties panel.
 *
 * Reads and writes CSS on the selected nodes. Multi-selection shows a value
 * only when every selected node agrees, and writing applies to all of them —
 * anything else silently loses edits.
 */

import { useMemo } from 'react';
import type { CanvasNode, NodeId, StyleMap } from '@canvas/shared';
import { useCanvas, getDoc } from '../state/store.ts';
import { attrOps, resolveKey, resetOverrideOps } from '../state/keys.ts';
import { Field, NumberInput, Row, Section, SegmentedControl, Select, TextInput, ColorInput } from '../ui/controls.tsx';
import { ArrangeBar } from '../ui/ArrangeBar.tsx';

const MIXED = '—'; // em dash: "these nodes disagree"

export function Properties() {
  const version = useCanvas((s) => s.version);
  const selection = useCanvas((s) => s.selection);
  const activeVariant = useCanvas((s) => s.activeVariant);
  const setActiveVariant = useCanvas((s) => s.setActiveVariant);
  const dispatch = useCanvas((s) => s.dispatch);
  const doc = getDoc();

  // Each selected key resolves to the node as rendered — with instance
  // overrides already applied — plus where an edit to it should be written.
  const resolved = useMemo(
    () => selection.map((key) => ({ key, ...(resolveKey(doc, key) ?? {}) }))
      .filter((r): r is { key: string } & NonNullable<ReturnType<typeof resolveKey>> => !!r.node),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selection, version, doc],
  );
  const nodes = resolved.map((r) => r.node).filter((n): n is CanvasNode => !!n);
  const insideInstance = resolved.some((r) => r.defId !== null);

  const tokens = useMemo(() => (doc?.tokens ?? [])
    .filter((t) => t.group === 'color')
    .map((t) => ({
      name: t.name,
      usage: `var(--${t.name.replace(/\./g, '-')})`,
      resolved: t.values.default ?? '',
    })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, version]);

  if (nodes.length === 0) {
    return (
      <div className="properties">
        <p className="panel-empty">
          Select something on the canvas.<br />
          <span className="dim">Or press <kbd>F</kbd> to draw a frame, <kbd>T</kbd> for text.</span>
        </p>
      </div>
    );
  }

  /** The shared value of a property, or MIXED when the selection disagrees. */
  const read = (prop: string): string => {
    const source = (n: CanvasNode): StyleMap =>
      activeVariant
        ? (n.variants.find((v) => v.selector === activeVariant)?.styles ?? {})
        : n.styles;
    const values = new Set(nodes.map((n) => source(n)[prop] ?? ''));
    return values.size === 1 ? [...values][0]! : MIXED;
  };

  const write = (styles: StyleMap) => {
    // Routed through the key layer so an edit inside a component instance
    // becomes an override rather than a change to every instance at once.
    useCanvas.getState().setNodeStyles(selection, styles, activeVariant ?? undefined);
  };

  const set = (prop: string) => (value: string) => write({ [prop]: value === MIXED ? '' : value });

  const first = nodes[0]!;
  const allText = nodes.every((n) => n.type === 'text');
  const anyContainer = nodes.some((n) => n.type === 'frame' || n.type === 'artboard');
  const display = read('display');
  const isFlex = display.includes('flex');
  const isRow = (read('flex-direction') || 'row').startsWith('row');
  const parent = first.parent ? doc?.nodes[first.parent] : undefined;
  const parentIsFlex = (parent?.styles.display ?? '').includes('flex');

  const knownVariants = [...new Set(nodes.flatMap((n) => n.variants.map((v) => v.selector)))];

  return (
    <div className="properties">
      <div className="prop-header">
        <div className="prop-title">
          {nodes.length === 1 ? first.name : `${nodes.length} selected`}
          <span className="prop-type">{nodes.length === 1 ? `${first.type} · ${first.tag}` : 'multiple'}</span>
        </div>
      </div>

      {insideInstance && (
        <div className="instance-banner">
          <span>
            Inside a component. Changes here apply to <strong>this instance only</strong>.
          </span>
          <button
            className="button subtle"
            onClick={() => {
              const ops = resetOverrideOps(doc, selection);
              if (ops.length) dispatch(ops);
            }}
          >Reset to component</button>
        </div>
      )}

      {nodes.length > 1 && <ArrangeBar ids={nodes.map((n) => n.id)} />}

      <div className="variant-bar" title="Which state or breakpoint you are editing">
        <button className={!activeVariant ? 'is-active' : ''} onClick={() => setActiveVariant(null)}>Base</button>
        {[':hover', ':focus', ':active'].map((v) => (
          <button
            key={v}
            className={activeVariant === v ? 'is-active' : ''}
            data-has={knownVariants.includes(v) ? 'yes' : 'no'}
            onClick={() => setActiveVariant(activeVariant === v ? null : v)}
          >{v}</button>
        ))}
        {knownVariants.filter((v) => v.startsWith('@')).map((v) => (
          <button
            key={v}
            className={activeVariant === v ? 'is-active' : ''}
            title={v}
            onClick={() => setActiveVariant(activeVariant === v ? null : v)}
          >{v.replace('@media', '').trim()}</button>
        ))}
        <button
          className="add-variant"
          title="Add a breakpoint override"
          onClick={() => {
            const width = window.prompt('Max width for this breakpoint, in px', '768');
            if (!width) return;
            const selector = `@media (max-width: ${parseInt(width, 10)}px)`;
            write({});
            setActiveVariant(selector);
          }}
        >+</button>
      </div>

      {activeVariant && (
        <p className="variant-note">
          Editing <code>{activeVariant}</code>. Only properties you change here are overridden.
        </p>
      )}

      {nodes.length === 1 && first.type !== 'artboard' && (
        <Section title="Element">
          <Row>
            <Field label="Tag" prop="HTML tag">
              <Select
                value={first.tag}
                options={TAG_OPTIONS}
                onCommit={(tag) => dispatch([{ t: 'tag', updates: [{ id: resolved[0]!.targetId, tag }] }])}
              />
            </Field>
          </Row>
          {first.type === 'image' && (
            <>
              <Row>
                <Field label="Source" prop="src" wide>
                  <TextInput
                    value={first.attrs.src ?? ''}
                    placeholder="https://… or /assets/…"
                    onCommit={(src) => dispatch(attrOps(doc, selection[0]!, { src }))}
                  />
                </Field>
              </Row>
              <Row>
                <Field label="Alt text" prop="alt" wide>
                  <TextInput
                    value={first.attrs.alt ?? ''}
                    placeholder="Describe the image"
                    onCommit={(alt) => dispatch(attrOps(doc, selection[0]!, { alt }))}
                  />
                </Field>
              </Row>
            </>
          )}
        </Section>
      )}

      <Section title="Size & position">
        <Row>
          <Field label="W" prop="width">
            <NumberInput value={read('width')} onCommit={set('width')} allowKeywords={['auto', 'fit-content', '100%']} />
          </Field>
          <Field label="H" prop="height">
            <NumberInput value={read('height')} onCommit={set('height')} allowKeywords={['auto', 'fit-content', '100%']} />
          </Field>
        </Row>
        <Row>
          <Field label="Min W" prop="min-width">
            <NumberInput value={read('min-width')} onCommit={set('min-width')} />
          </Field>
          <Field label="Max W" prop="max-width">
            <NumberInput value={read('max-width')} onCommit={set('max-width')} />
          </Field>
        </Row>
        <Row>
          <Field label="Position" prop="position">
            <Select
              value={read('position') || 'static'}
              options={['static', 'relative', 'absolute', 'fixed', 'sticky'].map((v) => ({ value: v, label: v }))}
              onCommit={set('position')}
            />
          </Field>
          <Field label="Overflow" prop="overflow">
            <Select
              value={read('overflow') || 'visible'}
              options={['visible', 'hidden', 'auto', 'scroll'].map((v) => ({ value: v, label: v }))}
              onCommit={set('overflow')}
            />
          </Field>
        </Row>
        {['absolute', 'fixed', 'sticky'].includes(read('position')) && (
          <Row>
            <Field label="L" prop="left"><NumberInput value={read('left')} onCommit={set('left')} /></Field>
            <Field label="T" prop="top"><NumberInput value={read('top')} onCommit={set('top')} /></Field>
          </Row>
        )}
        {parentIsFlex && (
          <Row>
            <Field label="Grow" prop="flex">
              <SegmentedControl
                value={read('flex') === '1' ? 'fill' : read('flex-grow') === '1' ? 'fill' : 'hug'}
                options={[{ value: 'hug', label: 'Hug' }, { value: 'fill', label: 'Fill' }]}
                onCommit={(v) => write(v === 'fill' ? { flex: '1' } : { flex: '' })}
              />
            </Field>
            <Field label="In flow" prop="position">
              <SegmentedControl
                value={read('position') === 'absolute' ? 'no' : 'yes'}
                options={[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No', title: 'Ignore layout (absolute)' }]}
                onCommit={(v) => write(v === 'no' ? { position: 'absolute' } : { position: '', left: '', top: '' })}
              />
            </Field>
          </Row>
        )}
      </Section>

      {anyContainer && (
        <Section title="Layout">
          <Row>
            <Field label="Display" prop="display">
              <Select
                value={display || 'block'}
                options={['block', 'flex', 'inline-flex', 'grid', 'inline-block', 'none'].map((v) => ({ value: v, label: v }))}
                onCommit={set('display')}
              />
            </Field>
          </Row>

          {isFlex && (
            <>
              <Row>
                <Field label="Direction" prop="flex-direction">
                  <SegmentedControl
                    value={read('flex-direction') || 'row'}
                    options={[
                      { value: 'row', label: '→', title: 'row' },
                      { value: 'column', label: '↓', title: 'column' },
                      { value: 'row-reverse', label: '←', title: 'row-reverse' },
                      { value: 'column-reverse', label: '↑', title: 'column-reverse' },
                    ]}
                    onCommit={set('flex-direction')}
                  />
                </Field>
              </Row>
              <Row>
                <Field label={isRow ? 'Vertical' : 'Horizontal'} prop="align-items">
                  <Select
                    value={read('align-items') || 'stretch'}
                    options={['flex-start', 'center', 'flex-end', 'stretch', 'baseline'].map((v) => ({ value: v, label: v }))}
                    onCommit={set('align-items')}
                  />
                </Field>
                <Field label={isRow ? 'Horizontal' : 'Vertical'} prop="justify-content">
                  <Select
                    value={read('justify-content') || 'flex-start'}
                    options={['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly'].map((v) => ({ value: v, label: v }))}
                    onCommit={set('justify-content')}
                  />
                </Field>
              </Row>
              <Row>
                <Field label="Gap" prop="gap">
                  <NumberInput value={read('gap')} onCommit={set('gap')} min={0} />
                </Field>
                <Field label="Wrap" prop="flex-wrap">
                  <SegmentedControl
                    value={read('flex-wrap') || 'nowrap'}
                    options={[{ value: 'nowrap', label: 'No' }, { value: 'wrap', label: 'Wrap' }]}
                    onCommit={set('flex-wrap')}
                  />
                </Field>
              </Row>
            </>
          )}

          {display === 'grid' && (
            <Row>
              <Field label="Columns" prop="grid-template-columns" wide>
                <TextInput value={read('grid-template-columns')} placeholder="repeat(3, 1fr)" onCommit={set('grid-template-columns')} mono />
              </Field>
            </Row>
          )}

          <Row>
            <Field label="Padding" prop="padding" wide>
              <TextInput value={read('padding')} placeholder="16px or 8px 16px" onCommit={set('padding')} mono />
            </Field>
          </Row>
        </Section>
      )}

      {allText && (
        <Section title="Typography">
          <Row>
            <Field label="Family" prop="font-family" wide>
              <TextInput value={read('font-family')} placeholder="Inter, sans-serif" onCommit={set('font-family')} />
            </Field>
          </Row>
          <Row>
            <Field label="Size" prop="font-size">
              <NumberInput value={read('font-size')} onCommit={set('font-size')} min={1} />
            </Field>
            <Field label="Weight" prop="font-weight">
              <Select
                value={read('font-weight') || '400'}
                options={['100', '200', '300', '400', '500', '600', '700', '800', '900'].map((v) => ({ value: v, label: v }))}
                onCommit={set('font-weight')}
              />
            </Field>
          </Row>
          <Row>
            <Field label="Line height" prop="line-height">
              <TextInput value={read('line-height')} placeholder="1.5" onCommit={set('line-height')} mono />
            </Field>
            <Field label="Spacing" prop="letter-spacing">
              <NumberInput value={read('letter-spacing')} onCommit={set('letter-spacing')} step={0.1} />
            </Field>
          </Row>
          <Row>
            <Field label="Align" prop="text-align">
              <SegmentedControl
                value={read('text-align') || 'left'}
                options={[
                  { value: 'left', label: '⬅' }, { value: 'center', label: '↔' },
                  { value: 'right', label: '➡' }, { value: 'justify', label: '☰' },
                ]}
                onCommit={set('text-align')}
              />
            </Field>
          </Row>
          <Row>
            <Field label="Color" prop="color" wide>
              <ColorInput value={read('color')} onCommit={set('color')} tokens={tokens} />
            </Field>
          </Row>
          <Row>
            <Field label="Transform" prop="text-transform">
              <Select
                value={read('text-transform') || 'none'}
                options={['none', 'uppercase', 'lowercase', 'capitalize'].map((v) => ({ value: v, label: v }))}
                onCommit={set('text-transform')}
              />
            </Field>
            <Field label="Clamp" prop="-webkit-line-clamp">
              <NumberInput value={read('-webkit-line-clamp')} onCommit={(v) => write({
                '-webkit-line-clamp': v,
                display: v ? '-webkit-box' : '',
                '-webkit-box-orient': v ? 'vertical' : '',
                overflow: v ? 'hidden' : '',
              })} suffix="" />
            </Field>
          </Row>
        </Section>
      )}

      <Section title="Fill">
        <Row>
          <Field label="Background" prop="background-color" wide>
            <ColorInput value={read('background-color')} onCommit={set('background-color')} tokens={tokens} />
          </Field>
        </Row>
        <Row>
          <Field label="Image / gradient" prop="background-image" wide>
            <TextInput
              value={read('background-image')}
              placeholder="linear-gradient(...) or url(...)"
              onCommit={set('background-image')}
              mono
            />
          </Field>
        </Row>
        <Row>
          <Field label="Opacity" prop="opacity">
            <NumberInput value={read('opacity')} onCommit={set('opacity')} min={0} max={1} step={0.05} suffix="" />
          </Field>
          <Field label="Blend" prop="mix-blend-mode">
            <Select
              value={read('mix-blend-mode') || 'normal'}
              options={['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'difference', 'luminosity'].map((v) => ({ value: v, label: v }))}
              onCommit={set('mix-blend-mode')}
            />
          </Field>
        </Row>
      </Section>

      <Section title="Border">
        <Row>
          <Field label="Radius" prop="border-radius" wide>
            <TextInput value={read('border-radius')} placeholder="8px or 8px 0 8px 0" onCommit={set('border-radius')} mono />
          </Field>
        </Row>
        <Row>
          <Field label="Width" prop="border-width">
            <NumberInput value={read('border-width')} onCommit={(v) => write({ 'border-width': v, 'border-style': v ? (read('border-style') || 'solid') : '' })} />
          </Field>
          <Field label="Style" prop="border-style">
            <Select
              value={read('border-style') || 'none'}
              options={['none', 'solid', 'dashed', 'dotted'].map((v) => ({ value: v, label: v }))}
              onCommit={set('border-style')}
            />
          </Field>
        </Row>
        <Row>
          <Field label="Color" prop="border-color" wide>
            <ColorInput value={read('border-color')} onCommit={set('border-color')} tokens={tokens} />
          </Field>
        </Row>
      </Section>

      <Section title="Effects" defaultOpen={false}>
        <Row>
          <Field label="Shadow" prop="box-shadow" wide>
            <TextInput value={read('box-shadow')} placeholder="0 4px 12px rgba(0,0,0,.12)" onCommit={set('box-shadow')} mono />
          </Field>
        </Row>
        <Row>
          <Field label="Blur" prop="filter">
            <NumberInput
              value={extractBlur(read('filter'))}
              onCommit={(v) => write({ filter: v ? `blur(${v})` : '' })}
            />
          </Field>
          <Field label="Backdrop" prop="backdrop-filter">
            <NumberInput
              value={extractBlur(read('backdrop-filter'))}
              onCommit={(v) => write({ 'backdrop-filter': v ? `blur(${v})` : '' })}
            />
          </Field>
        </Row>
        <Row>
          <Field label="Transition" prop="transition" wide>
            <TextInput value={read('transition')} placeholder="all 150ms ease" onCommit={set('transition')} mono />
          </Field>
        </Row>
        <Row>
          <Field label="Transform" prop="transform" wide>
            <TextInput value={read('transform')} placeholder="translateY(-2px) scale(1.02)" onCommit={set('transform')} mono />
          </Field>
        </Row>
      </Section>

      <RawCss nodes={nodes} keys={selection} activeVariant={activeVariant} />
    </div>
  );
}

function extractBlur(filter: string): string {
  const m = /blur\(\s*([^)]+)\s*\)/.exec(filter);
  return m ? m[1]!.trim() : '';
}

/**
 * The escape hatch. Every property the panel does not expose is editable here,
 * which is what keeps the curated UI from becoming a cage.
 */
function RawCss({ nodes, keys, activeVariant }: { nodes: CanvasNode[]; keys: string[]; activeVariant: string | null }) {
  const version = useCanvas((s) => s.version);
  const single = nodes.length === 1 ? nodes[0]! : null;

  const current = useMemo(() => {
    if (!single) return '';
    const styles = activeVariant
      ? (single.variants.find((v) => v.selector === activeVariant)?.styles ?? {})
      : single.styles;
    return Object.entries(styles).map(([k, v]) => `${k}: ${v};`).join('\n');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [single, activeVariant, version]);

  if (!single) {
    return (
      <Section title="CSS" defaultOpen={false}>
        <p className="panel-empty dim">Select a single layer to edit its CSS directly.</p>
      </Section>
    );
  }

  return (
    <Section title="CSS" defaultOpen={false}>
      <textarea
        className="css-editor"
        key={`${single.id}-${activeVariant}-${version}`}
        defaultValue={current}
        spellCheck={false}
        onBlur={(e) => {
          const next = parseDeclarationsLocal(e.target.value);
          const prev = activeVariant
            ? (single.variants.find((v) => v.selector === activeVariant)?.styles ?? {})
            : single.styles;
          // Send removals explicitly, otherwise deleting a line would do nothing.
          const styles: StyleMap = { ...next };
          for (const key of Object.keys(prev)) if (!(key in next)) styles[key] = '';
          useCanvas.getState().setNodeStyles(keys, styles, activeVariant ?? undefined);
        }}
        onKeyDown={(e) => e.stopPropagation()}
      />
      <p className="panel-hint">Edits apply on blur. Deleting a line removes the declaration.</p>
    </Section>
  );
}

function parseDeclarationsLocal(css: string): StyleMap {
  const out: StyleMap = {};
  for (const line of css.split(/[;\n]/)) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const prop = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (prop && value) out[prop] = value;
  }
  return out;
}

const TAG_OPTIONS = [
  'div', 'section', 'main', 'header', 'footer', 'nav', 'aside', 'article',
  'p', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'a', 'button', 'ul', 'ol', 'li', 'label', 'strong', 'em', 'code', 'blockquote', 'img',
].map((v) => ({ value: v, label: v }));
