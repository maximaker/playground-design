import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyDocument, makeNode, type CanvasDocument } from './model.ts';
import { applyOp } from './ops.ts';
import { parseHtml } from './html.ts';
import { lintDocument, RULES, summarise, type RuleId } from './lint.ts';

function docWith(html: string): { doc: CanvasDocument; artboard: string } {
  const doc = createEmptyDocument('Lint');
  const artboard = doc.pages[0]!.artboards[0]!;
  const parsed = parseHtml(html);
  applyOp(doc, { t: 'insert', nodes: parsed.nodes, parent: artboard, index: 0 });
  return { doc, artboard };
}

const rulesOf = (findings: { rule: RuleId }[]) => [...new Set(findings.map((f) => f.rule))].sort();
const only = (doc: CanvasDocument, rule: RuleId) => lintDocument(doc, { rules: [rule] });

test('flags text below the AA contrast threshold', () => {
  const { doc } = docWith(`<div style="background-color:#ffffff"><p style="color:#bbbbbb;font-size:16px">Too light</p></div>`);
  const findings = only(doc, 'contrast');
  assert.equal(findings.length, 1);
  assert.match(findings[0]!.message, /WCAG AA needs 4.5:1/);
});

test('accepts text that meets the threshold', () => {
  const { doc } = docWith(`<div style="background-color:#ffffff"><p style="color:#333333;font-size:16px">Readable</p></div>`);
  assert.equal(only(doc, 'contrast').length, 0);
});

test('large text is held to the lower 3:1 requirement', () => {
  const light = `color:#949494`;
  const small = docWith(`<div style="background-color:#fff"><p style="${light};font-size:16px">x</p></div>`);
  const large = docWith(`<div style="background-color:#fff"><p style="${light};font-size:30px">x</p></div>`);
  assert.equal(only(small.doc, 'contrast').length, 1, 'fails at 16px');
  assert.equal(only(large.doc, 'contrast').length, 0, 'passes at 30px');
});

test('contrast resolves colours through tokens', () => {
  const { doc } = docWith(`<div style="background-color:var(--color-bg)"><p style="color:var(--color-muted);font-size:14px">x</p></div>`);
  // The seeded tokens are #ffffff and #6b7280 — about 4.8:1, which passes.
  assert.equal(only(doc, 'contrast').length, 0);

  doc.tokens = doc.tokens.map((t) => (t.name === 'color.muted' ? { ...t, values: { default: '#cccccc' } } : t));
  assert.equal(only(doc, 'contrast').length, 1, 'a lighter token value now fails');
});

test('contrast stays quiet where it cannot tell', () => {
  const gradient = docWith(`<div style="background-image:linear-gradient(#000,#fff)"><p style="color:#888;font-size:14px">x</p></div>`);
  assert.equal(only(gradient.doc, 'contrast').length, 0, 'no single background colour to measure');

  const unknown = docWith(`<div><p style="color:var(--not-a-token);font-size:14px">x</p></div>`);
  assert.equal(only(unknown.doc, 'contrast').length, 0, 'unresolvable colour is unknown, not black');
});

test('inherits colour and background from ancestors', () => {
  const { doc } = docWith(`<div style="background-color:#ffffff;color:#dddddd"><div><p style="font-size:14px">Inherited</p></div></div>`);
  assert.equal(only(doc, 'contrast').length, 1);
});

test('flags small tap targets and ignores large ones', () => {
  const small = docWith(`<button style="width:30px;height:24px">Go</button>`);
  const large = docWith(`<button style="width:120px;height:48px">Go</button>`);
  assert.equal(only(small.doc, 'tap-target').length, 1);
  assert.equal(only(large.doc, 'tap-target').length, 0);
});

test('tap target prefers a measured box over authored styles', () => {
  const { doc } = docWith(`<button style="width:120px;height:48px">Go</button>`);
  const button = Object.values(doc.nodes).find((n) => n.tag === 'button')!;
  const findings = lintDocument(doc, { rules: ['tap-target'], measured: { [button.id]: { width: 120, height: 20 } } });
  assert.equal(findings.length, 1, 'what actually rendered wins over what was authored');
});

test('flags a missing alt attribute but not an explicitly empty one', () => {
  assert.equal(only(docWith(`<img src="a.png" />`).doc, 'missing-alt').length, 1);
  assert.equal(only(docWith(`<img src="a.png" alt="" />`).doc, 'missing-alt').length, 0);
  assert.equal(only(docWith(`<img src="a.png" alt="A cat" />`).doc, 'missing-alt').length, 0);
});

test('flags text below 12px', () => {
  assert.equal(only(docWith(`<p style="font-size:9px">tiny</p>`).doc, 'tiny-text').length, 1);
  assert.equal(only(docWith(`<p style="font-size:14px">fine</p>`).doc, 'tiny-text').length, 0);
});

test('flags a literal only where the design already uses that token', () => {
  // One element uses the token, another hardcodes the same value: inconsistent.
  const { doc } = docWith(`
    <div style="background-color:var(--color-brand)"></div>
    <div style="background-color:#3b82f6"></div>`);
  const findings = only(doc, 'hardcoded-token');
  assert.equal(findings.length, 1);
  assert.match(findings[0]!.message, /color\.brand/);
  assert.match(findings[0]!.fix!, /var\(--color-brand\)/);
});

test('a literal matching an unused token is a coincidence, not a finding', () => {
  const { doc } = docWith(`<div style="background-color:#3b82f6"></div>`);
  assert.equal(only(doc, 'hardcoded-token').length, 0);
});

