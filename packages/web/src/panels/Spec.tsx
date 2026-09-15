/**
 * The handover panel.
 *
 * Other tools have a redlining mode: a person draws arrows and types the
 * padding next to them. That exists because in those tools the design is a
 * picture and the numbers are not readable any other way — and the moment
 * someone nudges a card, every one of those numbers is a lie nobody notices.
 *
 * Here the document is the CSS, so this panel derives the spec rather than
 * storing one: measured size from the live frame, colours and spacing resolved
 * back to the token names they came from, the rules that apply on hover and at
 * other widths, and the notes people attached for the things CSS cannot say.
 * Copy buttons on everything, because the developer's next move is to paste it.
 */

import { useMemo, useState } from 'react';
import {
  NOTE_KINDS, NOTE_KIND_HINTS, NOTE_KIND_LABELS, type NoteKind, type SpecValue,
  cssFor, emitHtml, emitJsx, makeComment, specFor,
} from '@playground/shared';
import { getDoc, useCanvas } from '../state/store.ts';
import { nodeInnerRect } from '../canvas/registry.ts';
import { openComponentOf } from '../hooks/commands.ts';
import { Icon } from '../ui/Icon.tsx';

export function Spec() {
  const selection = useCanvas((s) => s.selection);
  const version = useCanvas((s) => s.version);
  const dispatch = useCanvas((s) => s.dispatch);
  const toast = useCanvas((s) => s.toast);
  const readOnly = useCanvas((s) => s.readOnly);
  const doc = getDoc();

  const [kind, setKind] = useState<NoteKind>('behaviour');
  const [text, setText] = useState('');
  // CSS first: the most common thing to want is this layer's declarations.
  const [code, setCode] = useState<'css' | 'html' | 'jsx'>('css');
  const [adding, setAdding] = useState(false);

  const id = selection[0]?.split('::')[0];

  const spec = useMemo(() => {
    if (!doc || !id || !doc.nodes[id]) return null;
    // Measured from the frame the canvas is already rendering, so the size is
    // the real one — `width: fit-content` is not a width — and it costs nothing.
    const rect = nodeInnerRect(id);
    return specFor(doc, id, {
      box: rect ? { width: round(rect.width), height: round(rect.height) } : undefined,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, id, version, selection]);

  const copy = async (value: string, what: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast(`${what} copied`, 'info');
    } catch {
      toast('Could not reach the clipboard', 'error');
    }
  };

  if (!spec || !doc || !id) {
    return (
      <p className="panel-empty">
        Select a layer to see its spec.<br />
        <span className="dim">
          Sizes, spacing and colour as token names, what changes on hover and at other widths, and
          the notes attached to it — derived from the document, so it is never out of date.
        </span>
      </p>
    );
  }

  const codeFor = (kind: 'css' | 'html' | 'jsx'): string => {
    if (!doc || !id) return '';
    if (kind === 'css') return cssFor(doc, id);
    if (kind === 'html') return emitHtml(doc, id, { mode: 'inline' }).html;
    return emitJsx(doc, id, { format: 'tailwind' });
  };

  const addNote = () => {
    const body = text.trim();
    if (!body || !doc) return;
    const page = doc.pages.find((p) => p.id === useCanvas.getState().pageId) ?? doc.pages[0]!;
    const rect = nodeInnerRect(id);
    setAdding(false);
    dispatch([{
      t: 'comment',
      action: 'add',
      comment: makeComment({
        pageId: page.id,
        kind,
        nodeId: id,
        x: Math.round(rect?.left ?? 0),
        y: Math.round(rect?.top ?? 0),
        author: 'You',
        text: body,
      }),
    }]);
    setText('');
  };

  return (
    <div className="spec">
      <div className="prop-header">
        <div className="prop-title">
          {spec.name}
          <span className="prop-type">
            {spec.type}{spec.tag ? ` · ${spec.tag}` : ''}
            {spec.box ? ` · ${spec.box.width} × ${spec.box.height}` : ''}
          </span>
        </div>
        {spec.component && (
          spec.component.role === 'instance' ? (
            <button
              className="spec-chip is-button"
              title="Select the component this came from"
              onClick={() => openComponentOf(id)}
            >
              <Icon name="component" size={11} />
              Instance of {spec.component.name}
              <Icon name="chevronRight" size={10} />
            </button>
          ) : (
            <span className="spec-chip">
              <Icon name="component" size={11} />
              Definition of {spec.component.name}
            </span>
          )
        )}
      </div>

      <BoxModel spec={spec} />

      {spec.groups.map((group) => (
        <Section key={group.label} label={group.label} count={group.entries.length}>
          <dl>
            {group.entries.map((e) => (
              <div key={e.label} className="spec-row">
                <dt>{e.label}</dt>
                <dd>
                  {/* A colour is a colour before it is a string: the swatch is
                      the fastest way to know you are looking at the right one,
                      and the token name is still the thing to build with. */}
                  {swatchFor(e.value) && (
                    <span className="spec-swatch" style={{ background: swatchFor(e.value)! }} aria-hidden />
                  )}
                  {e.value.token ? (
                    <button
                      className="spec-token"
                      title={`Copy var(--${e.value.token.replace(/\./g, '-')})`}
                      onClick={() => copy(`var(--${e.value.token!.replace(/\./g, '-')})`, 'Token')}
                    >
                      {e.value.token}
                      <span className="dim"> {e.value.resolved}</span>
                    </button>
                  ) : (
                    <button className="spec-value" onClick={() => copy(e.value.value, e.label)}>
                      {e.value.value}
                    </button>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </Section>
      ))}

      {spec.variants.length > 0 && (
        <Section label="Changes" count={spec.variants.length}>
          {spec.variants.map((v) => (
            <div key={v.selector} className="spec-variant">
              <span className="spec-when">{v.when}</span>
              <dl>
                {v.changes.map((c) => (
                  <div key={c.label} className="spec-row">
                    <dt>{c.label}</dt>
                    <dd>{c.value.token ?? c.value.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </Section>
      )}

      <Section label="Notes" count={spec.notes.length || undefined}>
        {spec.notes.length === 0 && (
          <p className="dim spec-empty">
            For what the CSS cannot say — behaviour, data, constraints. The measurements above are
            derived and always current.
          </p>
        )}
        <ul className="spec-notes">
          {spec.notes.map((n) => (
            <li key={n.id} className={n.resolved ? 'is-resolved' : ''}>
              <span className={`note-kind note-${n.kind}`}>{NOTE_KIND_LABELS[n.kind as NoteKind] ?? n.kind}</span>
              <div>
                <p>{n.text}</p>
                <span className="dim">
                  {n.author}
                  {n.on ? ` · on ${n.on.name}` : ''}
                  {n.resolved ? ' · resolved' : ''}
                </span>
              </div>
            </li>
          ))}
        </ul>

        {!readOnly && !adding && (
          <button className="button subtle full" onClick={() => setAdding(true)}>+ Add a note</button>
        )}

        {!readOnly && adding && (
          <div className="spec-add">
            <select value={kind} onChange={(e) => setKind(e.target.value as NoteKind)} className="input">
              {NOTE_KINDS.filter((k) => k !== 'comment').map((k) => (
                <option key={k} value={k}>{NOTE_KIND_LABELS[k]}</option>
              ))}
            </select>
            <textarea
              className="input"
              rows={2}
              value={text}
              placeholder={NOTE_KIND_HINTS[kind]}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) addNote();
              }}
            />
            <div className="spec-add-actions">
              <button className="button subtle" onClick={() => { setAdding(false); setText(''); }}>
                Cancel
              </button>
              <button className="button primary" onClick={addNote} disabled={!text.trim()}>Add</button>
            </div>
          </div>
        )}
      </Section>

      <Section label="Code">
        {/*
          * Three languages, one at a time, CSS first: "just the CSS" is the
          * commonest thing to want and it was the one thing this could not give
          * you. The segmented control is the app's, not a new kind of tab.
          */}
        <div className="segmented spec-code-tabs">
          {(['css', 'html', 'jsx'] as const).map((k) => (
            <button
              key={k}
              className={code === k ? 'is-active' : ''}
              onClick={() => setCode(k)}
              aria-pressed={code === k}
            >{k.toUpperCase()}</button>
          ))}
        </div>
        <div className="spec-code-actions">
          <button className="button subtle" onClick={() => copy(codeFor(code), `${code.toUpperCase()}`)}>
            Copy {code.toUpperCase()}
          </button>
          <span className="dim">{codeFor(code).split('\n').length} lines</span>
        </div>
        <pre className="spec-code">{codeFor(code)}</pre>
      </Section>

      {spec.assets.length > 0 && (
        <Section label="Assets" count={spec.assets.length}>
          <ul className="spec-assets">
            {spec.assets.map((a) => (
              <li key={a}>
                <a href={`/assets/${a}`} target="_blank" rel="noreferrer">/assets/{a}</a>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

/**
 * A section of the spec, collapsible and styled like the Properties panel's.
 *
 * The first version used its own small uppercase headings and its own spacing,
 * which made the panel read as a different application sitting in the same
 * rail.
 */
function Section(
  { label, count, children }: { label: string; count?: number; children: React.ReactNode },
) {
  const [open, setOpen] = useState(true);
  return (
    <section className={`prop-section spec-section${open ? '' : ' is-closed'}`}>
      <header>
        <button onClick={() => setOpen(!open)} aria-expanded={open}>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={11} className="twisty" />
          {label}
          {count !== undefined && <span className="dim">{count}</span>}
        </button>
      </header>
      {open && <div className="prop-body">{children}</div>}
    </section>
  );
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** The colour a value paints, for the swatch. Null when it does not paint one. */
function swatchFor(value: SpecValue): string | null {
  const v = (value.resolved ?? value.value).trim();
  if (/^(#|rgb|hsl|oklch|color\()/i.test(v)) return v;
  if (/gradient\(/i.test(v)) return v;
  return null;
}

/**
 * The box, drawn.
 *
 * Padding as a ring around the content with the numbers on the sides, the way
 * every inspector shows it — because "padding: 12px 24px" is four numbers in an
 * order people misread, and a picture of it is not.
 */
function BoxModel({ spec }: { spec: ReturnType<typeof specFor> }) {
  const style = (prop: string) =>
    spec.groups.flatMap((g) => g.entries).find((e) => e.label === prop)?.value;
  const padding = style('padding')?.resolved ?? style('padding')?.value;
  const sides = expandSides(padding);
  const radius = style('border-radius')?.resolved ?? style('border-radius')?.value;
  if (!spec.box && !padding) return null;

  return (
    <div className="spec-box" aria-hidden>
      <div className="spec-box-outer">
        <span className="spec-box-side is-top">{sides.top}</span>
        <span className="spec-box-side is-right">{sides.right}</span>
        <span className="spec-box-side is-bottom">{sides.bottom}</span>
        <span className="spec-box-side is-left">{sides.left}</span>
        <div className="spec-box-inner" style={radius ? { borderRadius: clampRadius(radius) } : undefined}>
          {spec.box ? `${Math.round(spec.box.width)} × ${Math.round(spec.box.height)}` : 'content'}
        </div>
      </div>
    </div>
  );
}

/** `12px 24px` → the four sides, the way CSS means them. */
function expandSides(value: string | undefined): Record<'top' | 'right' | 'bottom' | 'left', string> {
  const parts = (value ?? '0').trim().split(/\s+/);
  const [a, b, c, d] = parts;
  if (parts.length === 1) return { top: a!, right: a!, bottom: a!, left: a! };
  if (parts.length === 2) return { top: a!, right: b!, bottom: a!, left: b! };
  if (parts.length === 3) return { top: a!, right: b!, bottom: c!, left: b! };
  return { top: a!, right: b!, bottom: c!, left: d! };
}

/** A 999px pill radius on a 40px diagram is a circle; the drawing is schematic. */
function clampRadius(value: string): string {
  const px = parseFloat(value);
  return Number.isFinite(px) ? `${Math.min(px, 10)}px` : '4px';
}
