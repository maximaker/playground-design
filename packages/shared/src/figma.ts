/**
 * Paste from Figma.
 *
 * Figma's clipboard is not HTML: it is `fig-kiwi`, Figma's own binary scene
 * format, base64'd inside two marker spans in the text/html slot. It holds the
 * copied layers plus everything they depend on (shared styles, the components
 * their instances use) in an "Internal Only Canvas".
 *
 * Decoding: magic "fig-kiwi", a version, then length-prefixed chunks — a
 * compressed kiwi schema (deflate) and a message encoded with it (zstd in
 * current versions, deflate in older ones). kiwi is the open format Figma's
 * co-founder published; the schema travels with the data, so field names are
 * read, not guessed.
 *
 * Converting: each layer becomes HTML with inline CSS — auto layout as flexbox,
 * fills as backgrounds, strokes as borders, text runs as spans, vector networks
 * as SVG paths — which the ordinary paste path (parseHtml) turns into layers.
 * Image fills do not travel in the clipboard (only their hashes do), so they
 * become placeholders with a hint.
 *
 * The format is undocumented and can change; anything unrecognised degrades to
 * a plain box rather than failing the paste.
 */
import { decodeBinarySchema, compileSchema } from 'kiwi-schema';
import { decompress as zstd } from 'fzstd';
import { inflateSync } from 'fflate';

/* ------------------------------------------------------------------ types */

type Guid = { sessionID: number; localID: number };
type Color = { r: number; g: number; b: number; a: number };
type Paint = {
  type: string; color?: Color; opacity?: number; visible?: boolean; blendMode?: string;
  stops?: { color: Color; position: number }[];
  transform?: { m00: number; m01: number; m02: number; m10: number; m11: number; m12: number };
};
type Effect = { type: string; color?: Color; offset?: { x: number; y: number }; radius?: number; spread?: number; visible?: boolean };
type Num = { value: number; units: string };
type TextStyle = {
  styleID?: number; fontName?: { family: string; style: string }; fontSize?: number;
  lineHeight?: Num; letterSpacing?: Num; fillPaints?: Paint[]; textDecoration?: string; textCase?: string;
  styleIdForFill?: StyleRef;
};
type StyleRef = { assetRef?: { key: string }; guid?: Guid };
/** A node change as Figma encodes it; only the fields used here are typed. */
export interface FigNode extends TextStyle {
  guid?: Guid; type?: string; name?: string; visible?: boolean; opacity?: number;
  parentIndex?: { guid: Guid; position: string };
  size?: { x: number; y: number };
  transform?: { m00: number; m01: number; m02: number; m10: number; m11: number; m12: number };
  fillPaints?: Paint[]; strokePaints?: Paint[]; strokeWeight?: number; strokeAlign?: string; strokeCap?: string;
  borderStrokeWeightsIndependent?: boolean; borderTopWeight?: number; borderRightWeight?: number; borderBottomWeight?: number; borderLeftWeight?: number;
  cornerRadius?: number; rectangleTopLeftCornerRadius?: number; rectangleTopRightCornerRadius?: number;
  rectangleBottomLeftCornerRadius?: number; rectangleBottomRightCornerRadius?: number; rectangleCornerRadiiIndependent?: boolean;
  effects?: Effect[]; blendMode?: string; frameMaskDisabled?: boolean;
  stackMode?: string; stackSpacing?: number; stackCounterSpacing?: number; stackWrap?: string;
  stackHorizontalPadding?: number; stackVerticalPadding?: number; stackPaddingRight?: number; stackPaddingBottom?: number;
  stackPrimaryAlignItems?: string; stackCounterAlignItems?: string; stackPrimarySizing?: string; stackCounterSizing?: string;
  stackChildPrimaryGrow?: number; stackChildAlignSelf?: string; stackPositioning?: string;
  textData?: { characters?: string; characterStyleIDs?: number[]; styleOverrideTable?: TextStyle[]; lines?: { lineType?: string }[] };
  textAlignHorizontal?: string; textAutoResize?: string;
  symbolData?: { symbolID?: Guid; symbolOverrides?: (FigNode & { guidPath?: { guids: Guid[] } })[] };
  derivedSymbolData?: (FigNode & { guidPath?: { guids: Guid[] } })[];
  vectorData?: { vectorNetworkBlob?: number; normalizedSize?: { x: number; y: number } };
  key?: string; styleIdForStrokeFill?: StyleRef; styleIdForEffect?: StyleRef;
}
export interface FigMessage { nodeChanges?: FigNode[]; blobs?: { bytes: Uint8Array }[] }

