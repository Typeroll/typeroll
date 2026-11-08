/**
 * Font file reading and WOFF2 writing for uploaded fonts and self-hosted
 * webfonts.
 *
 * Pure functions over bytes, with the compression codecs passed in so the
 * module runs in browsers, Workers and Node alike (the portal passes
 * `node:zlib`). Reads TrueType/OpenType (sfnt), WOFF and WOFF2; writes WOFF2
 * with the null transform, which every WOFF2 decoder accepts. Only the tables
 * needed to name a font and match its fallback metrics are parsed.
 */

export interface FontCodecs {
  /** Brotli decompression (WOFF2). */
  brotliDecompress?: (data: Uint8Array) => Uint8Array;
  /** zlib inflate with header (WOFF). */
  inflate?: (data: Uint8Array) => Uint8Array;
}

export type FontFileFormat = 'woff2' | 'woff' | 'ttf' | 'otf';

/** Vertical and width metrics in font units, as needed for a metric-matched fallback. */
export interface FontMetrics {
  units_per_em: number;
  ascent: number;
  /** Negative or zero, as in the font. */
  descent: number;
  line_gap: number;
  /** Average advance of lowercase Latin text and spaces, weighted by letter frequency. */
  x_width_avg: number;
  cap_height?: number;
  x_height?: number;
}

export interface FontFileInfo {
  format: FontFileFormat;
  outlines: 'truetype' | 'cff';
  family: string;
  subfamily: string;
  /** usWeightClass (1–1000), clamped to 100–900. */
  weight: number;
  italic: boolean;
  /** Variation axes; `wght` is the weight range a variable file covers. */
  variable?: { axes: string[]; wght?: [number, number] };
  metrics: FontMetrics;
}

export class FontFileError extends Error {
  constructor(message: string, readonly code: 'font_unsupported' | 'font_invalid' | 'font_collection' = 'font_invalid') {
    super(message);
  }
}

const tagOf = (view: DataView, offset: number) => String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
const SFNT_TRUETYPE = 0x00010000;
const SFNT_CFF = 0x4f54544f; // 'OTTO'
const SFNT_APPLE = 0x74727565; // 'true'
const WOFF = 0x774f4646;
const WOFF2 = 0x774f4632;
const COLLECTION = 0x74746366; // 'ttcf'

/** The container a file uses, from its first four bytes; null when it is not a font. */
export function fontFileFormat(bytes: Uint8Array): FontFileFormat | null {
  if (bytes.byteLength < 12) return null;
  const signature = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  if (signature === WOFF2) return 'woff2';
  if (signature === WOFF) return 'woff';
  if (signature === SFNT_CFF) return 'otf';
  if (signature === SFNT_TRUETYPE || signature === SFNT_APPLE) return 'ttf';
  return null;
}

/** Tables of a font file by tag. A table WOFF2 stores transformed is absent. */
export interface FontTables { flavor: number; tables: Map<string, Uint8Array> }

/** Read the tables of a TrueType/OpenType, WOFF or WOFF2 file. */
export function readFontTables(bytes: Uint8Array, codecs: FontCodecs = {}): FontTables {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const format = fontFileFormat(bytes);
  if (!format) {
    if (bytes.byteLength >= 4 && view.getUint32(0) === COLLECTION) throw new FontFileError('Font collections (.ttc) are not supported; upload each font as its own file', 'font_collection');
    throw new FontFileError('The file is not a TrueType, OpenType, WOFF or WOFF2 font', 'font_unsupported');
  }
  try {
    if (format === 'woff2') return readWoff2(bytes, view, codecs);
    if (format === 'woff') return readWoff(bytes, view, codecs);
    return readSfnt(bytes, view);
  } catch (error) {
    if (error instanceof FontFileError) throw error;
    throw new FontFileError(`The font file is damaged (${error instanceof Error ? error.message : 'unreadable'})`);
  }
}

