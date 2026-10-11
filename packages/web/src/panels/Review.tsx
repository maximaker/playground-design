/**
 * Design review.
 *
 * Shows what the checks found, grouped by rule. Clicking a finding selects the
 * layer it is about, because a list of problems you cannot navigate to is a
 * list nobody reads.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { type Finding, type HealthFacts, type RuleId, RULES, lintDocument, summarise } from '@playground/shared';
import { useCanvas, getDoc, currentPage } from '../state/store.ts';
import { Icon, type IconName } from '../ui/Icon.tsx';

const SEVERITY_ICON: Record<Finding['severity'], IconName> = {
  error: 'warning',
  warning: 'warning',
  info: 'info',
};

export function Review() {
  const structureVersion = useCanvas((s) => s.structureVersion);
  const styleEpoch = useCanvas((s) => s.styleEpoch);
  const selection = useCanvas((s) => s.selection);
  const select = useCanvas((s) => s.select);
  const doc = getDoc();

  const [scope, setScope] = useState<'page' | 'selection'>('page');
  const [expanded, setExpanded] = useState<RuleId | null>(null);

  const within = scope === 'selection' ? selection[0]?.split('::')[0] : undefined;
  const setPage = useCanvas((s) => s.setPage);

  // Fonts, clipping and selector coverage come from the server, which can ask
  // Google Fonts and render each frame headlessly. Fetched when the tab opens
  // and on demand; the other checks stay live as you edit.
  const [facts, setFacts] = useState<HealthFacts | undefined>();
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const docId = doc?.id;
  const runFullCheck = useCallback(() => {
    if (!docId) return;
    setChecking(true);
    fetch(`/api/documents/${docId}/health`)
      .then((r) => (r.ok ? r.json() : null))
      .then((f: HealthFacts | null) => { if (f) { setFacts(f); setCheckedAt(new Date()); } })
      .catch(() => {})
      .finally(() => setChecking(false));
  }, [docId]);
  useEffect(() => { runFullCheck(); }, [runFullCheck]);

  const findings = useMemo(
    () => (doc ? lintDocument(doc, { within, facts }) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, within, facts, structureVersion, styleEpoch],
  );

  const groups = useMemo(() => {
    const byRule = new Map<RuleId, Finding[]>();
    for (const f of findings) {
      const list = byRule.get(f.rule) ?? [];
      list.push(f);
      byRule.set(f.rule, list);
    }
    return [...byRule.entries()];
  }, [findings]);

  // While this panel is open the canvas outlines what the findings are about.
  // A list of forty contrast problems that you have to click one at a time to
  // locate is a list; pointing at them is a review.
  const setHighlight = useCanvas((s) => s.setHighlight);
  useEffect(() => {
    setHighlight({
      kind: 'review',
      ids: [...new Set(findings
        .filter((f) => f.severity === 'error' || f.severity === 'warning')
        .map((f) => f.nodeId))],
    });
    return () => setHighlight(null);
  }, [findings, setHighlight]);

  const counts = summarise(findings);
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.filter((f) => f.severity === 'warning').length;

  if (!doc) return null;

  return (
    <div className="review">
      {/*
        * What this panel is, said once at the top.
        *
        * "Review" on a tab could mean approvals, or a design critique, or
        * someone else's comments. It is none of those: it is a set of checks
        * run against the rendered page, and knowing that is the difference
        * between using it and ignoring it.
        */}
      <p className="review-about">
        Automatic checks against the rendered design — text contrast in every
        theme, fonts that will not load, clipped content, selectors that missed,
        empty frames, tap-target size, spacing off the token scale, and layers
        that repeat. Nothing here is
        an opinion about the design; each finding is a measurement with a
        threshold. While this panel is open the canvas outlines what it found.
      </p>

      <div className="review-scope">
        <button className={scope === 'page' ? 'is-active' : ''} onClick={() => setScope('page')}>
          Whole page
        </button>
        <button
          className={scope === 'selection' ? 'is-active' : ''}
          onClick={() => setScope('selection')}
          disabled={!selection.length}
          title={selection.length ? undefined : 'Select something first'}
        >Selection</button>
      </div>

      <div className="review-health">
        <button onClick={runFullCheck} disabled={checking}>
          {checking ? 'Checking fonts and clipping…' : 'Re-run full check'}
        </button>
        <span className="dim">
          {checkedAt
            ? `Fonts and clipping checked ${checkedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
            : checking ? '' : 'Fonts and clipping not checked'}
        </span>
      </div>

      {findings.length === 0 ? (
        <p className="panel-empty">
          <Icon name="check" size={15} /> Nothing to fix{scope === 'selection' ? ' here' : ' on this page'}.
          <br />
          <span className="dim">
            Checks contrast, tap targets, alt text, token consistency, layout shape and repetition.
          </span>
        </p>
      ) : (
        <>
          <p className="review-summary">
            {errors > 0 && <strong>{errors} to fix</strong>}
            {errors > 0 && warnings > 0 && ' · '}
            {warnings > 0 && <span>{warnings} worth a look</span>}
            {errors === 0 && warnings === 0 && <span>{findings.length} suggestions</span>}
          </p>

          {groups.map(([rule, items]) => {
            const info = RULES.find((r) => r.id === rule);
            const open = expanded === rule;
            const worst = counts.find((c) => c.rule === rule)?.severity ?? 'info';
            return (
              <div key={rule} className={`review-group sev-${worst}`}>
                <button className="review-group-head" onClick={() => setExpanded(open ? null : rule)}>
                  <Icon name={open ? 'chevronDown' : 'chevronRight'} size={10} />
                  <Icon name={SEVERITY_ICON[worst]} size={13} className={`sev-icon sev-${worst}`} />
                  <span className="review-rule">{info?.title ?? rule}</span>
                  <span className="dim">{items.length}</span>
                </button>

                {open && (
                  <div className="review-items">
                    {info && <p className="review-why">{info.why}</p>}
                    {items.slice(0, 40).map((f, i) => (
                      <button
                        key={`${f.nodeId}-${i}`}
                        className={`review-item${selection.includes(f.nodeId) ? ' is-selected' : ''}`}
                        title="Go there"
                        onClick={() => {
                          // The finding may be on another page: switch first, then select.
                          const onPage = doc.pages.find((p) => f.artboard && p.artboards.includes(f.artboard));
                          if (onPage && onPage.id !== currentPage()?.id) setPage(onPage.id);
                          select([f.nodeId]);
                          // Bring it on screen — a finding you cannot see is not actionable.
                          requestAnimationFrame(() => void import('../hooks/commands.ts').then((m) => m.zoomToSelection()));
                        }}
                      >
                        <span className="review-node">{doc.nodes[f.nodeId]?.name ?? f.nodeId}</span>
                        <span className="review-message">{f.message}</span>
                        {f.fix && <span className="review-fix">{f.fix}</span>}
                      </button>
                    ))}
                    {items.length > 40 && <p className="panel-hint">… {items.length - 40} more</p>}
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}

      <p className="panel-hint">
        Agents can run the same checks with <code>lint_design</code> before handing work back.
      </p>
    </div>
  );
}
