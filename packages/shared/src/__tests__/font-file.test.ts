import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { encodeWoff2, fallbackOverrides, FontFileError, fontFileFormat, readFontFile, readFontTables } from '../font-file.js';

const codecs = {
  brotliDecompress: (data: Uint8Array) => new Uint8Array(zlib.brotliDecompressSync(data)),
  inflate: (data: Uint8Array) => new Uint8Array(zlib.inflateSync(data)),
};
const brotli = (data: Uint8Array) => new Uint8Array(zlib.brotliCompressSync(data));

function table(size: number, write: (view: DataView, bytes: Uint8Array) => void): Uint8Array {
  const bytes = new Uint8Array(size);
  write(new DataView(bytes.buffer), bytes);
  return bytes;
}
const utf16 = (text: string) => { const out = new Uint8Array(text.length * 2); text.split('').forEach((c, i) => { out[i * 2] = c.charCodeAt(0) >> 8; out[i * 2 + 1] = c.charCodeAt(0) & 0xff; }); return out; };

/** A minimal TrueType font: "Test Sans" Semibold Italic, space 250 and letters 600 wide. */
function testFont(): Uint8Array {
  const family = utf16('Test Sans'), style = utf16('Semibold Italic');
  const tables: Record<string, Uint8Array> = {
    head: table(54, v => { v.setUint32(0, 0x00010000); v.setUint16(18, 1000); }),
    hhea: table(36, v => { v.setInt16(4, 800); v.setInt16(6, -200); v.setInt16(8, 0); v.setUint16(34, 3); }),
    'OS/2': table(96, v => { v.setUint16(0, 4); v.setInt16(2, 500); v.setUint16(4, 600); v.setUint16(62, 1); v.setInt16(86, 500); v.setInt16(88, 700); }),
    name: table(30 + family.length + style.length, (v, b) => {
      v.setUint16(2, 2); v.setUint16(4, 30);
      [[1, family.length, 0], [2, style.length, family.length]].forEach(([id, length, offset], i) => {
        const at = 6 + i * 12; v.setUint16(at, 3); v.setUint16(at + 2, 1); v.setUint16(at + 4, 0x409); v.setUint16(at + 6, id); v.setUint16(at + 8, length); v.setUint16(at + 10, offset);
      });
      b.set(family, 30); b.set(style, 30 + family.length);
    }),
    // Format 4: space → glyph 1, a–z → glyphs 2–27.
    cmap: table(12 + 16 + 4 * 2 * 3 + 2, v => {
      v.setUint16(2, 1); v.setUint16(4, 3); v.setUint16(6, 1); v.setUint32(8, 12);
      const s = 12, seg = 3; v.setUint16(s, 4); v.setUint16(s + 2, 16 + seg * 8); v.setUint16(s + 6, seg * 2);
      const ends = [0x20, 0x7a, 0xffff], starts = [0x20, 0x61, 0xffff], deltas = [1 - 0x20, 2 - 0x61, 1];
      ends.forEach((e, i) => v.setUint16(s + 14 + i * 2, e));
      starts.forEach((e, i) => v.setUint16(s + 16 + seg * 2 + i * 2, e));
      deltas.forEach((e, i) => v.setInt16(s + 16 + seg * 4 + i * 2, e));
    }),
    hmtx: table(12, v => { v.setUint16(0, 500); v.setUint16(4, 250); v.setUint16(8, 600); }),
    maxp: table(6, v => { v.setUint32(0, 0x00005000); v.setUint16(4, 28); }),
    glyf: new Uint8Array(4),
    loca: new Uint8Array(58),
    post: table(32, v => v.setUint32(0, 0x00030000)),
  };
  const tags = Object.keys(tables).sort();
  let offset = 12 + tags.length * 16;
  const size = tags.reduce((total, tag) => total + ((tables[tag].byteLength + 3) & ~3), offset);
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x00010000); v.setUint16(4, tags.length);
  tags.forEach((tag, i) => {
    const at = 12 + i * 16;
    for (let c = 0; c < 4; c++) out[at + c] = tag.charCodeAt(c);
    v.setUint32(at + 8, offset); v.setUint32(at + 12, tables[tag].byteLength);
    out.set(tables[tag], offset);
    offset += (tables[tag].byteLength + 3) & ~3;
  });
  return out;
}

/** The same font in a WOFF 1 container, every table deflated. */
function woff(sfnt: Uint8Array): Uint8Array {
  const { flavor, tables } = readFontTables(sfnt);
  const tags = [...tables.keys()];
  // A table that does not get smaller is stored as it is.
  const compressed = tags.map(tag => { const raw = tables.get(tag)!, packed = new Uint8Array(zlib.deflateSync(raw)); return packed.byteLength < raw.byteLength ? packed : raw; });
  let offset = 44 + tags.length * 20;
  const size = compressed.reduce((total, data) => total + ((data.byteLength + 3) & ~3), offset);
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x774f4646); v.setUint32(4, flavor); v.setUint32(8, size); v.setUint16(12, tags.length);
  tags.forEach((tag, i) => {
    const at = 44 + i * 20;
    for (let c = 0; c < 4; c++) out[at + c] = tag.charCodeAt(c);
    v.setUint32(at + 4, offset); v.setUint32(at + 8, compressed[i].byteLength); v.setUint32(at + 12, tables.get(tag)!.byteLength);
    out.set(compressed[i], offset);
    offset += (compressed[i].byteLength + 3) & ~3;
  });
  return out;
}