function readSfnt(bytes: Uint8Array, view: DataView): FontTables {
  const count = view.getUint16(4);
  if (12 + count * 16 > bytes.byteLength) throw new FontFileError('The font file is truncated');
  const tables = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    const record = 12 + i * 16;
    const offset = view.getUint32(record + 8), length = view.getUint32(record + 12);
    if (offset + length > bytes.byteLength) throw new FontFileError('The font file is truncated');
    tables.set(tagOf(view, record), bytes.subarray(offset, offset + length));
  }
  return { flavor: view.getUint32(0), tables };
}

function readWoff(bytes: Uint8Array, view: DataView, codecs: FontCodecs): FontTables {
  const count = view.getUint16(12);
  const tables = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    const record = 44 + i * 20;
    const offset = view.getUint32(record + 4), compressed = view.getUint32(record + 8), original = view.getUint32(record + 12);
    if (offset + compressed > bytes.byteLength) throw new FontFileError('The WOFF file is truncated');
    const data = bytes.subarray(offset, offset + compressed);
    if (compressed < original) {
      if (!codecs.inflate) throw new FontFileError('WOFF decompression is not available here', 'font_unsupported');
      const inflated = codecs.inflate(data);
      if (inflated.byteLength !== original) throw new FontFileError('A WOFF table has the wrong size');
      tables.set(tagOf(view, record), inflated);
    } else tables.set(tagOf(view, record), data);
  }
  return { flavor: view.getUint32(4), tables };
}

/** Known table tags of WOFF2 (spec section 5.1), by index. */
export const WOFF2_KNOWN_TAGS = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill'] as const;

function readBase128(view: DataView, cursor: { at: number }): number {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    const byte = view.getUint8(cursor.at++);
    if (i === 0 && byte === 0x80) throw new FontFileError('Invalid WOFF2 number');
    if (value & 0xfe000000) throw new FontFileError('Invalid WOFF2 number');
    value = (value << 7) | (byte & 0x7f);
    if (!(byte & 0x80)) return value >>> 0;
  }
  throw new FontFileError('Invalid WOFF2 number');
}

function readWoff2(bytes: Uint8Array, view: DataView, codecs: FontCodecs): FontTables {
  const flavor = view.getUint32(4);
  if (flavor === COLLECTION) throw new FontFileError('Font collections are not supported; upload each font as its own file', 'font_collection');
  const count = view.getUint16(12);
  const compressedSize = view.getUint32(20);
  const cursor = { at: 48 };
  const entries: Array<{ tag: string; length: number; transformed: boolean }> = [];
  for (let i = 0; i < count; i++) {
    const flags = view.getUint8(cursor.at++);
    const index = flags & 0x3f, version = flags >> 6;
    let tag: string;
    if (index === 63) { tag = tagOf(view, cursor.at); cursor.at += 4; } else tag = WOFF2_KNOWN_TAGS[index] ?? '';
    const original = readBase128(view, cursor);
    // glyf and loca: version 0 is the glyph transform, 3 the null transform. Other tables: 0 is null.
    const transformed = (tag === 'glyf' || tag === 'loca') ? version !== 3 : version !== 0;
    const length = transformed ? readBase128(view, cursor) : original;
    entries.push({ tag, length, transformed });
  }
  if (!codecs.brotliDecompress) throw new FontFileError('WOFF2 decompression is not available here', 'font_unsupported');
  if (cursor.at + compressedSize > bytes.byteLength) throw new FontFileError('The WOFF2 file is truncated');
  const stream = codecs.brotliDecompress(bytes.subarray(cursor.at, cursor.at + compressedSize));
  const tables = new Map<string, Uint8Array>();
  let offset = 0;
  for (const entry of entries) {
    if (offset + entry.length > stream.byteLength) throw new FontFileError('The WOFF2 data is truncated');
    if (!entry.transformed) tables.set(entry.tag, stream.subarray(offset, offset + entry.length));
    offset += entry.length;
  }
  return { flavor, tables };
}

const view = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength);

function utf16(data: Uint8Array): string {
  let out = '';
  for (let i = 0; i + 1 < data.byteLength; i += 2) out += String.fromCharCode((data[i] << 8) | data[i + 1]);
  return out;
}