test('a new document lints clean', () => {
  const doc = createEmptyDocument('Fresh');
  assert.deepEqual(lintDocument(doc), [], 'the default artboard must not trip a rule');
});

test('does not flag a value that is already a token reference', () => {
  const { doc } = docWith(`<div style="background-color:var(--color-brand)"></div>`);
  assert.equal(only(doc, 'hardcoded-token').length, 0);
});

test('flags a container of absolutely-positioned children', () => {
  const soup = docWith(`<div>
    <div style="position:absolute;left:0"></div>
    <div style="position:absolute;left:10px"></div>
    <div style="position:absolute;left:20px"></div>
  </div>`);
  assert.equal(only(soup.doc, 'absolute-soup').length, 1);

  const flex = docWith(`<div style="display:flex"><div></div><div></div><div></div></div>`);
  assert.equal(only(flex.doc, 'absolute-soup').length, 0);
});

test('one absolute child among several is not soup', () => {
  const { doc } = docWith(`<div style="display:flex">
    <div></div><div></div><div></div><div style="position:absolute"></div>
  </div>`);
  assert.equal(only(doc, 'absolute-soup').length, 0, 'badges and overlays are legitimate');
});

test('flags empty text layers', () => {
  const doc = createEmptyDocument('Empty');
  const artboard = doc.pages[0]!.artboards[0]!;
  const node = makeNode({ type: 'text', tag: 'p', text: '   ' });
  applyOp(doc, { t: 'insert', nodes: [node], parent: artboard, index: 0 });
  assert.equal(only(doc, 'empty-text').length, 1);
});

test('flags spacing that is off the token scale, and only when a scale exists', () => {
  const { doc } = docWith(`<div style="display:flex;gap:13px"><span>a</span><span>b</span></div>`);
  const findings = only(doc, 'off-scale-spacing');
  assert.equal(findings.length, 1);
  assert.match(findings[0]!.message, /not on the spacing scale/);

  const onScale = docWith(`<div style="display:flex;gap:16px"><span>a</span><span>b</span></div>`);
  assert.equal(only(onScale.doc, 'off-scale-spacing').length, 0);

  const noTokens = docWith(`<div style="display:flex;gap:13px"><span>a</span></div>`);
  noTokens.doc.tokens = noTokens.doc.tokens.filter((t) => t.group !== 'space');
  assert.equal(only(noTokens.doc, 'off-scale-spacing').length, 0, 'no scale, nothing to be off');
});

test('flags a structure repeated three or more times, once', () => {
  const card = `<div style="display:flex;padding:8px"><span>Title</span><span>Body</span></div>`;
  const { doc } = docWith(`<div>${card}${card}${card}</div>`);
  const findings = only(doc, 'repeated-subtree');
  assert.equal(findings.length, 1, 'reported once, not per copy');
  assert.match(findings[0]!.message, /appears 3 times/);
});

test('two copies are not yet repetition', () => {
  const card = `<div style="display:flex;padding:8px"><span>a</span><span>b</span></div>`;
  const { doc } = docWith(`<div>${card}${card}</div>`);
  assert.equal(only(doc, 'repeated-subtree').length, 0);
});

test('hidden layers are skipped', () => {
  const { doc } = docWith(`<div style="background-color:#fff"><p style="color:#ddd;font-size:14px">x</p></div>`);
  const text = Object.values(doc.nodes).find((n) => n.type === 'text')!;
  assert.equal(only(doc, 'contrast').length, 1);
  applyOp(doc, { t: 'meta', updates: [{ id: text.id, visible: false }] });
  assert.equal(only(doc, 'contrast').length, 0);
});

test('scope can be narrowed to a subtree', () => {
  const { doc } = docWith(`<div id="a" style="background-color:#fff"><p style="color:#ddd;font-size:14px">x</p></div>`);
  const outer = Object.values(doc.nodes).find((n) => n.attrs.id === 'a')!;
  assert.equal(lintDocument(doc, { rules: ['contrast'], within: outer.id }).length, 1);

  const elsewhere = makeNode({ type: 'frame' });
  applyOp(doc, { t: 'insert', nodes: [elsewhere], parent: doc.pages[0]!.artboards[0]!, index: 0 });
  assert.equal(lintDocument(doc, { rules: ['contrast'], within: elsewhere.id }).length, 0);
});

test('a clean document produces nothing', () => {
  const { doc } = docWith(`
    <div style="display:flex;flex-direction:column;gap:16px;padding:16px;background-color:#ffffff">
      <p style="color:#111111;font-size:16px">Readable text</p>
      <img src="a.png" alt="Described" />
      <button style="width:120px;height:48px">Press</button>
    </div>`);
  const findings = lintDocument(doc);
  assert.deepEqual(findings, [], JSON.stringify(findings, null, 1));
});

test('summarise groups by rule', () => {
  const { doc } = docWith(`<div style="background-color:#fff"><p style="color:#ddd;font-size:9px">x</p><img src="a.png"/></div>`);
  const summary = summarise(lintDocument(doc));
  assert.ok(summary.find((s) => s.rule === 'contrast'));
  assert.ok(summary.find((s) => s.rule === 'tiny-text'));
  assert.ok(summary.find((s) => s.rule === 'missing-alt'));
});

test('every rule is documented', () => {
  const documented = new Set(RULES.map((r) => r.id));
  const { doc } = docWith(`<div style="background-color:#fff"><p style="color:#ddd;font-size:9px">x</p></div>`);
  for (const f of lintDocument(doc)) assert.ok(documented.has(f.rule), `${f.rule} has no entry in RULES`);
  for (const r of RULES) assert.ok(r.why.length > 20, `${r.id} needs a real explanation`);
});
