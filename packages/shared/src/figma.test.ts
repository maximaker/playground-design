import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSchema, compileSchema, encodeBinarySchema } from 'kiwi-schema';
import { deflateSync } from 'fflate';
import { decodeFigmaClipboard, figmaToHtml, isFigmaClipboard, vectorNetworkToPath, radialShape, type FigMessage, type FigNode } from './figma.ts';
import { parseHtml } from './html.ts';

/* A tiny stand-in for Figma's schema: the decoder reads whatever schema travels. */
const SCHEMA = `
struct GUID { uint sessionID; uint localID; }
message ParentIndex { GUID guid = 1; string position = 2; }
message Vector { float x = 1; float y = 2; }
message NodeChange { GUID guid = 1; string type = 2; string name = 3; ParentIndex parentIndex = 4; Vector size = 5; }
message Message { NodeChange[] nodeChanges = 1; }
`;

function clipboardHtml(message: FigMessage): string {
  const schema = parseSchema(SCHEMA);
  const data = (compileSchema(schema) as { encodeMessage(m: unknown): Uint8Array }).encodeMessage(message);
  const chunks = [deflateSync(encodeBinarySchema(schema)), deflateSync(data)];
  const head = new TextEncoder().encode('fig-kiwi');
  const out = new Uint8Array(12 + chunks.reduce((n, c) => n + 4 + c.length, 0));
  out.set(head, 0);
  const dv = new DataView(out.buffer);
  dv.setUint32(8, 20, true);
  let o = 12;
  for (const c of chunks) { dv.setUint32(o, c.length, true); out.set(c, o + 4); o += 4 + c.length; }
  const b64 = Buffer.from(out).toString('base64');
  return `<meta charset="utf-8"><span data-metadata="<!--(figmeta)e30=(/figmeta)-->"></span><span data-buffer="<!--(figma)${b64}(/figma)-->"></span>`;
}

const g = (sessionID: number, localID: number) => ({ sessionID, localID });
const page: FigNode = { guid: g(0, 1), type: 'CANVAS', name: 'Page 1' };

test('decodes a fig-kiwi clipboard: schema and message both travel', () => {
  const html = clipboardHtml({ nodeChanges: [page, { guid: g(1, 2), type: 'FRAME', name: 'Card', parentIndex: { guid: g(0, 1), position: '!' }, size: { x: 200, y: 100 } }] });
  assert.ok(isFigmaClipboard(html));
  const { message } = decodeFigmaClipboard(html);
  assert.equal(message.nodeChanges?.[1]?.name, 'Card');
  assert.equal(Math.round(message.nodeChanges![1]!.size!.x), 200);
});

test('decoding needs no eval, so it runs under the app CSP', () => {
  const html = clipboardHtml({ nodeChanges: [page] });
  const real = globalThis.Function;
  // kiwi's compiled decoder used `new Function`, which the CSP blocks in the browser.
  (globalThis as { Function: unknown }).Function = function blocked() { throw new EvalError('blocked by CSP'); };
  try {
    assert.equal(decodeFigmaClipboard(html).message.nodeChanges?.[0]?.name, 'Page 1');
  } finally {
    (globalThis as { Function: unknown }).Function = real;
  }
});

const red = { type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 1, visible: true };