describe('readFontFile', () => {
  it('reads the family, style, weight and metrics of a TrueType font', () => {
    const info = readFontFile(testFont(), codecs);
    expect(info).toMatchObject({ format: 'ttf', outlines: 'truetype', family: 'Test Sans', subfamily: 'Semibold Italic', weight: 600, italic: true });
    expect(info.metrics).toMatchObject({ units_per_em: 1000, ascent: 800, descent: -200, line_gap: 0, x_height: 500, cap_height: 700 });
    // Space (250) weighs 180 of 1000; every letter is 600 wide.
    expect(info.metrics.x_width_avg).toBe(Math.round((250 * 180 + 600 * 820) / 1000));
  });

  it('reads WOFF and WOFF2 files', () => {
    const sfnt = testFont();
    const expected = { ...readFontFile(sfnt, codecs) };
    expect(readFontFile(woff(sfnt), codecs)).toEqual({ ...expected, format: 'woff' });
    expect(readFontFile(encodeWoff2(sfnt, brotli), codecs)).toEqual({ ...expected, format: 'woff2' });
  });

  it('reads a variable WOFF2 webfont and its weight axis', () => {
    const bytes = new Uint8Array(readFileSync(fileURLToPath(new URL('../../../docs-site/public/brand/fonts/fraunces-latin-normal.woff2', import.meta.url))));
    const info = readFontFile(bytes, codecs);
    expect(info.family).toBe('Fraunces');
    expect(info.variable).toEqual({ axes: ['opsz', 'wght'], wght: [100, 900] });
    expect(info.metrics.units_per_em).toBe(2000);
  });

  it('refuses files that are not single fonts', () => {
    expect(() => readFontFile(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toThrow(FontFileError);
    const collection = new Uint8Array(16); collection.set([0x74, 0x74, 0x63, 0x66]);
    expect(() => readFontFile(collection)).toThrow(/collections/);
    expect(fontFileFormat(new Uint8Array(4))).toBeNull();
    const truncated = testFont().subarray(0, 60);
    expect(() => readFontFile(truncated)).toThrow(FontFileError);
  });

  it('needs a codec to decompress', () => {
    expect(() => readFontFile(encodeWoff2(testFont(), brotli))).toThrow(/WOFF2 decompression/);
  });
});

describe('encodeWoff2', () => {
  it('stores every table unchanged under the null transform', () => {
    const sfnt = testFont();
    const encoded = encodeWoff2(sfnt, brotli);
    expect(fontFileFormat(encoded)).toBe('woff2');
    expect(encoded.byteLength % 4).toBe(0);
    expect(new DataView(encoded.buffer).getUint32(8)).toBe(encoded.byteLength);
    const original = readFontTables(sfnt).tables, decoded = readFontTables(encoded, codecs).tables;
    expect([...decoded.keys()].sort()).toEqual([...original.keys()].sort());
    for (const [tag, data] of original) expect(Buffer.from(decoded.get(tag)!).equals(Buffer.from(data)), tag).toBe(true);
    // glyf and loca use transform version 3 (null).
    const flags = [...encoded.subarray(48, 48 + 40)];
    expect(flags).toContain((3 << 6) | 10);
    expect(flags).toContain((3 << 6) | 11);
  });

  it('converts WOFF and leaves WOFF2 as it is', () => {
    const sfnt = testFont();
    const fromWoff = encodeWoff2(woff(sfnt), brotli, codecs);
    expect(readFontFile(fromWoff, codecs).family).toBe('Test Sans');
    const woff2 = encodeWoff2(sfnt, brotli);
    expect(encodeWoff2(woff2, brotli)).toBe(woff2);
  });
});

describe('fallbackOverrides', () => {
  it('matches Arial to itself', () => {
    expect(fallbackOverrides({ units_per_em: 2048, ascent: 1854, descent: -434, line_gap: 67, x_width_avg: 905 })).toEqual({
      local: ['Arial', 'ArialMT'], size_adjust: 100, ascent: 90.53, descent: 21.19, line_gap: 3.27,
    });
  });

  it('scales the vertical metrics by size-adjust', () => {
    const overrides = fallbackOverrides({ units_per_em: 1000, ascent: 900, descent: -250, line_gap: 0, x_width_avg: 486 }, 'serif');
    expect(overrides.local).toEqual(['Times New Roman', 'TimesNewRomanPSMT']);
    expect(overrides.size_adjust).toBeCloseTo(121.38, 1);
    expect(overrides.ascent).toBeCloseTo(90 / 1.2138, 1);
  });
});
