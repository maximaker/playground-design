/**
 * What the agent just changed.
 *
 * History already records that a change happened and who made it. The question
 * you actually have when an agent finishes is *which layers*, and the only
 * useful answer to that is on the canvas — a list of op names tells you
 * nothing about whether the result is right.
 *
 * So the changed layers are outlined where they are, and this bar walks you
 * through them one at a time. Taking the whole run back is one action, because
 * the alternative is pressing undo an unknown number of times and hoping.
 */

import { useEffect, useState } from 'react';
import { useCanvas } from '../state/store.ts';
import { nodeRect } from '../canvas/registry.ts';
import { Icon } from './Icon.tsx';

export function AgentChangeBar() {
  const change = useCanvas((s) => s.agentChange);
  const dismiss = useCanvas((s) => s.dismissAgentChange);
  const revert = useCanvas((s) => s.revertAgentChange);
  const select = useCanvas((s) => s.select);
  const setViewport = useCanvas((s) => s.setViewport);

  const [at, setAt] = useState(0);

  // A new run starts the walk over rather than leaving the index pointing at
  // whatever position the last one reached.
  useEffect(() => { setAt(0); }, [change?.at]);

  if (!change) return null;

  const ids = change.nodeIds;

  const focus = (index: number) => {
    const id = ids[index];
    if (!id) return;
    setAt(index);
    select([id]);
    // Centre it: an outlined layer off the side of the screen is not a review.
    const rect = nodeRect(id);
    if (!rect) return;
    const vp = useCanvas.getState().viewport;
    setViewport({
      x: vp.x + (window.innerWidth / 2 - (rect.left + rect.width / 2)),
      y: vp.y + (window.innerHeight / 2 - (rect.top + rect.height / 2)),
    });
  };

  const what = [
    ids.length ? `${ids.length} layer${ids.length === 1 ? '' : 's'}` : '',
    change.removed ? `${change.removed} deleted` : '',
  ].filter(Boolean).join(' · ');

  return (
    <div className="agent-change-bar" role="status">
      <span className="agent-change-dot" />
      <span className="agent-change-text">
        <strong>{change.agent}</strong> changed {what || `${change.ops} thing${change.ops === 1 ? '' : 's'}`}
      </span>

      {ids.length > 0 && (
        <span className="agent-change-step">
          <button
            className="icon-button"
            title="Previous change"
            aria-label="Previous change"
            disabled={ids.length < 2}
            onClick={() => focus((at - 1 + ids.length) % ids.length)}
          ><Icon name="chevronUp" size={13} /></button>
          <span className="dim">{Math.min(at + 1, ids.length)}/{ids.length}</span>
          <button
            className="icon-button"
            title="Next change"
            aria-label="Next change"
            onClick={() => focus((at + 1) % ids.length)}
          ><Icon name="chevronDown" size={13} /></button>
        </span>
      )}

      <button className="button subtle" onClick={revert} title="Put everything back the way it was">
        Undo all
      </button>
      <button className="icon-button" onClick={dismiss} title="Dismiss" aria-label="Dismiss">
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}
