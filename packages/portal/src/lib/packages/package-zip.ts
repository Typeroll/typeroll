// Reading and writing Typeroll package files (`.typeroll`).
//
// A package is a zip with exactly these entries (see shared site-package.ts):
//   typeroll.json             the manifest
//   media/<sha256>.<ext>      media files
//   fonts/<sha256>.woff2      redistributable font files
//
// A package usually comes from someone else, so reading one treats it as
// hostile input. Before anything is parsed the zip size and the entry count
// are checked; every entry name must be on the whitelist above; each entry is
// decompressed as a stream that stops at its own cap (the manifest, a media
// file, a font file) and at the package total, so a zip bomb is refused
// without being expanded. The manifest is then checked with
// sitePackageErrors, and every file's sha256 must equal its integrity entry,
// with no file missing and none extra. Nothing is written anywhere while
// reading.

import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import {
  MAX_FONT_UPLOAD_BYTES, PACKAGE_LIMITS, SITE_PACKAGE_MANIFEST, sitePackageErrors,
  type SitePackage,
} from '@typeroll/shared';

export type PackageErrorCode =
  | 'package_invalid' | 'package_too_large' | 'package_unsafe' | 'package_integrity_failed'
  | 'package_selection_invalid' | 'package_conflict' | 'package_media_unavailable' | 'package_permission'
  | 'font_licence_required' | 'font_redistribution_unconfirmed' | 'package_source_unavailable'
  | 'package_download_expired' | 'package_import_partial' | 'package_options_invalid';

/** A refused package or request, with an HTTP status and a stable code. */
export class PackageError extends Error {
  constructor(message: string, readonly status: number, readonly code: PackageErrorCode, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'PackageError';
  }
}

export interface PackageFiles {
  manifest: SitePackage;
  /** Zip path (`media/…`, `fonts/…`) → bytes. The manifest is not in here. */
  files: Map<string, Uint8Array>;
}

const MEDIA_ENTRY = /^media\/[a-f0-9]{64}\.[a-z0-9]{2,5}$/;
const FONT_ENTRY = /^fonts\/[a-f0-9]{64}\.woff2$/;
const DIRECTORIES = new Set(['media/', 'fonts/']);

export const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function capFor(name: string): number {
  if (name === SITE_PACKAGE_MANIFEST) return PACKAGE_LIMITS.manifest_bytes;
  if (MEDIA_ENTRY.test(name)) return PACKAGE_LIMITS.media_bytes;
  if (FONT_ENTRY.test(name)) return MAX_FONT_UPLOAD_BYTES;
  return 0;
}

const unsafe = (name: string) => new PackageError(
  `The package contains "${name.slice(0, 120)}", which is not part of a Typeroll package. A package holds only ${SITE_PACKAGE_MANIFEST}, media/<sha256>.<ext> and fonts/<sha256>.woff2.`,
  400, 'package_unsafe',
);

/** Size the zip's central directory declares for an entry, when it is known. */
function declaredSize(entry: JSZip.JSZipObject): number | undefined {
  const size = (entry as unknown as { _data?: { uncompressedSize?: unknown } })._data?.uncompressedSize;
  return typeof size === 'number' && Number.isFinite(size) ? size : undefined;
}

interface Budget { left: number }

/** Decompress one entry, refusing as soon as it passes its cap or the package total. */
function readCapped(entry: JSZip.JSZipObject, cap: number, budget: Budget): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let done = false;
    const fail = (error: Error) => { if (!done) { done = true; reject(error); } };
    const stream = (entry as unknown as { internalStream(type: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array> }).internalStream('uint8array');
    stream
      .on('data', (chunk: Uint8Array) => {
        if (done) return;
        total += chunk.byteLength;
        budget.left -= chunk.byteLength;
        if (total > cap) { stream.pause(); fail(new PackageError(`${entry.name} is larger than ${cap} bytes`, 413, 'package_too_large')); return; }
        if (budget.left < 0) { stream.pause(); fail(new PackageError(`The package expands to more than ${PACKAGE_LIMITS.uncompressed_bytes} bytes`, 413, 'package_too_large')); return; }
        chunks.push(chunk);
      })
      .on('error', (error: Error) => fail(new PackageError(`${entry.name} could not be read: ${error.message}`, 400, 'package_invalid')))
      .on('end', () => {
        if (done) return;
        done = true;
        const out = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
        resolve(out);
      });
    stream.resume();
  });
}

/**
 * Read and verify a `.typeroll` file. Throws PackageError for anything that
 * is not a complete, intact package.
 */