/** Name table strings by name ID, preferring Windows English, then any Windows, then Mac Roman. */
export function fontNames(name: Uint8Array): Map<number, string> {
  const v = view(name);
  const count = v.getUint16(2), storage = v.getUint16(4);
  const best = new Map<number, { rank: number; value: string }>();
  for (let i = 0; i < count; i++) {
    const record = 6 + i * 12;
    if (record + 12 > name.byteLength) break;
    const platform = v.getUint16(record), encoding = v.getUint16(record + 2), language = v.getUint16(record + 4);
    const id = v.getUint16(record + 6), length = v.getUint16(record + 8), offset = storage + v.getUint16(record + 10);
    if (offset + length > name.byteLength) continue;
    const raw = name.subarray(offset, offset + length);
    let rank: number, value: string;
    if (platform === 3 && (encoding === 1 || encoding === 10)) { rank = language === 0x409 ? 0 : 1; value = utf16(raw); }
    else if (platform === 0) { rank = 2; value = utf16(raw); }
    else if (platform === 1 && encoding === 0) { rank = 3; value = String.fromCharCode(...raw); }
    else continue;
    const current = best.get(id);
    if (!current || rank < current.rank) best.set(id, { rank, value: value.replace(/\0/g, '').trim() });
  }
  return new Map([...best].map(([id, entry]) => [id, entry.value]));
}

/** Letter frequencies of English text (per mille) with the space, for an average text width. */
const WIDTH_WEIGHTS: ReadonlyArray<[string, number]> = [
  [' ', 180], ['e', 104], ['t', 75], ['a', 67], ['o', 62], ['i', 57], ['n', 55], ['s', 52], ['h', 50], ['r', 49],
  ['d', 35], ['l', 33], ['c', 23], ['u', 23], ['m', 20], ['w', 20], ['f', 18], ['g', 16], ['y', 16], ['p', 16],
  ['b', 12], ['v', 8], ['k', 6], ['j', 1], ['x', 1], ['q', 1], ['z', 1],
];

function glyphIndex(cmap: Uint8Array): ((code: number) => number) | null {
  const v = view(cmap);
  const count = v.getUint16(2);
  let format4 = -1, format12 = -1;
  for (let i = 0; i < count; i++) {
    const record = 4 + i * 8;
    const platform = v.getUint16(record), encoding = v.getUint16(record + 2), offset = v.getUint32(record + 4);
    if (offset + 4 > cmap.byteLength) continue;
    const format = v.getUint16(offset);
    if (format === 12 && (platform === 3 && encoding === 10 || platform === 0)) format12 = offset;
    if (format === 4 && (platform === 3 && (encoding === 1 || encoding === 0) || platform === 0)) format4 = offset;
  }
  if (format12 >= 0) {
    const groups = v.getUint32(format12 + 12);
    return code => {
      for (let g = 0; g < groups; g++) {
        const at = format12 + 16 + g * 12;
        const start = v.getUint32(at), end = v.getUint32(at + 4);
        if (code >= start && code <= end) return v.getUint32(at + 8) + code - start;
      }
      return 0;
    };
  }
  if (format4 >= 0) {
    const segments = v.getUint16(format4 + 6) / 2;
    const ends = format4 + 14, starts = ends + segments * 2 + 2, deltas = starts + segments * 2, ranges = deltas + segments * 2;
    return code => {
      for (let s = 0; s < segments; s++) {
        if (v.getUint16(ends + s * 2) < code) continue;
        const start = v.getUint16(starts + s * 2);
        if (start > code) return 0;
        const delta = v.getInt16(deltas + s * 2), rangeOffset = v.getUint16(ranges + s * 2);
        if (!rangeOffset) return (code + delta) & 0xffff;
        const glyph = v.getUint16(ranges + s * 2 + rangeOffset + (code - start) * 2);
        return glyph ? (glyph + delta) & 0xffff : 0;
      }
      return 0;
    };
  }
  return null;
}

