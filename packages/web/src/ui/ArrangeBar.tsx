/**
 * Align and distribute controls for a multi-selection.
 *
 * Two different things wear the same word. For artboards and absolutely
 * positioned layers, aligning moves them. For children in flex or grid flow the
 * engine owns their position, and the honest translation of "align these left"
 * is "make their container align its contents left" — so that is what the bar
 * does, and it says so, rather than being disabled or quietly doing nothing.
 *
 * The one case left with no answer is a block container, which has no alignment
 * of its own; there the buttons are disabled and the tooltip explains why.
 */

import { type NodeId, alignmentForSelection, alignmentStyles, layoutMode } from '@playground/shared';
import { useCanvas, getDoc } from '../state/store.ts';
import { type AlignKind, type DistributeKind, align, distribute } from '../canvas/arrange.ts';
import { Icon, type IconName } from './Icon.tsx';

const ALIGNMENTS: { kind: AlignKind; icon: IconName; title: string }[] = [
  { kind: 'left', icon: 'alignLeft', title: 'Align left' },
  { kind: 'center-x', icon: 'alignCenterX', title: 'Align horizontal centres' },
  { kind: 'right', icon: 'alignRight', title: 'Align right' },
  { kind: 'top', icon: 'alignTop', title: 'Align top' },
  { kind: 'center-y', icon: 'alignCenterY', title: 'Align vertical centres' },
  { kind: 'bottom', icon: 'alignBottom', title: 'Align bottom' },
];

const DISTRIBUTIONS: { kind: DistributeKind; icon: IconName; title: string }[] = [
  { kind: 'horizontal', icon: 'distributeX', title: 'Distribute horizontally' },
  { kind: 'vertical', icon: 'distributeY', title: 'Distribute vertically' },
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

  // When everything selected shares one laid-out parent, aligning means
  // aligning that parent's contents. Requiring a single shared parent keeps the
  // meaning unambiguous: aligning siblings from two different containers would
  // silently change both.
  const parentIds = new Set(ids.map((id) => doc?.nodes[id]?.parent ?? null));
  const sharedParent = parentIds.size === 1 && !parentIds.has(null)
    ? doc?.nodes[[...parentIds][0] as NodeId]
    : undefined;
  const containerMode = sharedParent ? layoutMode(sharedParent.styles) : 'none';
  const viaContainer = !canAlign && !!sharedParent && containerMode !== 'none';

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

  const alignViaContainer = (kind: AlignKind) => {
    if (!sharedParent) return;
    const next = alignmentForSelection(sharedParent.styles, kind);
    if (!next) return;
    useCanvas.getState().setNodeStyles([sharedParent.id], alignmentStyles(sharedParent.styles, next));
    toast(`Aligned inside "${sharedParent.name}" — its layout positions these layers.`, 'info');
  };

  const reason = canAlign || viaContainer
    ? undefined
    : sharedParent
      ? `"${sharedParent.name}" is a block container, so it has no alignment of its own. ` +
        'Set its Display to Flex, or set these layers to Position: absolute.'
      : 'Alignment applies to artboards, absolutely-positioned layers, or siblings sharing one container.';

  return (
    <div className="arrange-bar">
      {ALIGNMENTS.map((a) => (
        <button
          key={a.kind}
          title={reason ?? (viaContainer ? `${a.title} inside "${sharedParent!.name}"` : a.title)}
          disabled={!canAlign && !viaContainer}
          aria-label={a.title}
          onClick={() => {
            if (viaContainer) return alignViaContainer(a.kind);
            if (doc) run(align(doc, ids, a.kind), 'align');
          }}
        ><Icon name={a.icon} size={14} /></button>
      ))}
      <span className="arrange-spacer" />
      {DISTRIBUTIONS.map((d) => (
        <button
          key={d.kind}
          title={
            canDistribute ? d.title
              : viaContainer ? `Spread them apart with "Align contents" on "${sharedParent!.name}"`
              : 'Distributing needs three or more independently positioned layers'
          }
          disabled={!canDistribute && !viaContainer}
          aria-label={d.title}
          onClick={() => {
            if (viaContainer) {
              // Distributing inside a container is `space-between`, not moving
              // each child — there is nothing else it could honestly mean.
              useCanvas.getState().setNodeStyles([sharedParent!.id], { 'justify-content': 'space-between' });
              toast(`Spread apart inside "${sharedParent!.name}".`, 'info');
              return;
            }
            if (doc) run(distribute(doc, ids, d.kind), 'distribute');
          }}
        ><Icon name={d.icon} size={14} /></button>
      ))}
    </div>
  );
}
