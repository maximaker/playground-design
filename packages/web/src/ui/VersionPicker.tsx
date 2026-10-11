/**
 * Current / superseded, for a page or a section.
 *
 * A small select rather than a menu: three states, always visible, one click.
 * Superseding asks why, and links to the single current item when there is
 * one — the "replaced by" a developer follows from an old screen.
 */

import { type CanvasDocument, type VersionKind, type VersionState, findVersionTarget, targetTitle, versionOps } from '@playground/shared';
import { useCanvas } from '../state/store.ts';

export function VersionBadge({ doc, version }: { doc: CanvasDocument; version: VersionState | null | undefined }) {
  if (!version) return null;
  if (version.state === 'current') return <span className="version-badge is-current">Current</span>;
  const to = version.replacedBy ? findVersionTarget(doc, version.replacedBy) : null;
  const tip = [version.reason, to && `Replaced by ${targetTitle(to)}`].filter(Boolean).join(' · ') || 'Superseded';
  return <span className="version-badge is-superseded" title={tip}>Superseded</span>;
}

export function VersionPicker({ doc, id, version }: { doc: CanvasDocument; id: string; version: VersionState | null | undefined }) {
  const dispatch = useCanvas((s) => s.dispatch);
  const set = (state: VersionKind | null) => {
    const target = findVersionTarget(doc, id);
    if (!target) return;
    let reason: string | undefined;
    if (state === 'superseded') {
      const answer = window.prompt('Why was it superseded? (optional)', version?.reason ?? '');
      if (answer === null) return;
      reason = answer;
    }
    try {
      dispatch(versionOps(doc, target, { state, reason }));
    } catch (err) {
      window.alert((err as Error).message);
    }
  };
  return (
    <select
      className={`version-picker${version ? ` is-${version.state}` : ''}`}
      value={version?.state ?? ''}
      onChange={(e) => set((e.target.value || null) as VersionKind | null)}
      onClick={(e) => e.stopPropagation()}
      aria-label="Version"
      title="Version: current or superseded"
    >
      <option value="">No version</option>
      <option value="current">Current</option>
      <option value="superseded">Superseded</option>
    </select>
  );
}
