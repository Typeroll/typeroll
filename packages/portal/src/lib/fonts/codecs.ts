import zlib from 'node:zlib';
import type { FontCodecs } from '@typeroll/shared';

// node:zlib has Brotli and inflate in Node and in Workers (nodejs_compat).
// Kept free of other imports: the frozen publication runner copies it.

/** Decompression for reading WOFF and WOFF2 files. */
export const FONT_CODECS: FontCodecs = {
  brotliDecompress: data => new Uint8Array(zlib.brotliDecompressSync(data)),
  inflate: data => new Uint8Array(zlib.inflateSync(data)),
};

/** Brotli at the quality WOFF2 encoders use, for converting uploads. */
export function brotliCompress(data: Uint8Array): Uint8Array {
  return new Uint8Array(zlib.brotliCompressSync(data, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_FONT, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.byteLength },
  }));
}
