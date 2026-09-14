/**
 * Token interchange with a codebase, from the editor.
 *
 * The agent has the better path — it can read the repo directly — but someone
 * working without one still needs to get their variables in and out, and
 * copy-paste is the honest answer for a browser that cannot see a filesystem.
 */

import { useState } from 'react';
import {
  type TokenFormat, diffTokens, mergeTokens, parseTokensFromCss, serializeTokens,
} from '@playground/shared';
import { useCanvas, getDoc } from '../state/store.ts';
import { Icon } from '../ui/Icon.tsx';

const FORMATS: { value: TokenFormat; label: string }[] = [
  { value: 'css', label: 'CSS' },
  { value: 'tailwind', label: 'Tailwind' },
  { value: 'json', label: 'JSON' },
];

export function TokenSync() {
  const dispatch = useCanvas((s) => s.dispatch);
  const toast = useCanvas((s) => s.toast);
  const structureVersion = useCanvas((s) => s.structureVersion);
  const doc = getDoc();

  const [open, setOpen] = useState<'export' | 'import' | null>(null);
  const [format, setFormat] = useState<TokenFormat>('css');
  const [incoming, setIncoming] = useState('');
  const [preview, setPreview] = useState<ReturnType<typeof diffTokens> | null>(null);

  if (!doc) return null;
  void structureVersion;

  const analyse = (css: string) => {
    setIncoming(css);
    if (!css.trim()) { setPreview(null); return; }
    const parsed = parseTokensFromCss(css, doc.tokens.map((t) => t.name));
    setPreview(parsed.tokens.length ? diffTokens(doc.tokens, parsed.tokens) : null);
  };

  const apply = () => {
    const parsed = parseTokensFromCss(incoming, doc.tokens.map((t) => t.name));
    if (!parsed.tokens.length) { toast('No custom properties found in that CSS.', 'error'); return; }
    dispatch([{ t: 'tokens', tokens: mergeTokens(doc.tokens, parsed.tokens) }]);
    toast(`Merged ${parsed.tokens.length} tokens from code`, 'success');
    setOpen(null);
    setIncoming('');
    setPreview(null);
  };

  return (
    <div className="token-sync">
      <div className="token-sync-actions">
        <button className="button subtle" onClick={() => setOpen(open === 'export' ? null : 'export')}>
          <Icon name="upload" size={13} /> To code
        </button>
        <button className="button subtle" onClick={() => setOpen(open === 'import' ? null : 'import')}>
          <Icon name="download" size={13} /> From code
        </button>
      </div>

      {open === 'export' && (
        <div className="token-sync-body">
          <div className="client-tabs">
            {FORMATS.map((f) => (
              <button key={f.value} className={format === f.value ? 'is-active' : ''} onClick={() => setFormat(f.value)}>
                {f.label}
              </button>
            ))}
          </div>
          <pre className="token-sync-code">{serializeTokens(doc, format)}</pre>
          <button
            className="button primary full"
            onClick={async () => {
              await navigator.clipboard.writeText(serializeTokens(doc, format));
              toast('Copied — paste it into the project', 'success');
            }}
          >Copy</button>
          {format === 'tailwind' && (
            <p className="panel-hint">
              References the CSS variables rather than inlining values, so switching theme at runtime
              switches the utility classes too.
            </p>
          )}
        </div>
      )}

      {open === 'import' && (
        <div className="token-sync-body">
          <textarea
            className="css-editor"
            placeholder={':root {\n  --color-brand: #4f46e5;\n}'}
            value={incoming}
            onChange={(e) => analyse(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
          />

          {preview && (
            <div className="token-diff">
              {preview.changed.length > 0 && (
                <>
                  <h4>{preview.changed.length} changed</h4>
                  {preview.changed.slice(0, 8).map((c) => (
                    <div key={`${c.name}-${c.theme}`} className="token-diff-row">
                      <span className="token-name">{c.name}</span>
                      <span className="dim">{c.from}</span>
                      <Icon name="arrowRight" size={11} />
                      <span>{c.to}</span>
                    </div>
                  ))}
                </>
              )}
              {preview.added.length > 0 && <h4>{preview.added.length} new</h4>}
              {preview.unchanged > 0 && <p className="panel-hint">{preview.unchanged} already match.</p>}
              {preview.removed.length > 0 && (
                <p className="panel-hint">
                  {preview.removed.length} tokens are not in that CSS and will be kept.
                </p>
              )}
            </div>
          )}

          <button className="button primary full" disabled={!preview} onClick={apply}>
            Merge into this document
          </button>
        </div>
      )}
    </div>
  );
}