test('auto layout becomes flexbox; fills, radius and text runs come across', () => {
  const nodes: FigNode[] = [
    page,
    { guid: g(1, 1), type: 'FRAME', name: 'Row', parentIndex: { guid: g(0, 1), position: '!' }, size: { x: 300, y: 40 },
      stackMode: 'HORIZONTAL', stackSpacing: 8, stackHorizontalPadding: 12, stackVerticalPadding: 4, stackCounterAlignItems: 'CENTER',
      fillPaints: [red], cornerRadius: 6, frameMaskDisabled: true },
    { guid: g(1, 2), type: 'TEXT', name: 'Label', parentIndex: { guid: g(1, 1), position: '!' }, size: { x: 120, y: 20 },
      textAutoResize: 'WIDTH_AND_HEIGHT', fontSize: 16, fontName: { family: 'Inter', style: 'Semi Bold' },
      textData: { characters: 'Hi there', characterStyleIDs: [0, 0, 0, 5, 5, 5, 5, 5], styleOverrideTable: [{ styleID: 5, fillPaints: [red] }] } },
  ];
  const { html, layers } = figmaToHtml({ nodeChanges: nodes });
  assert.equal(layers, 2);
  assert.match(html, /display:flex;flex-direction:row;gap:8px;padding:4px 12px 4px 12px/);
  assert.match(html, /background-color:#FF0000/);
  assert.match(html, /border-radius:6px/);
  assert.match(html, /font-weight:600/);
  // The space before the coloured run stays outside it, so it survives parsing.
  assert.match(html, /Hi <span style="color:#FF0000">there<\/span>/);
  const parsed = parseHtml(html);
  assert.ok(parsed.nodes.some((n) => n.text === 'there'));
});

test('an instance renders its component, with overrides applied', () => {
  const nodes: FigNode[] = [
    page,
    { guid: g(9, 9), type: 'CANVAS', name: 'Internal Only Canvas' },
    { guid: g(2, 1), type: 'SYMBOL', name: 'Badge', parentIndex: { guid: g(9, 9), position: '!' }, size: { x: 80, y: 24 } },
    { guid: g(2, 2), type: 'TEXT', name: 'Text', parentIndex: { guid: g(2, 1), position: '!' }, size: { x: 60, y: 20 }, textData: { characters: 'Default' } },
    { guid: g(3, 1), type: 'INSTANCE', name: 'Badge', parentIndex: { guid: g(0, 1), position: '!' }, size: { x: 80, y: 24 },
      symbolData: { symbolID: g(2, 1), symbolOverrides: [{ guidPath: { guids: [g(2, 2)] }, textData: { characters: 'New' } }] } },
  ];
  const { html } = figmaToHtml({ nodeChanges: nodes });
  assert.match(html, />New</);
  assert.doesNotMatch(html, /Default/);
});

test('image fills become placeholders with a hint', () => {
  const nodes: FigNode[] = [page, { guid: g(1, 1), type: 'RECTANGLE', name: 'Photo', parentIndex: { guid: g(0, 1), position: '!' }, size: { x: 10, y: 10 }, fillPaints: [{ type: 'IMAGE', visible: true }] }];
  const r = figmaToHtml({ nodeChanges: nodes });
  assert.match(r.warnings.join(' '), /Copy as PNG/);
});

test('a vector network becomes an SVG path', () => {
  // Two vertices, one straight segment, no regions: an open line.
  const buf = new ArrayBuffer(12 + 2 * 12 + 28);
  const dv = new DataView(buf);
  let o = 0;
  const u = (v: number) => { dv.setUint32(o, v, true); o += 4; };
  const f = (v: number) => { dv.setFloat32(o, v, true); o += 4; };
  u(2); u(1); u(0);
  u(0); f(0); f(0);
  u(0); f(10); f(5);
  u(0); u(0); f(0); f(0); u(1); f(0); f(0);
  const { d } = vectorNetworkToPath(new Uint8Array(buf), 2, 2);
  assert.equal(d, 'M0 0L20 10');
});

test('image fills use the clipboard links: fill, fit and crop', () => {
  const hash = new Uint8Array([0xab, 0xcd]);
  const img = (mode: string, transform?: object) => ({ type: 'IMAGE', visible: true, imageScaleMode: mode, image: { hash }, transform });
  const node = (id: number, paint: object): FigNode => ({ guid: g(1, id), type: 'RECTANGLE', name: `R${id}`, parentIndex: { guid: g(0, 1), position: String(id) }, size: { x: 100, y: 100 }, fillPaints: [paint as never] });
  const r = figmaToHtml({ nodeChanges: [page, node(1, img('FILL')), node(2, img('FIT')), node(3, img('STRETCH', { m00: 0.5, m01: 0, m02: 0.25, m10: 0, m11: 1, m12: 0 }))] }, { images: { abcd: 'https://s3-alpha-sig.figma.com/img/ab/cd' } });
  assert.deepEqual(r.images, ['https://s3-alpha-sig.figma.com/img/ab/cd']);
  assert.match(r.html, /url\('https:\/\/s3-alpha-sig\.figma\.com\/img\/ab\/cd'\) center \/ cover no-repeat/);
  assert.match(r.html, /center \/ contain no-repeat/);
  // Half the image shown, starting a quarter in: 200% wide, positioned at 50%.
  assert.match(r.html, /50% 0% \/ 200% 100% no-repeat/);
  assert.equal(r.warnings.length, 0);
  // The single quotes keep the URL inside the style attribute when parsed.
  assert.ok(parseHtml(r.html).nodes.every((n) => !n.styles.background || n.styles.background.includes('figma.com')));
});

test('outlined display text and Figma lists come across', () => {
  const white = { r: 1, g: 1, b: 1, a: 1 };
  const nodes: FigNode[] = [page,
    { guid: g(1, 1), type: 'TEXT', name: '0', parentIndex: { guid: g(0, 1), position: '!' }, size: { x: 100, y: 100 }, textData: { characters: '0' },
      fillPaints: [{ type: 'SOLID', color: white, opacity: 0, visible: true }], strokePaints: [{ type: 'SOLID', color: white, visible: true }], strokeWeight: 2, strokeAlign: 'OUTSIDE' },
    { guid: g(1, 2), type: 'TEXT', name: 'List', parentIndex: { guid: g(0, 1), position: '"' }, size: { x: 100, y: 100 }, paragraphSpacing: 8,
      textData: { characters: 'One\nTwo\nAfter', lines: [{ lineType: 'UNORDERED_LIST' }, { lineType: 'UNORDERED_LIST' }, { lineType: 'PLAIN' }] } },
  ];
  const { html } = figmaToHtml({ nodeChanges: nodes });
  assert.match(html, /color:transparent/);
  assert.match(html, /-webkit-text-stroke:2px #FFFFFF/);
  assert.match(html, /<ul[^>]*><li[^>]*>One<\/li><li[^>]*>Two<\/li><\/ul><div[^>]*>After<\/div>/);
});

test('nested absolute groups stay absolute, and absolute children in auto layout have a positioned parent', () => {
  const nodes: FigNode[] = [page,
    { guid: g(1, 1), type: 'FRAME', name: 'Outer', parentIndex: { guid: g(0, 1), position: '!' }, size: { x: 100, y: 100 }, stackMode: 'VERTICAL' },
    { guid: g(1, 2), type: 'FRAME', name: 'Free', parentIndex: { guid: g(1, 1), position: '!' }, size: { x: 50, y: 50 }, stackPositioning: 'ABSOLUTE', transform: { m00: 1, m01: 0, m02: 5, m10: 0, m11: 1, m12: 5 } },
    { guid: g(1, 3), type: 'RECTANGLE', name: 'Dot', parentIndex: { guid: g(1, 2), position: '!' }, size: { x: 10, y: 10 }, transform: { m00: 1, m01: 0, m02: 20, m10: 0, m11: 1, m12: 0 } },
  ];
  const { html } = figmaToHtml({ nodeChanges: nodes });
  const style = (name: string) => new RegExp(`data-name="${name}" style="([^"]*)"`).exec(html)![1]!;
  assert.match(style('Outer'), /position:relative/);
  assert.match(style('Free'), /position:absolute/);
  assert.doesNotMatch(style('Free'), /position:relative/);
});

test('a hugging frame whose children are all hidden keeps its Figma size', () => {
  const nodes: FigNode[] = [page,
    { guid: g(1, 1), type: 'FRAME', name: 'Column', parentIndex: { guid: g(0, 1), position: '!' }, size: { x: 800, y: 600 }, stackMode: 'VERTICAL', stackCounterSizing: 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE' },
    { guid: g(1, 2), type: 'TEXT', name: 'Hidden', visible: false, parentIndex: { guid: g(1, 1), position: '!' }, size: { x: 800, y: 100 } },
  ];
  assert.match(figmaToHtml({ nodeChanges: nodes }).html, /data-name="Column" style="[^"]*width:800px/);
});

test('radial gradients keep their Figma centre and reach', () => {
  // Centred at the top edge, reaching the full width and height.
  assert.equal(radialShape({ m00: 0, m01: 0.5, m02: 0.5, m10: -0.5, m11: 0, m12: 0.75 }), '100% 100% at 50% 0%, ');
  // Figma's default circle needs nothing.
  assert.equal(radialShape({ m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 }), '');
});
