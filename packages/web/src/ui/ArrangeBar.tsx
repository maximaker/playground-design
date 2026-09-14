/**
 * Align and distribute controls for a multi-selection.
 *
 * These are disabled — with an explanation — rather than hidden when the
 * selection is laid out by flexbox, because silently doing nothing is the
 * confusing option. In flex flow the parent's alignment properties are the
 * right control, and the tooltip says so.
 */

import type { NodeId } from '@canvas/shared';
import { useCanvas, getDoc } from '../state/store.ts';
import { type AlignKind, type DistributeKind, align, distribute } from '../canvas/arrange.ts';

const ALIGNMENTS: { kind: AlignKind; icon: string; title: string }[] = [
  { kind: 'left', icon: '⇤', title: 'Align left' },
  { kind: 'center-x', icon: '⇹', title: 'Align horizontal centers' },
  { kind: 'right', icon: '⇥', title: 'Align right' },
  { kind: 'top', icon: '⇡', title: 'Align top' },
  { kind: 'center-y', icon: '⇕', title: 'Align vertical centers' },
  { kind: 'bottom', icon: '⇣', title: 'Align bottom' },
];

const DISTRIBUTIONS: { kind: DistributeKind; icon: string; title: string }[] = [
  { kind: 'horizontal', icon: '⇿', title: 'Distribute horizontally' },
  { kind: 'vertical', icon: '↕', title: 'Distribute vertically' },
];

export function ArrangeBar({ ids }: { ids: NodeId[] }) {
  const dispatch = useCanvas((s) => s.dispatch);
  const toast = useCanvas((s) => s.toast);
  const doc = getDoc();

  const positionable = ids.filter((id) => {
    const node = doc?.nodes[id];
    return node && (node.parent === null || node.styles.position === 'absolute' || node.styles.position === 'fixed');
  });
  const canAlign = positionable.length >= 2;
  const canDistribute = positionable.length >= 3;

  const run = (result: { ops: ReturnType<typeof align>['ops']; skipped: NodeId[] }, what: string) => {
    if (result.ops.length) dispatch(result.ops);
    if (result.skipped.length) {
      toast(
        `${result.skipped.length} layer${result.skipped.length === 1 ? '' : 's'} skipped: their parent's layout controls position. ` +
        `Set "In flow: No", or use the parent's alignment instead.`,
        'info',
      );
    } else if (!result.ops.length) {
      toast(`Nothing to ${what} — they are already aligned.`, 'info');
    }
  };

  const reason = canAlign
    ? undefined
    : 'Alignment applies to artboards and absolutely-positioned layers. These are laid out by their parent.';

  return (
    <div className="arrange-bar">
      {ALIGNMENTS.map((a) => (
        <button
          key={a.kind}
          title={reason ?? a.title}
          disabled={!canAlign}
          onClick={() => doc && run(align(doc, ids, a.kind), 'align')}
        >{a.icon}</button>
      ))}
      <span className="arrange-spacer" />
      {DISTRIBUTIONS.map((d) => (
        <button
          key={d.kind}
          title={canDistribute ? d.title : 'Distributing needs three or more independently positioned layers'}
          disabled={!canDistribute}
          onClick={() => doc && run(distribute(doc, ids, d.kind), 'distribute')}
        >{d.icon}</button>
      ))}
    </div>
  );
}
