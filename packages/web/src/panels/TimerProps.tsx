/**
 * The countdown's own properties: duration, how it starts, its look, and what
 * happens at zero. Size, position and colour stay in the ordinary sections —
 * the face follows the text colour, so Fill → text colour recolours it.
 */

import {
  type CanvasNode, TIMER_ATTR, TIMER_CHIME_ATTR, TIMER_END_ATTR, TIMER_LABEL_ATTR, TIMER_START_ATTR,
  TIMER_STYLE_ATTR, clampSeconds, readTimer,
} from '@playground/shared';
import { useCanvas, getDoc } from '../state/store.ts';
import { attrOps } from '../state/keys.ts';
import { Field, NumberInput, Row, Section, SegmentedControl, TextInput } from '../ui/controls.tsx';

export function TimerProps({ node, nodeKey }: { node: CanvasNode; nodeKey: string }) {
  const dispatch = useCanvas((s) => s.dispatch);
  const spec = readTimer(node.attrs);
  const set = (attrs: Record<string, string>) => dispatch(attrOps(getDoc(), nodeKey, attrs));
  const minutes = Math.floor(spec.seconds / 60);
  const seconds = spec.seconds % 60;
  const setDuration = (m: number, s: number) => set({ [TIMER_ATTR]: String(clampSeconds(m * 60 + s)) });

  return (
    <Section title="Timer">
      <Row>
        <Field label="Minutes">
          <NumberInput value={String(minutes)} min={0} max={99} suffix="" onCommit={(v) => setDuration(parseInt(v, 10) || 0, seconds)} />
        </Field>
        <Field label="Seconds">
          <NumberInput value={String(seconds)} min={0} max={59} suffix="" onCommit={(v) => setDuration(minutes, parseInt(v, 10) || 0)} />
        </Field>
      </Row>
      <Row>
        <Field label="Starts" wide>
          <SegmentedControl
            value={spec.start}
            options={[
              { value: 'slide', label: 'With the slide', title: 'Starts when the slide is shown in Present' },
              { value: 'click', label: 'On click', title: 'Starts on a click or T in Present' },
            ]}
            onCommit={(v) => set({ [TIMER_START_ATTR]: v })}
          />
        </Field>
      </Row>
      <Row>
        <Field label="Look" wide>
          <SegmentedControl
            value={spec.variant}
            options={[{ value: 'ring', label: 'Ring' }, { value: 'pill', label: 'Pill' }, { value: 'bar', label: 'Bar' }]}
            onCommit={(v) => set({ [TIMER_STYLE_ATTR]: v })}
          />
        </Field>
      </Row>
      <Row>
        <Field label="At zero" wide>
          <SegmentedControl
            value={spec.end}
            options={[{ value: 'message', label: 'Time’s up' }, { value: 'pulse', label: 'Pulse' }]}
            onCommit={(v) => set({ [TIMER_END_ATTR]: v })}
          />
        </Field>
      </Row>
      <Row>
        <Field label="Chime" wide>
          <SegmentedControl
            value={spec.chime ? 'true' : 'false'}
            options={[{ value: 'false', label: 'Off' }, { value: 'true', label: 'On' }]}
            onCommit={(v) => set({ [TIMER_CHIME_ATTR]: v })}
          />
        </Field>
      </Row>
      <Row>
        <Field label="Label" wide>
          <TextInput value={spec.label} placeholder="Optional, e.g. Discuss in pairs" maxLength={60} onCommit={(v) => set({ [TIMER_LABEL_ATTR]: v.trim() })} />
        </Field>
      </Row>
      <p className="panel-hint">Counts down in Present. Click it or press T to start and pause, R to reset.</p>
    </Section>
  );
}