/* ---------------------------------------------------------------- decode */

const FIGMA_RE = /\(figma\)([\s\S]*?)\(\/figma\)/;
const META_RE = /\(figmeta\)([\s\S]*?)\(\/figmeta\)/;

/** True when an HTML clipboard payload is Figma's own format. */
export function isFigmaClipboard(html: string): boolean {
  return FIGMA_RE.test(html);
}

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/\s+/g, '');
  if (typeof atob === 'function') return Uint8Array.from(atob(clean), (c) => c.charCodeAt(0));
  return new Uint8Array(Buffer.from(clean, 'base64'));
}

const unpack = (c: Uint8Array): Uint8Array =>
  c[0] === 0x28 && c[1] === 0xb5 && c[2] === 0x2f && c[3] === 0xfd ? zstd(c) : inflateSync(c);

/** Reads a fig-kiwi archive (the bytes inside the clipboard markers). */
export function decodeFigKiwi(bytes: Uint8Array): FigMessage {
  const magic = new TextDecoder().decode(bytes.subarray(0, 8));
  if (magic !== 'fig-kiwi') throw new Error('Not a Figma clipboard');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: Uint8Array[] = [];
  for (let off = 12; off + 4 <= bytes.length;) {
    const len = dv.getUint32(off, true);
    chunks.push(bytes.subarray(off + 4, off + 4 + len));
    off += 4 + len;
  }
  if (chunks.length < 2) throw new Error('Figma clipboard is incomplete');
  const schema = compileSchema(decodeBinarySchema(unpack(chunks[0]!))) as { decodeMessage(b: Uint8Array): FigMessage };
  return schema.decodeMessage(unpack(chunks[1]!));
}

export function decodeFigmaClipboard(html: string): { message: FigMessage; meta: Record<string, unknown> } {
  const m = FIGMA_RE.exec(html);
  if (!m) throw new Error('Not a Figma clipboard');
  let meta: Record<string, unknown> = {};
  try { meta = JSON.parse(new TextDecoder().decode(base64ToBytes(META_RE.exec(html)?.[1] ?? ''))); } catch { /* optional */ }
  return { message: decodeFigKiwi(base64ToBytes(m[1]!)), meta };
}

/* -------------------------------------------------------------- helpers */

