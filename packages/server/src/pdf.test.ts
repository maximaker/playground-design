import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jpegsToPdf, jpegSize } from './pdf.ts';

// The smallest JPEG header that names a size: SOI, then SOF0 for 2×3 pixels.
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x03, 0x00, 0x02, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xd9]);

test('reads JPEG size from the frame header', () => {
  assert.deepEqual(jpegSize(jpeg), { width: 2, height: 3 });
});

test('writes one PDF page per image, sized at 96 dpi, with a valid xref', () => {
  const pdf = jpegsToPdf([{ data: jpeg, width: 1920, height: 1080 }, { data: jpeg, width: 1920, height: 1080 }]);
  const text = new TextDecoder('latin1').decode(pdf);
  assert.ok(text.startsWith('%PDF-1.4'));
  assert.match(text, /\/Count 2/);
  assert.match(text, /\/MediaBox \[0 0 1440 810\]/);
  const xref = Number(/startxref\n(\d+)/.exec(text)![1]);
  assert.equal(text.slice(xref, xref + 4), 'xref');
  // Every xref entry points at the start of its object.
  const entries = text.slice(xref).split('\n').filter((l) => / n $/.test(l));
  entries.forEach((l, i) => assert.equal(text.slice(Number(l.slice(0, 10))).split('\n')[0], `${i + 1} 0 obj`));
});