export async function readSitePackageZip(bytes: Uint8Array): Promise<PackageFiles> {
  if (bytes.byteLength > PACKAGE_LIMITS.zip_bytes) throw new PackageError(`The package is larger than ${PACKAGE_LIMITS.zip_bytes / 1024 / 1024} MB`, 413, 'package_too_large');
  if (bytes.byteLength < 22) throw new PackageError('The file is not a Typeroll package (not a zip file)', 400, 'package_invalid');
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(bytes, { checkCRC32: true }); }
  catch (error) { throw new PackageError(`The file is not a Typeroll package: ${error instanceof Error ? error.message : 'unreadable zip'}`, 400, 'package_invalid'); }

  const entries = Object.values(zip.files);
  if (entries.length > PACKAGE_LIMITS.entries) throw new PackageError(`The package has ${entries.length} entries; at most ${PACKAGE_LIMITS.entries} are allowed`, 413, 'package_too_large');
  let declared = 0;
  for (const entry of entries) {
    if (entry.unsafeOriginalName && entry.unsafeOriginalName !== entry.name) throw unsafe(entry.unsafeOriginalName);
    if (entry.dir) { if (!DIRECTORIES.has(entry.name)) throw unsafe(entry.name); continue; }
    const cap = capFor(entry.name);
    if (!cap) throw unsafe(entry.name);
    const size = declaredSize(entry);
    if (size !== undefined) {
      if (size > cap) throw new PackageError(`${entry.name} is larger than ${cap} bytes`, 413, 'package_too_large');
      declared += size;
    }
  }
  if (declared > PACKAGE_LIMITS.uncompressed_bytes) throw new PackageError(`The package expands to more than ${PACKAGE_LIMITS.uncompressed_bytes} bytes`, 413, 'package_too_large');

  const manifestEntry = zip.file(SITE_PACKAGE_MANIFEST);
  if (!manifestEntry) throw new PackageError(`The package has no ${SITE_PACKAGE_MANIFEST}`, 400, 'package_invalid');
  const budget: Budget = { left: PACKAGE_LIMITS.uncompressed_bytes };
  const manifestBytes = await readCapped(manifestEntry, PACKAGE_LIMITS.manifest_bytes, budget);
  let manifest: unknown;
  try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)); }
  catch { throw new PackageError(`${SITE_PACKAGE_MANIFEST} is not valid JSON`, 400, 'package_invalid'); }
  const errors = sitePackageErrors(manifest);
  if (errors.length) throw new PackageError(`The package manifest is not valid: ${errors[0]}${errors.length > 1 ? ` (and ${errors.length - 1} more)` : ''}`, 422, 'package_invalid', { errors: errors.slice(0, 50) });
  const pkg = manifest as SitePackage;

  const integrity = pkg.integrity.files;
  const files = new Map<string, Uint8Array>();
  for (const entry of entries) {
    if (entry.dir || entry.name === SITE_PACKAGE_MANIFEST) continue;
    const expected = integrity[entry.name];
    if (!expected) throw new PackageError(`${entry.name} is not listed in the package's integrity list`, 422, 'package_integrity_failed');
    const content = await readCapped(entry, capFor(entry.name), budget);
    if (sha256Hex(content) !== expected) throw new PackageError(`${entry.name} does not match its sha256; the package was changed or damaged`, 422, 'package_integrity_failed');
    files.set(entry.name, content);
  }
  const missing = Object.keys(integrity).filter(path => !files.has(path));
  if (missing.length) throw new PackageError(`The package is missing ${missing.length} file${missing.length === 1 ? '' : 's'} its integrity list names (${missing[0]})`, 422, 'package_integrity_failed', { missing: missing.slice(0, 50) });
  for (const media of pkg.media) {
    if (files.get(media.path)!.byteLength !== media.bytes) throw new PackageError(`media ${media.id}: the file has ${files.get(media.path)!.byteLength} bytes, the manifest says ${media.bytes}`, 422, 'package_integrity_failed');
  }
  for (const font of pkg.fonts ?? []) {
    if (files.get(font.path)!.byteLength !== font.bytes) throw new PackageError(`font ${font.family}: the file has ${files.get(font.path)!.byteLength} bytes, the manifest says ${font.bytes}`, 422, 'package_integrity_failed');
  }
  return { manifest: pkg, files };
}

/** The integrity list for a set of files. */
export function packageIntegrity(files: ReadonlyMap<string, Uint8Array>): SitePackage['integrity'] {
  return { algorithm: 'sha256', files: Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, content]) => [path, sha256Hex(content)])) };
}

/**
 * Write a package. The manifest's integrity list must describe `files`
 * exactly (packageIntegrity builds it), so a signature over the manifest
 * covers every file.
 */
export async function writeSitePackageZip(manifest: SitePackage, files: ReadonlyMap<string, Uint8Array>): Promise<Uint8Array> {
  const expected = packageIntegrity(files).files;
  const listed = manifest.integrity?.files ?? {};
  const mismatch = [...new Set([...Object.keys(expected), ...Object.keys(listed)])].find(path => expected[path] !== listed[path]);
  if (mismatch) throw new PackageError(`The manifest's integrity list does not match ${mismatch}`, 500, 'package_integrity_failed');
  const zip = new JSZip();
  // A fixed date keeps the same package byte-identical when written again.
  const date = new Date(Date.UTC(2020, 0, 1));
  zip.file(SITE_PACKAGE_MANIFEST, JSON.stringify(manifest, null, 2), { date, compression: 'DEFLATE' });
  for (const [path, content] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    // Images, video and WOFF2 are compressed already.
    zip.file(path, content, { date, binary: true, compression: path.endsWith('.svg') ? 'DEFLATE' : 'STORE' });
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