function weightedWidth(tables: Map<string, Uint8Array>): number | null {
  const cmap = tables.get('cmap'), hmtx = tables.get('hmtx'), hhea = tables.get('hhea');
  if (!cmap || !hmtx || !hhea) return null;
  try {
    const lookup = glyphIndex(cmap);
    if (!lookup) return null;
    const metrics = view(hhea).getUint16(34);
    const h = view(hmtx);
    const advance = (glyph: number) => h.getUint16(Math.min(glyph, metrics - 1) * 4);
    let total = 0, weight = 0;
    for (const [char, frequency] of WIDTH_WEIGHTS) {
      const glyph = lookup(char.charCodeAt(0));
      if (!glyph) continue;
      total += advance(glyph) * frequency;
      weight += frequency;
    }
    return weight >= 900 ? total / weight : null;
  } catch { return null; }
}

/** Name, style, axes and metrics of a font from its tables. */
export function fontInfoFromTables(font: FontTables, format: FontFileFormat): FontFileInfo {
  const { tables } = font;
  const head = tables.get('head'), hhea = tables.get('hhea'), os2 = tables.get('OS/2'), name = tables.get('name');
  if (!head || !hhea || !name) throw new FontFileError('The font is missing required tables (head, hhea, name)');
  const outlines = tables.has('CFF ') || tables.has('CFF2') ? 'cff' : 'truetype';
  if (outlines === 'truetype' && !tables.has('glyf') && format !== 'woff2') throw new FontFileError('The font has no glyph outlines');
  const names = fontNames(name);
  const family = names.get(16) || names.get(1) || '';
  if (!family) throw new FontFileError('The font has no family name');
  const subfamily = names.get(17) || names.get(2) || 'Regular';
  const headView = view(head), hheaView = view(hhea);
  const unitsPerEm = headView.getUint16(18);
  if (unitsPerEm < 16 || unitsPerEm > 16384) throw new FontFileError('The font has an invalid units-per-em');
  const os = os2 && os2.byteLength >= 78 ? view(os2) : null;
  const useTypo = !!os && (os.getUint16(62) & 0x80) !== 0;
  const weightClass = os ? os.getUint16(4) : (headView.getUint16(44) & 1 ? 700 : 400);
  const italic = os ? (os.getUint16(62) & 1) !== 0 : (headView.getUint16(44) & 2) !== 0;
  const metrics: FontMetrics = {
    units_per_em: unitsPerEm,
    ascent: useTypo && os ? os.getInt16(68) : hheaView.getInt16(4),
    descent: useTypo && os ? os.getInt16(70) : hheaView.getInt16(6),
    line_gap: useTypo && os ? os.getInt16(72) : hheaView.getInt16(8),
    x_width_avg: Math.round(weightedWidth(tables) ?? (os ? os.getInt16(2) : unitsPerEm / 2)),
  };
  if (os && os.getUint16(0) >= 2 && os2!.byteLength >= 90) {
    metrics.x_height = os.getInt16(86);
    metrics.cap_height = os.getInt16(88);
  }
  const info: FontFileInfo = {
    format, outlines, family, subfamily,
    weight: Math.min(900, Math.max(100, weightClass || 400)),
    italic: italic || /italic|oblique/i.test(subfamily),
    metrics,
  };
  const fvar = tables.get('fvar');
  if (fvar && fvar.byteLength >= 16) {
    const f = view(fvar);
    const axesOffset = f.getUint16(4), axisCount = f.getUint16(8), axisSize = f.getUint16(10);
    const axes: string[] = [];
    let wght: [number, number] | undefined;
    for (let i = 0; i < axisCount; i++) {
      const at = axesOffset + i * axisSize;
      if (at + 20 > fvar.byteLength) break;
      const tag = tagOf(f, at);
      axes.push(tag);
      if (tag === 'wght') wght = [Math.round(f.getInt32(at + 4) / 65536), Math.round(f.getInt32(at + 12) / 65536)];
    }
    if (axes.length) info.variable = { axes, ...(wght ? { wght } : {}) };
  }
  return info;
}

/** Read a font file's name, style, axes and metrics. Throws FontFileError for anything that is not a usable font. */
export function readFontFile(bytes: Uint8Array, codecs: FontCodecs = {}): FontFileInfo {
  const format = fontFileFormat(bytes);
  const tables = readFontTables(bytes, codecs);
  return fontInfoFromTables(tables, format === 'ttf' && tables.flavor === SFNT_CFF ? 'otf' : format!);
}

