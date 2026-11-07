// Font files for tests, built in memory or read from the repository: no network.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function table(size: number, write: (view: DataView, bytes: Uint8Array) => void): Uint8Array {
  const bytes = new Uint8Array(size);
  write(new DataView(bytes.buffer), bytes);
  return bytes;
}
const utf16 = (text: string) => { const out = new Uint8Array(text.length * 2); text.split('').forEach((c, i) => { out[i * 2] = c.charCodeAt(0) >> 8; out[i * 2 + 1] = c.charCodeAt(0) & 0xff; }); return out; };

/**
 * A minimal static TrueType font (the shape the shared font-file tests use):
 * `family` in style `subfamily`, usWeightClass `weight`, italic when asked.
 */
export function testTrueTypeFont(options: { family?: string; subfamily?: string; weight?: number; italic?: boolean } = {}): Uint8Array {
  const family = utf16(options.family ?? 'Test Sans'), style = utf16(options.subfamily ?? 'Semibold Italic');
  const tables: Record<string, Uint8Array> = {
    head: table(54, v => { v.setUint32(0, 0x00010000); v.setUint16(18, 1000); }),
    hhea: table(36, v => { v.setInt16(4, 800); v.setInt16(6, -200); v.setInt16(8, 0); v.setUint16(34, 3); }),
    'OS/2': table(96, v => { v.setUint16(0, 4); v.setInt16(2, 500); v.setUint16(4, options.weight ?? 600); v.setUint16(62, options.italic === false ? 0 : 1); v.setInt16(86, 500); v.setInt16(88, 700); }),
    name: table(30 + family.length + style.length, (v, b) => {
      v.setUint16(2, 2); v.setUint16(4, 30);
      [[1, family.length, 0], [2, style.length, family.length]].forEach(([id, length, offset], i) => {
        const at = 6 + i * 12; v.setUint16(at, 3); v.setUint16(at + 2, 1); v.setUint16(at + 4, 0x409); v.setUint16(at + 6, id); v.setUint16(at + 8, length); v.setUint16(at + 10, offset);
      });
      b.set(family, 30); b.set(style, 30 + family.length);
    }),
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
  const size = tags.reduce((total, tag) => total + ((tables[tag]!.byteLength + 3) & ~3), offset);
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x00010000); v.setUint16(4, tags.length);
  tags.forEach((tag, i) => {
    const at = 12 + i * 16;
    for (let c = 0; c < 4; c++) out[at + c] = tag.charCodeAt(c);
    v.setUint32(at + 8, offset); v.setUint32(at + 12, tables[tag]!.byteLength);
    out.set(tables[tag]!, offset);
    offset += (tables[tag]!.byteLength + 3) & ~3;
  });
  return out;
}

/** Fraunces (SIL OFL), a variable WOFF2 webfont with a 100–900 weight axis, from the docs site. */
export function variableWoff2Font(): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL('../../../../docs-site/public/brand/fonts/fraunces-latin-normal.woff2', import.meta.url))));
}
