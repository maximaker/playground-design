/**
 * A live question's own property: how big its results draw on the slide.
 * "L" and "XL" are for a TV or projector across a room. The size is kept on
 * the embed and in its board URL, which is what the board reads.
 */

import { type CanvasNode, LIVE_WAITING_ATTR, LIVE_SIZE_ATTR, parseLiveSize, withLiveSize } from '@playground/shared';
import { useCanvas, getDoc } from '../state/store.ts';
import { attrOps } from '../state/keys.ts';
import { Field, Row, Section, SegmentedControl } from '../ui/controls.tsx';

export function LiveProps({ node, nodeKey }: { node: CanvasNode; nodeKey: string }) {
  const dispatch = useCanvas((s) => s.dispatch);
  const size = parseLiveSize(node.attrs[LIVE_SIZE_ATTR]);
  const setSize = (v: string) => {
    const next = parseLiveSize(v);
    const attrs: Record<string, string> = { [LIVE_SIZE_ATTR]: next };
    if (node.attrs.src) attrs.src = withLiveSize(node.attrs.src, next);
    dispatch(attrOps(getDoc(), nodeKey, attrs));
  };
  return (
    <Section title="Live results">
      <Row>
        <Field label="Size" wide>
          <SegmentedControl
            value={size}
            options={[
              { value: 's', label: 'S', title: 'Small' },
              { value: 'm', label: 'M', title: 'Medium (default)' },
              { value: 'l', label: 'L', title: 'Large: for a TV across a room' },
              { value: 'xl', label: 'XL', title: 'Extra large: for a big room' },
            ]}
            onCommit={setSize}
          />
        </Field>
      </Row>
      <Row>
        <Field label="While timed" wide>
          <SegmentedControl
            value={node.attrs[LIVE_WAITING_ATTR] === 'qr' ? 'qr' : 'question'}
            options={[
              { value: 'question', label: 'Question', title: 'While a timer withholds results: just the question (default)' },
              { value: 'qr', label: '+ QR', title: 'Also show the QR code and join address while results are withheld' },
            ]}
            onCommit={(v) => dispatch(attrOps(getDoc(), nodeKey, { [LIVE_WAITING_ATTR]: v }))}
          />
        </Field>
      </Row>
      <p className="panel-hint">L and XL make every answer, label and count bigger for a screen across the room.</p>
    </Section>
  );
}
