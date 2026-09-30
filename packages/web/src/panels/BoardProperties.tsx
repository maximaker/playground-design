/**
 * The Design panel for a diagram item.
 *
 * Selecting a shape on the board used to leave the panel saying "Select
 * something on the canvas" — the thing was selected, and the panel denied it.
 * The style bar over the selection is still the quick way; this is the same
 * set of controls with room for text, position and size, where the eye goes
 * when the bar is not enough.
 */

import {
  type BoardItem, type Connector, type BoardShape,
  BOARD_COLORS, BOARD_COLOR_NAMES, boardOf, isConnector, isShape,
} from '@playground/shared';
import { useCanvas, getDoc, currentPage } from '../state/store.ts';
import { Field, NumberInput, Row, Section, SegmentedControl, TextInput } from '../ui/controls.tsx';
import { Icon } from '../ui/Icon.tsx';

const KIND_NAMES: Record<BoardShape['kind'], string> = {
  rect: 'Rectangle', ellipse: 'Ellipse', diamond: 'Diamond', text: 'Text', section: 'Section',
};

export function BoardProperties() {
  const ids = useCanvas((s) => s.boardSelection);
  const dispatch = useCanvas((s) => s.dispatch);
  const doc = getDoc();
  const page = currentPage();
  if (!doc || !page) return null;
  const items = boardOf(page).filter((i) => ids.includes(i.id));
  if (!items.length) return null;

  const change = (patch: (item: BoardItem) => Record<string, unknown> | null, coalesce?: string) => {
    const changes = items.flatMap((item) => {
      const p = patch(item);
      return p ? [{ action: 'update' as const, id: item.id, patch: p }] : [];
    });
    if (changes.length) dispatch([{ t: 'board', pageId: page.id, changes }], coalesce ? { coalesce } : undefined);
  };

  const single = items.length === 1 ? items[0]! : null;
  const shapes = items.filter(isShape);
  const connectors = items.filter(isConnector);
  const title = single
    ? (isShape(single) ? KIND_NAMES[single.kind] : 'Connector')
    : `${items.length} diagram items`;
  const all = <K extends keyof Connector>(key: K, value: Connector[K]) => connectors.every((c) => c[key] === value);

  return (
    <div className="properties">
      <div className="prop-header">
        <div className="prop-title">
          {title}
          <span className="prop-type">on the board · not part of any frame</span>
        </div>
      </div>

      <Section title="Content">
        {shapes.length > 0 && (
          <Field label={shapes.length === 1 && shapes[0]!.kind === 'section' ? 'Title' : 'Text'} wide>
            <TextInput
              value={shapes.length === 1 ? shapes[0]!.text : ''}
              placeholder={shapes.length === 1 ? 'Nothing yet' : 'Several selected'}
              onCommit={(text) => change((i) => (isShape(i) ? { text } : null))}
            />
          </Field>
        )}
        {connectors.length > 0 && (
          <Field label="Label" wide>
            <TextInput
              value={connectors.length === 1 ? connectors[0]!.label ?? '' : ''}
              placeholder={connectors.length === 1 ? '“yes”, “no”, or what happens' : 'Several selected'}
              onCommit={(label) => change((i) => (isConnector(i) ? { label: label || undefined } : null))}
            />
          </Field>
        )}
        <Field label="Colour" wide>
          <div className="board-swatches">
            {BOARD_COLOR_NAMES.map((name) => (
              <button
                key={name}
                className={`board-swatch${items.every((i) => i.color === name) ? ' is-active' : ''}`}
                style={{ background: BOARD_COLORS[name].fill, borderColor: BOARD_COLORS[name].accent }}
                aria-label={`Colour: ${name}`}
                title={name}
                onClick={() => change(() => ({ color: name }))}
              />
            ))}
          </div>
        </Field>
      </Section>

      {single && isShape(single) && (
        <Section title="Size & position">
          <Row>
            <Field label="X"><NumberInput value={`${single.x}px`} onCommit={(v, o) => change(() => ({ x: Math.round(parseFloat(v)) || 0 }), o?.coalesce)} /></Field>
            <Field label="Y"><NumberInput value={`${single.y}px`} onCommit={(v, o) => change(() => ({ y: Math.round(parseFloat(v)) || 0 }), o?.coalesce)} /></Field>
          </Row>
          <Row>
            <Field label="W"><NumberInput value={`${single.width}px`} min={16} onCommit={(v, o) => change(() => ({ width: Math.max(16, Math.round(parseFloat(v)) || 16) }), o?.coalesce)} /></Field>
            <Field label="H"><NumberInput value={`${single.height}px`} min={16} onCommit={(v, o) => change(() => ({ height: Math.max(16, Math.round(parseFloat(v)) || 16) }), o?.coalesce)} /></Field>
          </Row>
          {single.kind !== 'text' && single.kind !== 'section' && (
            <Field label="Shape" wide>
              <SegmentedControl
                value={single.kind}
                options={[
                  { value: 'rect', label: <Icon name="square" size={13} />, title: 'Rectangle' },
                  { value: 'ellipse', label: <Icon name="circle" size={13} />, title: 'Ellipse' },
                  { value: 'diamond', label: <Icon name="diamond" size={13} />, title: 'Diamond' },
                ]}
                onCommit={(kind) => change(() => ({ kind }))}
              />
            </Field>
          )}
        </Section>
      )}

      {connectors.length > 0 && (
        <Section title="Line">
          <Field label="Route" wide>
            <SegmentedControl
              value={all('route', 'elbow') ? 'elbow' : all('route', 'curved') ? 'curved' : all('route', 'straight') ? 'straight' : ''}
              options={[
                { value: 'elbow', label: <Icon name="lineElbow" size={13} />, title: 'Elbow' },
                { value: 'curved', label: <Icon name="lineCurved" size={13} />, title: 'Curved' },
                { value: 'straight', label: <Icon name="lineStraight" size={13} />, title: 'Straight' },
              ]}
              onCommit={(route) => change((i) => (isConnector(i) ? { route } : null))}
            />
          </Field>
          <Row>
            <Field label="Arrowheads">
              <SegmentedControl
                value={all('arrow', 'end') ? 'end' : all('arrow', 'both') ? 'both' : all('arrow', 'none') ? 'none' : ''}
                options={[
                  { value: 'end', label: <Icon name="arrowRight" size={13} />, title: 'At the end' },
                  { value: 'both', label: <Icon name="arrowBoth" size={13} />, title: 'Both ends' },
                  { value: 'none', label: <Icon name="arrowNone" size={13} />, title: 'None' },
                ]}
                onCommit={(arrow) => change((i) => (isConnector(i) ? { arrow } : null))}
              />
            </Field>
            <Field label="Style">
              <SegmentedControl
                value={all('dashed', true) ? 'dashed' : all('dashed', false) || connectors.every((c) => !c.dashed) ? 'solid' : ''}
                options={[
                  { value: 'solid', label: 'Solid' },
                  { value: 'dashed', label: 'Dashed' },
                ]}
                onCommit={(v) => change((i) => (isConnector(i) ? { dashed: v === 'dashed' } : null))}
              />
            </Field>
          </Row>
        </Section>
      )}

      <p className="panel-hint">
        Diagram items live between the frames: they never export with a design, and
        the review never flags them. <kbd>⌫</kbd> removes the selection.
      </p>
    </div>
  );
}