const gid = (g?: Guid) => (g ? `${g.sessionID}:${g.localID}` : '');
const px = (n: number | undefined) => `${Math.round((n ?? 0) * 100) / 100}px`;
const r255 = (n: number) => Math.round(n * 255);
/** Figma ends lines with U+2028 (line separator) as well as newlines. */
const LINE_BREAKS = new RegExp(`[${String.fromCharCode(0x2028, 0x0a)}]`, 'g');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = (s: string) => esc(s).replace(/"/g, '&quot;');

function css(c: Color, opacity = 1): string {
  const a = Math.round((c.a ?? 1) * opacity * 1000) / 1000;
  const hex = `#${[c.r, c.g, c.b].map((v) => r255(v).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
  return a >= 1 ? hex : `rgba(${r255(c.r)}, ${r255(c.g)}, ${r255(c.b)}, ${a})`;
}

const visiblePaints = (ps?: Paint[]) => (ps ?? []).filter((p) => p.visible !== false && (p.opacity ?? 1) > 0);

const WEIGHTS: [RegExp, number][] = [
  [/thin|hairline/i, 100], [/extra ?light|ultra ?light/i, 200], [/light/i, 300], [/medium/i, 500],
  [/semi ?bold|demi ?bold/i, 600], [/extra ?bold|ultra ?bold/i, 800], [/black|heavy/i, 900], [/bold/i, 700],
];
const weightOf = (style = '') => WEIGHTS.find(([re]) => re.test(style))?.[1] ?? 400;

/** A CSS background for a stack of Figma paints (bottom first, as Figma stores them). */
function background(paints: Paint[], images: { n: number }): string {
  const layers: string[] = [];
  for (const p of paints) {
    const o = p.opacity ?? 1;
    if (p.type === 'SOLID' && p.color) layers.push(`linear-gradient(${css(p.color, o)}, ${css(p.color, o)})`);
    else if (p.type?.startsWith('GRADIENT') && p.stops?.length) {
      const stops = p.stops.map((s) => `${css(s.color, o)} ${Math.round(s.position * 1000) / 10}%`).join(', ');
      if (p.type === 'GRADIENT_LINEAR') {
        // Figma's gradient transform maps the gradient line; its rotation is the CSS angle.
        const t = p.transform;
        const deg = t ? Math.round((Math.atan2(t.m10, t.m00) * 180) / Math.PI + 90) : 180;
        layers.push(`linear-gradient(${deg}deg, ${stops})`);
      } else layers.push(`radial-gradient(${stops})`);
    } else if (p.type === 'IMAGE') {
      images.n++;
      layers.push('linear-gradient(#E3E6EF, #E3E6EF)');
    }
  }
  if (!layers.length) return '';
  // One solid colour reads better as a plain background-color.
  const solid = /^linear-gradient\(([^,()]+(?:\([^)]*\))?), \1\)$/.exec(layers.length === 1 ? layers[0]! : '');
  return solid ? `background-color:${solid[1]}` : `background:${layers.reverse().join(', ')}`;
}

/* ------------------------------------------------------- vector networks */

/**
 * A vector network blob: vertices, segments (with tangents), then regions of
 * loops of segments. Coordinates are in `normalizedSize` space.
 */
export function vectorNetworkToPath(bytes: Uint8Array, sx = 1, sy = 1): { d: string; evenOdd: boolean } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const u32 = () => { const v = dv.getUint32(o, true); o += 4; return v; };
  const f32 = () => { const v = dv.getFloat32(o, true); o += 4; return v; };
  const nv = u32(), ns = u32(), nr = u32();
  const verts: { x: number; y: number }[] = [];
  for (let i = 0; i < nv; i++) { u32(); verts.push({ x: f32() * sx, y: f32() * sy }); }
  const segs: { a: number; ax: number; ay: number; b: number; bx: number; by: number }[] = [];
  for (let i = 0; i < ns; i++) {
    u32();
    const a = u32(), ax = f32() * sx, ay = f32() * sy, b = u32(), bx = f32() * sx, by = f32() * sy;
    segs.push({ a, ax, ay, b, bx, by });
  }
  const n = (v: number) => Math.round(v * 100) / 100;
  const segPath = (s: (typeof segs)[number], reverse: boolean) => {
    const [p0, p1, t0x, t0y, t1x, t1y] = reverse
      ? [verts[s.b]!, verts[s.a]!, s.bx, s.by, s.ax, s.ay]
      : [verts[s.a]!, verts[s.b]!, s.ax, s.ay, s.bx, s.by];
    const straight = !t0x && !t0y && !t1x && !t1y;
    return { start: p0, cmd: straight ? `L${n(p1.x)} ${n(p1.y)}` : `C${n(p0.x + t0x)} ${n(p0.y + t0y)} ${n(p1.x + t1x)} ${n(p1.y + t1y)} ${n(p1.x)} ${n(p1.y)}`, end: reverse ? s.a : s.b };
  };
  const parts: string[] = [];
  let evenOdd = false;
  if (nr > 0) {
    for (let r = 0; r < nr; r++) {
      const style = u32();
      if (style & 1) evenOdd = false; else evenOdd = evenOdd || false;
      const loops = u32();
      for (let l = 0; l < loops; l++) {
        const count = u32();
        const idx: number[] = [];
        for (let k = 0; k < count; k++) idx.push(u32());
        let cur = -1;
        idx.forEach((si, k) => {
          const s = segs[si]!;
          const rev = cur === -1 ? (k + 1 < idx.length && (segs[idx[k + 1]!]!.a === s.a || segs[idx[k + 1]!]!.b === s.a)) : s.b === cur;
          const seg = segPath(s, rev);
          if (k === 0) parts.push(`M${n(seg.start.x)} ${n(seg.start.y)}`);
          parts.push(seg.cmd);
          cur = seg.end;
        });
        parts.push('Z');
      }
    }
  } else {
    // Open paths (strokes only): chain segments, starting a new subpath on a gap.
    let cur = -1;
    for (const s of segs) {
      if (s.a !== cur) parts.push(`M${n(verts[s.a]!.x)} ${n(verts[s.a]!.y)}`);
      parts.push(segPath(s, false).cmd);
      cur = s.b;
    }
  }
  return { d: parts.join(''), evenOdd };
}

/* --------------------------------------------------------------- convert */

export interface FigmaPaste { html: string; warnings: string[]; layers: number }

/** Turns a decoded Figma clipboard into HTML the canvas can parse. */
export function figmaToHtml(message: FigMessage): FigmaPaste {
  const nodes = message.nodeChanges ?? [];
  const blobs = message.blobs ?? [];
  const byId = new Map<string, FigNode>();
  const kids = new Map<string, FigNode[]>();
  for (const n of nodes) {
    byId.set(gid(n.guid), n);
    const p = gid(n.parentIndex?.guid);
    if (p) (kids.get(p) ?? kids.set(p, []).get(p)!).push(n);
  }
  for (const list of kids.values()) list.sort((a, b) => ((a.parentIndex?.position ?? '') < (b.parentIndex?.position ?? '') ? -1 : 1));
  // Shared styles travel as hidden nodes carrying a key.
  const styles = new Map<string, FigNode>();
  for (const n of nodes) if (n.key) styles.set(n.key, n);
  const styled = <K extends keyof FigNode>(ref: StyleRef | undefined, field: K, own: FigNode[K]): FigNode[K] => {
    const s = ref?.assetRef ? styles.get(ref.assetRef.key) : undefined;
    return (s?.[field] as FigNode[K]) ?? own;
  };

  const internal = nodes.find((n) => n.type === 'CANVAS' && /internal/i.test(n.name ?? ''));
  const pageIds = new Set(nodes.filter((n) => n.type === 'CANVAS' && n !== internal).map((n) => gid(n.guid)));
  const roots = nodes.filter((n) => pageIds.has(gid(n.parentIndex?.guid)));
  const images = { n: 0 };
  let layers = 0;
  const warnings: string[] = [];

  const render = (raw: FigNode, inFlow: boolean, isRoot: boolean, overrides: Map<string, FigNode>, path: string): string => {
    const ov = overrides.get(path);
    const n: FigNode = ov ? { ...raw, ...ov } : raw;
    if (n.visible === false) return '';
    layers++;
    const s: string[] = [];
    const t = n.transform;
    const name = attr(n.name ?? n.type ?? 'Layer');

    // Placement: in auto layout the flow places it; otherwise its transform does.
    if (!isRoot && (!inFlow || n.stackPositioning === 'ABSOLUTE')) {
      s.push('position:absolute', `left:${px(t?.m02)}`, `top:${px(t?.m12)}`);
    }
    if (t && (Math.abs(t.m01) > 1e-6 || t.m00 < 0)) {
      const deg = Math.round((Math.atan2(t.m10, t.m00) * 180) / Math.PI * 100) / 100;
      if (deg) s.push(`transform:rotate(${deg}deg)`, 'transform-origin:0 0');
    }
    if (n.opacity !== undefined && n.opacity < 1) s.push(`opacity:${Math.round(n.opacity * 1000) / 1000}`);
    if (n.blendMode && !/NORMAL|PASS_THROUGH/.test(n.blendMode)) s.push(`mix-blend-mode:${n.blendMode.toLowerCase().replace(/_/g, '-')}`);

    // Size, unless auto layout makes it hug or fill.
    const w = n.size?.x ?? 0, h = n.size?.y ?? 0;
    let setW = true, setH = true;
    const auto = n.stackMode === 'HORIZONTAL' || n.stackMode === 'VERTICAL';
    if (auto) {
      const hugMain = /RESIZE_TO_FIT/.test(n.stackPrimarySizing ?? '');
      const hugCross = /RESIZE_TO_FIT/.test(n.stackCounterSizing ?? '') ;
      if (n.stackMode === 'HORIZONTAL') { if (hugMain) setW = false; if (hugCross) setH = false; }
      else { if (hugMain) setH = false; if (hugCross) setW = false; }
    }
    if (inFlow && !isRoot) {
      if (n.stackChildPrimaryGrow) { s.push('flex:1 1 0'); }
      if (n.stackChildAlignSelf === 'STRETCH') s.push('align-self:stretch');
      s.push('flex-shrink:0');
    }
    if (n.type === 'TEXT') {
      if (n.textAutoResize === 'WIDTH_AND_HEIGHT') { setW = false; setH = false; }
      else if (n.textAutoResize === 'HEIGHT') setH = false;
    }
    if (setW) s.push(`width:${px(w)}`);
    if (setH) s.push(`height:${px(h)}`);

    // Effects.
    const shadows = (n.effects ?? []).filter((e) => e.visible !== false && /SHADOW/.test(e.type) && e.color)
      .map((e) => `${e.type === 'INNER_SHADOW' ? 'inset ' : ''}${px(e.offset?.x)} ${px(e.offset?.y)} ${px(e.radius)} ${px(e.spread)} ${css(e.color!)}`);
    const blur = (n.effects ?? []).find((e) => e.visible !== false && e.type === 'LAYER_BLUR');
    const bgBlur = (n.effects ?? []).find((e) => e.visible !== false && e.type === 'BACKGROUND_BLUR');

    /* ---------- text ---------- */
    if (n.type === 'TEXT') {
      const fills = visiblePaints(styled(n.styleIdForFill, 'fillPaints', n.fillPaints));
      const base: TextStyle = n;
      const runCss = (st: TextStyle, inherit: boolean) => {
        const out: string[] = [];
        const f = st.fontName;
        if (f && (!inherit || f.family !== base.fontName?.family)) out.push(`font-family:'${f.family}', system-ui, sans-serif`);
        if (f && (!inherit || weightOf(f.style) !== weightOf(base.fontName?.style))) out.push(`font-weight:${weightOf(f.style)}`);
        if (f && /italic/i.test(f.style) && (!inherit || !/italic/i.test(base.fontName?.style ?? ''))) out.push('font-style:italic');
        if (st.fontSize && (!inherit || st.fontSize !== base.fontSize)) out.push(`font-size:${px(st.fontSize)}`);
        const lh = st.lineHeight;
        if (lh && !inherit) out.push(`line-height:${lh.units === 'PIXELS' ? px(lh.value) : lh.units === 'PERCENT' ? `${Math.round(lh.value)}%` : Math.round(lh.value * 1000) / 1000}`);
        const ls = st.letterSpacing;
        if (ls && ls.value && !inherit) out.push(`letter-spacing:${ls.units === 'PIXELS' ? px(ls.value) : `${Math.round(ls.value * 10) / 1000}em`}`);
        const fp = visiblePaints(inherit ? styled(st.styleIdForFill, 'fillPaints', st.fillPaints) : fills);
        if (fp[0]?.color) out.push(`color:${css(fp[0].color, fp[0].opacity ?? 1)}`);
        if (st.textDecoration && st.textDecoration !== 'NONE') out.push(`text-decoration:${st.textDecoration === 'STRIKETHROUGH' ? 'line-through' : 'underline'}`);
        if (st.textCase && st.textCase !== 'ORIGINAL') out.push(`text-transform:${st.textCase === 'UPPER' ? 'uppercase' : st.textCase === 'LOWER' ? 'lowercase' : 'capitalize'}`);
        return out;
      };
      s.push(...runCss(base, false), 'margin:0', 'white-space:pre-wrap');
      if (n.textAlignHorizontal && n.textAlignHorizontal !== 'LEFT') s.push(`text-align:${n.textAlignHorizontal === 'JUSTIFIED' ? 'justify' : n.textAlignHorizontal.toLowerCase()}`);
      if (shadows.length) s.push(`text-shadow:${shadows.map((x) => x.replace(/^inset /, '').replace(/ [^ ]+px (#|rgba)/, ' $1')).join(', ')}`);
      const chars = n.textData?.characters ?? '';
      const ids = n.textData?.characterStyleIDs ?? [];
      const table = new Map((n.textData?.styleOverrideTable ?? []).map((o) => [o.styleID ?? -1, o]));
      let html = '';
      for (let i = 0; i < chars.length;) {
        const id = ids[i] ?? 0;
        let j = i + 1;
        while (j < chars.length && (ids[j] ?? 0) === id) j++;
        const text = esc(chars.slice(i, j)).replace(LINE_BREAKS, '<br>');
        const st = id ? table.get(id) : undefined;
        const extra = st ? runCss(st, true) : [];
        // Spaces at a run's edges stay outside its span: the parser trims a
        // styled run, which glued "How to" onto "validate".
        const [, lead = '', core = '', trail = ''] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text) ?? [];
        html += extra.length && core ? `${lead}<span style="${extra.join(';')}">${core}</span>${trail}` : text;
        i = j;
      }
      return `<p data-name="${name}" style="${s.join(';')}">${html || '&#8203;'}</p>`;
    }

    /* ---------- vectors ---------- */
    if (n.type === 'LINE' || n.vectorData || ['STAR', 'REGULAR_POLYGON', 'BOOLEAN_OPERATION'].includes(n.type ?? '')) {
      const fill = visiblePaints(n.fillPaints)[0];
      const strokeP = visiblePaints(styled(n.styleIdForStrokeFill, 'strokePaints', n.strokePaints))[0];
      const sw = n.strokeWeight ?? 1;
      const stroke = strokeP?.color ? ` stroke="${css(strokeP.color, strokeP.opacity ?? 1)}" stroke-width="${sw}"${n.strokeCap && n.strokeCap !== 'NONE' ? ` stroke-linecap="${n.strokeCap === 'ROUND' ? 'round' : 'square'}"` : ''}` : '';
      let inner = '';
      let vw = Math.max(w, 1), vh = Math.max(h, 1);
      if (n.type === 'LINE') {
        vh = Math.max(sw, 1);
        inner = `<line x1="0" y1="${vh / 2}" x2="${w}" y2="${vh / 2}"${stroke}/>`;
        s.splice(s.findIndex((x) => x.startsWith('height:')), 1, `height:${px(vh)}`);
      } else if (n.vectorData?.vectorNetworkBlob !== undefined && blobs[n.vectorData.vectorNetworkBlob]) {
        const ns = n.vectorData.normalizedSize ?? { x: w, y: h };
        try {
          const { d, evenOdd } = vectorNetworkToPath(blobs[n.vectorData.vectorNetworkBlob]!.bytes, ns.x ? w / ns.x : 1, ns.y ? h / ns.y : 1);
          inner = `<path d="${d}" fill="${fill?.color ? css(fill.color, fill.opacity ?? 1) : 'none'}"${evenOdd ? ' fill-rule="evenodd"' : ''}${stroke}/>`;
        } catch { inner = ''; }
      }
      if (!inner) {
        // A shape whose geometry did not travel: keep its box and colour.
        if (fill?.color) s.push(`background-color:${css(fill.color, fill.opacity ?? 1)}`);
        return `<div data-name="${name}" style="${s.join(';')}"></div>`;
      }
      s.push('overflow:visible');
      return `<svg data-name="${name}" width="${vw}" height="${vh}" viewBox="0 0 ${vw} ${vh}" fill="none" xmlns="http://www.w3.org/2000/svg" style="${s.join(';')}">${inner}</svg>`;
    }

    /* ---------- boxes: frames, groups, rectangles, ellipses, instances ---------- */
    let children = kids.get(gid(n.guid)) ?? [];
    let childOverrides = overrides;
    let childPath = path;
    let box: FigNode = n;
    if (n.type === 'INSTANCE' && n.symbolData?.symbolID) {
      const sym = byId.get(gid(n.symbolData.symbolID));
      if (sym) {
        // The instance keeps its own frame properties; the component fills the gaps.
        box = { ...sym, ...n };
        children = kids.get(gid(sym.guid)) ?? [];
        childOverrides = new Map(overrides);
        childPath = '';
        for (const o of [...(n.derivedSymbolData ?? []), ...(n.symbolData.symbolOverrides ?? [])]) {
          const key = (o.guidPath?.guids ?? []).map(gid).join('/');
          const { guidPath: _g, ...rest } = o;
          childOverrides.set(key, { ...(childOverrides.get(key) ?? {}), ...rest });
        }
      } else warnings.push(`Component "${n.name}" was not in the clipboard; pasted its frame only.`);
    }

    const fills = visiblePaints(styled(box.styleIdForFill, 'fillPaints', box.fillPaints));
    const bg = background(fills, images);
    if (bg) s.push(bg);
    const strokeP = visiblePaints(styled(box.styleIdForStrokeFill, 'strokePaints', box.strokePaints))[0];
    if (strokeP?.color && (box.strokeWeight ?? 0) > 0) {
      const c = css(strokeP.color, strokeP.opacity ?? 1);
      if (box.borderStrokeWeightsIndependent) {
        s.push(`border-style:solid`, `border-color:${c}`, `border-width:${px(box.borderTopWeight)} ${px(box.borderRightWeight)} ${px(box.borderBottomWeight)} ${px(box.borderLeftWeight)}`);
      } else if (box.strokeAlign === 'OUTSIDE') s.push(`outline:${px(box.strokeWeight)} solid ${c}`);
      else s.push(`border:${px(box.strokeWeight)} solid ${c}`);
      s.push('box-sizing:border-box');
    }
    if (box.type === 'ELLIPSE') s.push('border-radius:50%');
    else if (box.rectangleCornerRadiiIndependent) {
      s.push(`border-radius:${px(box.rectangleTopLeftCornerRadius)} ${px(box.rectangleTopRightCornerRadius)} ${px(box.rectangleBottomRightCornerRadius)} ${px(box.rectangleBottomLeftCornerRadius)}`);
    } else if (box.cornerRadius) s.push(`border-radius:${px(box.cornerRadius)}`);
    if (shadows.length) s.push(`box-shadow:${shadows.join(', ')}`);
    if (blur?.radius) s.push(`filter:blur(${px(blur.radius / 2)})`);
    if (bgBlur?.radius) s.push(`backdrop-filter:blur(${px(bgBlur.radius / 2)})`);
    const clips = (box.type === 'FRAME' || box.type === 'INSTANCE' || box.type === 'SYMBOL' || box.type === 'COMPONENT') && box.frameMaskDisabled !== true;
    if (clips) s.push('overflow:hidden');

    const boxAuto = box.stackMode === 'HORIZONTAL' || box.stackMode === 'VERTICAL';
    if (boxAuto) {
      s.push('display:flex', `flex-direction:${box.stackMode === 'HORIZONTAL' ? 'row' : 'column'}`);
      if (box.stackSpacing) s.push(`gap:${px(box.stackSpacing)}`);
      if (box.stackWrap === 'WRAP') { s.push('flex-wrap:wrap'); if (box.stackCounterSpacing) s.push(`row-gap:${px(box.stackCounterSpacing)}`); }
      const pt = box.stackVerticalPadding ?? 0, pl = box.stackHorizontalPadding ?? 0;
      const pr = box.stackPaddingRight ?? pl, pb = box.stackPaddingBottom ?? pt;
      if (pt || pr || pb || pl) s.push(`padding:${px(pt)} ${px(pr)} ${px(pb)} ${px(pl)}`);
      const J: Record<string, string> = { MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end', SPACE_EVENLY: 'space-between', SPACE_BETWEEN: 'space-between' };
      const A: Record<string, string> = { MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end', BASELINE: 'baseline' };
      s.push(`justify-content:${J[box.stackPrimaryAlignItems ?? 'MIN'] ?? 'flex-start'}`, `align-items:${A[box.stackCounterAlignItems ?? 'MIN'] ?? 'flex-start'}`);
      if (!s.some((x) => x.startsWith('box-sizing'))) s.push('box-sizing:border-box');
    } else if (children.length) s.push('position:relative');

    const inner = children.map((c) => render(c, boxAuto, false, childOverrides, childPath ? `${childPath}/${gid(c.guid)}` : gid(c.guid))).join('');
    return `<div data-name="${name}" style="${s.join(';')}">${inner}</div>`;
  };

  const html = roots.map((r) => render(r, false, true, new Map(), '')).join('');
  if (images.n) warnings.push(`${images.n} image fill${images.n === 1 ? '' : 's'} can't travel through Figma's clipboard; they are grey placeholders. Paste images with Copy as PNG.`);
  if (!roots.length) warnings.push('Nothing to paste from that Figma selection.');
  return { html, warnings, layers };
}