function writeBase128(value: number, out: number[]) {
  const bytes: number[] = [];
  do { bytes.unshift(value & 0x7f); value >>>= 7; } while (value);
  for (let i = 0; i < bytes.length - 1; i++) bytes[i] |= 0x80;
  out.push(...bytes);
}

const pad4 = (n: number) => (n + 3) & ~3;

/**
 * Encode a TrueType/OpenType or WOFF font as WOFF2 with the null transform:
 * the tables are Brotli-compressed as one stream, unchanged. Browsers decode
 * it like any WOFF2 file.
 */
export function encodeWoff2(bytes: Uint8Array, brotliCompress: (data: Uint8Array) => Uint8Array, codecs: FontCodecs = {}): Uint8Array {
  const format = fontFileFormat(bytes);
  if (format === 'woff2') return bytes;
  const font = readFontTables(bytes, codecs);
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  const tags = [...font.tables.keys()].filter(tag => tag !== 'DSIG').sort(compare);
  const directory: number[] = [];
  const parts: Uint8Array[] = [];
  let streamLength = 0, sfntSize = 12 + tags.length * 16;
  for (const tag of tags) {
    const data = font.tables.get(tag)!;
    const known = (WOFF2_KNOWN_TAGS as readonly string[]).indexOf(tag);
    const transform = tag === 'glyf' || tag === 'loca' ? 3 : 0;
    directory.push((transform << 6) | (known >= 0 ? known : 63));
    if (known < 0) for (let i = 0; i < 4; i++) directory.push(tag.charCodeAt(i));
    writeBase128(data.byteLength, directory);
    parts.push(data);
    streamLength += data.byteLength;
    sfntSize += pad4(data.byteLength);
  }
  const stream = new Uint8Array(streamLength);
  let at = 0;
  for (const part of parts) { stream.set(part, at); at += part.byteLength; }
  const compressed = brotliCompress(stream);
  const total = pad4(48 + directory.length + compressed.byteLength);
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint32(0, WOFF2);
  v.setUint32(4, font.flavor === SFNT_APPLE ? SFNT_TRUETYPE : font.flavor);
  v.setUint32(8, total);
  v.setUint16(12, tags.length);
  v.setUint32(16, sfntSize);
  v.setUint32(20, compressed.byteLength);
  v.setUint16(24, 1);
  out.set(directory, 48);
  out.set(compressed, 48 + directory.length);
  return out;
}

/**
 * Reference metrics of the local fonts a fallback face is drawn with, read
 * with `readFontFile` from Arial and Times New Roman (Monotype, as shipped
 * with macOS and Windows).
 */
export const FALLBACK_REFERENCE_FONTS = {
  sans: { local: ['Arial', 'ArialMT'], units_per_em: 2048, x_width_avg: 905 },
  serif: { local: ['Times New Roman', 'TimesNewRomanPSMT'], units_per_em: 2048, x_width_avg: 820 },
} as const;

export interface FallbackOverrides {
  /** Local font the fallback face uses. */
  local: readonly string[];
  /** Percentages, e.g. 104.52. */
  size_adjust: number;
  ascent: number;
  descent: number;
  line_gap: number;
}

const percent = (value: number) => Math.round(value * 10000) / 100;

/**
 * `@font-face` overrides that make a local font take the same space as a
 * webfont while it loads: the average text width sets `size-adjust`, and the
 * vertical metrics are divided by it.
 */
export function fallbackOverrides(metrics: FontMetrics, kind: 'sans' | 'serif' = 'sans'): FallbackOverrides {
  const reference = FALLBACK_REFERENCE_FONTS[kind];
  const sizeAdjust = (metrics.x_width_avg / metrics.units_per_em) / (reference.x_width_avg / reference.units_per_em);
  return {
    local: reference.local,
    size_adjust: percent(sizeAdjust),
    ascent: percent(metrics.ascent / metrics.units_per_em / sizeAdjust),
    descent: percent(Math.abs(metrics.descent) / metrics.units_per_em / sizeAdjust),
    line_gap: percent(Math.max(0, metrics.line_gap) / metrics.units_per_em / sizeAdjust),
  };
}
