/**
 * A PDF of JPEG pages, one image per page, sized to the image.
 *
 * A deck exported as PDF is a stack of pictures of its slides, and PDF can
 * carry a JPEG as-is (DCTDecode), so this writes the file by hand rather than
 * pulling in a PDF library for the one thing it needs.
 */

/** Width and height from a JPEG's SOF marker. */
export function jpegSize(data: Uint8Array): { width: number; height: number } {
  let i = 2;
  while (i < data.length) {
    if (data[i] !== 0xff) { i++; continue; }
    const marker = data[i + 1]!;
    const len = (data[i + 2]! << 8) | data[i + 3]!;
    // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: (data[i + 5]! << 8) | data[i + 6]!, width: (data[i + 7]! << 8) | data[i + 8]! };
    }
    i += 2 + len;
  }
  throw new Error('Not a JPEG: no frame header found.');
}

/**
 * Pages are sized in points at 96 px per inch, so a 1920×1080 slide rendered
 * at 1× is a 1440×810 pt page; a higher-scale render is the same page, sharper.
 */
export function jpegsToPdf(pages: { data: Uint8Array; width: number; height: number }[]): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (part: string | Uint8Array) => {
    const bytes = typeof part === 'string' ? enc.encode(part) : part;
    chunks.push(bytes);
    length += bytes.length;
  };
  const object = (n: number, body: () => void) => {
    offsets[n] = length;
    push(`${n} 0 obj\n`);
    body();
    push('\nendobj\n');
  };

  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  // 1 catalog, 2 page tree, then three objects per page: page, image, content.
  const pageIds = pages.map((_, i) => 3 + i * 3);
  object(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
  object(2, () => push(`<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`));

  pages.forEach((p, i) => {
    const [pageId, imageId, contentId] = [pageIds[i]!, pageIds[i]! + 1, pageIds[i]! + 2];
    const { width: px, height: py } = jpegSize(p.data);
    const w = +(p.width * 0.75).toFixed(2);
    const h = +(p.height * 0.75).toFixed(2);
    object(pageId, () => push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] `
      + `/Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    ));
    object(imageId, () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${px} /Height ${py} /ColorSpace /DeviceRGB `
        + `/BitsPerComponent 8 /Filter /DCTDecode /Length ${p.data.length} >>\nstream\n`);
      push(p.data);
      push('\nendstream');
    });
    const draw = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
    object(contentId, () => push(`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`));
  });

  const xref = length;
  const count = 3 + pages.length * 3;
  push(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let n = 1; n < count; n++) push(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}
