/**
 * The properties panel.
 *
 * Reads and writes CSS on the selected nodes. Multi-selection shows a value
 * only when every selected node agrees, and writing applies to all of them —
 * anything else silently loses edits.
 */

import { useMemo } from 'react';
import {
  type Breakpoint, type CanvasNode, type ComponentDef, type NodeId, type StyleMap,
  breakpointSelector, breakpointsOf, maxWidthOf, resolvedProps,
  codeComponentOf,
} from '@playground/shared';
import { useCanvas, getDoc } from '../state/store.ts';
import { attrOps, resolveKey, resetOverrideOps } from '../state/keys.ts';
import { Field, NumberInput, Row, Section, SegmentedControl, Select, TextInput, ColorInput } from '../ui/controls.tsx';
import { ArrangeBar } from '../ui/ArrangeBar.tsx';
import { GradientEditor } from '../ui/GradientEditor.tsx';
import { Icon } from '../ui/Icon.tsx';
import { AlignExtras, AlignPad } from '../ui/AlignPad.tsx';

const MIXED = '—'; // em dash: "these nodes disagree"

export function Properties() {
  // Narrow: the panel shows the selection, so it only needs those nodes'
  // versions plus structure — not a counter that ticks on every document edit.
  const selection = useCanvas((s) => s.selection);
  const structureVersion = useCanvas((s) => s.structureVersion);
  const version = useCanvas(
    (s) => s.selection.reduce((sum, key) => sum + (s.nodeVersions[key.split('::')[0]!] ?? 0), 0) + s.structureVersion,
  );
  void structureVersion;
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
  const readOnly = useCanvas((s) => s.readOnly);

  // A single selected instance gets its variant switcher.
  const instanceNode = resolved.length === 1 ? doc?.nodes[resolved[0]!.targetId] : undefined;
  const instanceDef = instanceNode?.type === 'instance'
    ? doc?.components?.[instanceNode.componentRef ?? '']
    : undefined;

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
          <span className="dim">
            {readOnly
              // Telling a viewer to press F would be an invitation to a refusal.
              ? 'You have a view-only link: everything here is readable, nothing is editable.'
              : <>Or press <kbd>F</kbd> to draw a frame, <kbd>T</kbd> for text.</>}
          </span>
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

  const write = (styles: StyleMap, opts?: { coalesce?: string }) => {
    // Routed through the key layer so an edit inside a component instance
    // becomes an override rather than a change to every instance at once.
    useCanvas.getState().setNodeStyles(selection, styles, activeVariant ?? undefined, opts);
  };

  const set = (prop: string) => (value: string, opts?: { coalesce?: string }) =>
    write({ [prop]: value === MIXED ? '' : value }, opts);

  const first = nodes[0]!;
  const allText = nodes.every((n) => n.type === 'text');
  const anyContainer = nodes.some((n) => n.type === 'frame' || n.type === 'artboard');
  const display = read('display');
  const isFlex = display.includes('flex');
  const isRow = (read('flex-direction') || 'row').startsWith('row');
  const parent = first.parent ? doc?.nodes[first.parent] : undefined;
  const parentIsFlex = (parent?.styles.display ?? '').includes('flex');

  // Base merged with the variant being edited: a variant that only overrides
  // alignment still needs the base's direction to know which CSS property that
  // alignment lands on.
  const alignStyles = {
    ...first.styles,
    ...(activeVariant ? first.variants.find((v) => v.selector === activeVariant)?.styles ?? {} : {}),
  };

  // Which of the four layout pictures is currently true. `row` is flexbox's
  // default direction, so a flex container with none set is still a row.
  const layoutChoice = display === 'grid' ? 'grid'
    : isFlex ? (isRow ? 'row' : 'column')
    : 'none';

  const knownVariants = [...new Set(nodes.flatMap((n) => n.variants.map((v) => v.selector)))];
  const breakpoints = doc ? breakpointsOf(doc) : [];

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

      {/*
        * Always present, not only for a multi-selection. Alignment is one of
        * the two things people reach for constantly, and a control that
        * appears and disappears cannot be reached for — you have to find it
        * first. With one layer selected it aligns inside its container, which
        * is what "align this left" means when there is only one thing.
        */}
      <ArrangeBar ids={nodes.map((n) => n.id)} />

      {nodes.length === 1 && first.type === 'code' && <CodeProps node={first} />}

      {instanceNode && instanceDef && <InstanceProps instanceId={resolved[0]!.targetId} def={instanceDef} node={instanceNode} />}

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
        {/* The document's breakpoints, not ad-hoc numbers: an override authored
            here uses the same width the rest of the design responds at. */}
        {breakpoints.map((bp) => {
          const selector = breakpointSelector(bp);
          const has = knownVariants.includes(selector);
          return (
            <button
              key={bp.id}
              className={activeVariant === selector ? 'is-active' : ''}
              data-has={has ? 'yes' : 'no'}
              title={`${bp.name} — ${bp.maxWidth}px and below${has ? ' (has overrides)' : ''}`}
              onClick={() => setActiveVariant(activeVariant === selector ? null : selector)}
            >{bp.name}</button>
          );
        })}

        {/* Any breakpoint width that is not in the document's list. */}
        {knownVariants
          .filter((v) => v.startsWith('@') && !breakpoints.some((bp) => breakpointSelector(bp) === v))
          .map((v) => (
            <button
              key={v}
              className={activeVariant === v ? 'is-active' : ''}
              data-has="yes"
              title={`${v} — not one of this document's breakpoints`}
              onClick={() => setActiveVariant(activeVariant === v ? null : v)}
            >{maxWidthOf(v) ? `${maxWidthOf(v)}px` : v.replace('@media', '').trim()}</button>
          ))}
      </div>

      {activeVariant && (
        <p className="variant-note">
          {activeVariant.startsWith('@') ? (
            <>
              Editing <strong>{labelForSelector(activeVariant, breakpoints)}</strong>. Only properties
              you change here are overridden — set the artboard to this width to see it.
            </>
          ) : (
            <>Editing <code>{activeVariant}</code>. Only properties you change here are overridden.</>
          )}
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
          {/*
            * How the container lays out, as four pictures rather than a list of
            * CSS keywords. "Stack" and "Row" are one property in CSS — display
            * plus flex-direction — and splitting them across two dropdowns is
            * the thing that makes flexbox feel like a puzzle rather than a
            * choice. The dropdown is still here for the rarer values.
            */}
          <Row>
            <Field label="Layout" prop="display / flex-direction" wide>
              <SegmentedControl
                value={layoutChoice}
                options={[
                  { value: 'none', label: <Icon name="layoutNone" size={15} />, title: 'No layout — children position themselves (display: block)' },
                  { value: 'column', label: <Icon name="layoutColumn" size={15} />, title: 'Stack — children flow downwards' },
                  { value: 'row', label: <Icon name="layoutRow" size={15} />, title: 'Row — children flow across' },
                  { value: 'grid', label: <Icon name="layoutGrid" size={15} />, title: 'Grid' },
                ]}
                onCommit={(v) => write(
                  v === 'none' ? { display: 'block', 'flex-direction': '' }
                    : v === 'grid' ? { display: 'grid', 'flex-direction': '' }
                    : { display: 'flex', 'flex-direction': v },
                )}
              />
            </Field>
          </Row>
          {(isFlex || display === 'grid') && nodes.length === 1 && (
            <div className="layout-grid">
              <Field label="Align contents" prop="justify-content / align-items" wide>
                <AlignPad styles={alignStyles} onChange={(styles) => write(styles)} />
              </Field>
              <div className="layout-spacing">
                <Field label="Gap" prop="gap" wide>
                  <NumberInput value={read('gap')} onCommit={set('gap')} min={0} />
                </Field>
                <Field label="Padding" prop="padding" wide>
                  <TextInput value={read('padding')} placeholder="16px or 8px 16px" onCommit={set('padding')} mono />
                </Field>
                {isFlex && (
                  <Field label="Wrap" prop="flex-wrap" wide>
                    <SegmentedControl
                      value={read('flex-wrap') || 'nowrap'}
                      options={[{ value: 'nowrap', label: 'No wrap' }, { value: 'wrap', label: 'Wrap' }]}
                      onCommit={set('flex-wrap')}
                    />
                  </Field>
                )}
              </div>
              <AlignExtras styles={alignStyles} onChange={(styles) => write(styles)} />
            </div>
          )}

          {/*
            * The controls above write these. They stay reachable because the
            * premise of the tool is that you are editing CSS and should be able
            * to see which declaration a control produced — but folded away,
            * because two controls for one property at equal weight is how a
            * panel stops being readable.
            */}
          <details className="prop-advanced">
            <summary>CSS</summary>
            <Row>
              <Field label="Display" prop="display">
                <Select
                  value={display || 'block'}
                  options={['block', 'flex', 'inline-flex', 'grid', 'inline-block', 'none'].map((v) => ({ value: v, label: v }))}
                  onCommit={set('display')}
                />
              </Field>
              {isFlex && (
                <Field label="Direction" prop="flex-direction">
                  <SegmentedControl
                    value={read('flex-direction') || 'row'}
                    options={[
                      { value: 'row', label: <Icon name="arrowRight" size={13} />, title: 'row' },
                      { value: 'column', label: <Icon name="arrowDown" size={13} />, title: 'column' },
                      { value: 'row-reverse', label: <Icon name="arrowLeft" size={13} />, title: 'row-reverse' },
                      { value: 'column-reverse', label: <Icon name="arrowUp" size={13} />, title: 'column-reverse' },
                    ]}
                    onCommit={set('flex-direction')}
                  />
                </Field>
              )}
            </Row>
            {isFlex && (
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
            )}
          </details>

          {display === 'grid' && (
            <Row>
              <Field label="Columns" prop="grid-template-columns" wide>
                <TextInput value={read('grid-template-columns')} placeholder="repeat(3, 1fr)" onCommit={set('grid-template-columns')} mono />
              </Field>
            </Row>
          )}

          {/* Padding sits beside the pad for a flex or grid container; for
              anything else this is the only place it appears. */}
          {!((isFlex || display === 'grid') && nodes.length === 1) && (
            <Row>
              <Field label="Padding" prop="padding" wide>
                <TextInput value={read('padding')} placeholder="16px or 8px 16px" onCommit={set('padding')} mono />
              </Field>
            </Row>
          )}
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
                  { value: 'left', label: <Icon name="textLeft" size={13} />, title: 'Left' },
                  { value: 'center', label: <Icon name="textCenter" size={13} />, title: 'Centre' },
                  { value: 'right', label: <Icon name="textRight" size={13} />, title: 'Right' },
                  { value: 'justify', label: <Icon name="textJustify" size={13} />, title: 'Justify' },
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
              <NumberInput value={read('-webkit-line-clamp')} onCommit={(v, o) => write({
                '-webkit-line-clamp': v,
                display: v ? '-webkit-box' : '',
                '-webkit-box-orient': v ? 'vertical' : '',
                overflow: v ? 'hidden' : '',
              }, o)} suffix="" />
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
            <GradientEditor
              value={read('background-image') === MIXED ? '' : read('background-image')}
              onCommit={set('background-image')}
              tokens={tokens}
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
            <NumberInput value={read('border-width')} onCommit={(v, o) => write({ 'border-width': v, 'border-style': v ? (read('border-style') || 'solid') : '' }, o)} />
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
              onCommit={(v, o) => write({ filter: v ? `blur(${v})` : '' }, o)}
            />
          </Field>
          <Field label="Backdrop" prop="backdrop-filter">
            <NumberInput
              value={extractBlur(read('backdrop-filter'))}
              onCommit={(v, o) => write({ 'backdrop-filter': v ? `blur(${v})` : '' }, o)}
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

/**
 * Controls for a placed code component.
 *
 * The prop list comes from what the component declares, so this panel is only
 * as good as the registration — which is the right pressure to apply: a
 * component that declares its props honestly is one a designer can actually use.
 */
function CodeProps({ node }: { node: CanvasNode }) {
  const dispatch = useCanvas((s) => s.dispatch);
  const doc = useCanvas((s) => s.doc);
  const component = doc ? codeComponentOf(doc, node) : undefined;

  if (!component) {
    return (
      <div className="instance-props">
        <p className="panel-hint">
          This component is no longer registered. Ask the agent to register it again, or delete the layer.
        </p>
      </div>
    );
  }

  const set = (name: string) => (value: string) =>
    dispatch([{ t: 'props', updates: [{ id: node.id, props: { [name]: value } }] }]);
  const value = (name: string) => node.props?.[name] ?? component.props.find((p) => p.name === name)?.default ?? '';

  return (
    <div className="instance-props">
      <span className="field-label">{component.name}</span>
      <p className="panel-hint code-source">{component.sourcePath ?? component.importPath}</p>

      {component.props.length === 0 && (
        <p className="panel-hint">This component was registered without any props.</p>
      )}

      {component.props.map((prop) => (
        <Row key={prop.name}>
          <Field label={prop.name} prop={prop.description ?? `prop "${prop.name}"`} wide>
            {prop.type === 'boolean' ? (
              <SegmentedControl
                value={value(prop.name) === 'true' ? 'true' : 'false'}
                options={[{ value: 'false', label: 'Off' }, { value: 'true', label: 'On' }]}
                onCommit={set(prop.name)}
              />
            ) : prop.type === 'enum' && prop.values?.length ? (
              prop.values.length <= 4 ? (
                <SegmentedControl
                  value={value(prop.name)}
                  options={prop.values.map((v) => ({ value: v, label: v }))}
                  onCommit={set(prop.name)}
                />
              ) : (
                <Select
                  value={value(prop.name)}
                  options={prop.values.map((v) => ({ value: v, label: v }))}
                  onCommit={set(prop.name)}
                />
              )
            ) : (
              <TextInput value={value(prop.name)} placeholder={prop.default ?? ''} onCommit={set(prop.name)} />
            )}
          </Field>
        </Row>
      ))}

      <Row>
        <Field label="Interactive" prop="whether clicks reach the component instead of selecting it" wide>
          <SegmentedControl
            value={node.attrs['data-interactive'] === 'true' ? 'true' : 'false'}
            options={[{ value: 'false', label: 'Select' }, { value: 'true', label: 'Click through' }]}
            onCommit={(v) => dispatch([{ t: 'attrs', updates: [{ id: node.id, attrs: { 'data-interactive': v === 'true' ? 'true' : null } }] }])}
          />
        </Field>
      </Row>
    </div>
  );
}

/**
 * Variant switcher for a selected instance.
 *
 * Shown above everything else because it is the highest-level thing about an
 * instance: which variant it is determines most of what the other panels show.
 */
function InstanceProps({ instanceId, def, node }: {
  instanceId: string;
  def: ComponentDef;
  node: CanvasNode;
}) {
  const dispatch = useCanvas((s) => s.dispatch);
  const props = resolvedProps(def, node);

  if (!def.props?.length) {
    return (
      <div className="instance-props">
        <span className="field-label">{def.name}</span>
        <p className="panel-hint">
          This component has no variant properties. Add them in the Components panel to vary it by
          size, tone, state and so on.
        </p>
      </div>
    );
  }

  return (
    <div className="instance-props">
      <span className="field-label">{def.name}</span>
      {def.props.map((prop) => (
        <Row key={prop.name}>
          <Field label={prop.name} prop={`variant property "${prop.name}"`} wide>
            {prop.values.length <= 4 ? (
              <SegmentedControl
                value={props[prop.name] ?? prop.default}
                options={prop.values.map((v) => ({ value: v, label: v }))}
                onCommit={(v) => dispatch([{ t: 'props', updates: [{ id: instanceId, props: { [prop.name]: v } }] }])}
              />
            ) : (
              <Select
                value={props[prop.name] ?? prop.default}
                options={prop.values.map((v) => ({ value: v, label: v }))}
                onCommit={(v) => dispatch([{ t: 'props', updates: [{ id: instanceId, props: { [prop.name]: v } }] }])}
              />
            )}
          </Field>
        </Row>
      ))}
    </div>
  );
}

function labelForSelector(selector: string, breakpoints: Breakpoint[]): string {
  const width = maxWidthOf(selector);
  const bp = breakpoints.find((b) => b.maxWidth === width);
  return bp ? `${bp.name} (${bp.maxWidth}px and below)` : `${width}px and below`;
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
