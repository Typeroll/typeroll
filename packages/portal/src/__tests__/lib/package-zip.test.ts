// Reading and writing .typeroll files: a round trip keeps every byte, and a
// package that is damaged, changed, oversized, a zip bomb or carries files
// outside the whitelist is refused before anything is used. Offline.

import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import { PACKAGE_LIMITS, type SitePackage } from '@typeroll/shared';
import { packageIntegrity, readSitePackageZip, writeSitePackageZip } from '../../lib/packages/package-zip';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);
const imagePath = `media/${sha(image)}.png`;

function manifest(files: Map<string, Uint8Array>, overrides: Partial<SitePackage> = {}): SitePackage {
  return {
    format: 'typeroll-package', format_version: 1, kind: 'collection', id: 'acme', name: 'Acme', version: '1.0.0', created_at: '2026-11-07T10:00:00Z',
    contents: { block_templates: [{ id: 'hero', name: 'Hero', blocks: [{ id: 'a', type: 'core/image', data: { src: 'typeroll-media:photo' } }] }] },
    media: [{ id: 'photo', path: imagePath, sha256: sha(image), bytes: image.byteLength, content_type: 'image/png', filename: 'photo.png' }],
    integrity: packageIntegrity(files), ...overrides,
  };
}

async function rawZip(entries: Record<string, Uint8Array | string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) zip.file(name, content);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

describe('package zip', () => {
  it('round-trips the manifest and files, byte for byte', async () => {
    const files = new Map([[imagePath, image]]);
    const written = await writeSitePackageZip(manifest(files), files);
    const read = await readSitePackageZip(written);
    expect(read.manifest.id).toBe('acme');
    expect([...read.files.keys()]).toEqual([imagePath]);
    expect(Buffer.from(read.files.get(imagePath)!).equals(Buffer.from(image))).toBe(true);
    // Writing the same package again gives the same bytes.
    expect(sha(await writeSitePackageZip(manifest(files), files))).toBe(sha(written));
  });

  it('refuses a file that does not match its sha256, a missing file and an extra file', async () => {
    const files = new Map([[imagePath, image]]);
    const changed = await rawZip({ 'typeroll.json': JSON.stringify(manifest(files)), [imagePath]: new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 9]) });
    await expect(readSitePackageZip(changed)).rejects.toMatchObject({ code: 'package_integrity_failed' });
    const missing = await rawZip({ 'typeroll.json': JSON.stringify(manifest(files)) });
    await expect(readSitePackageZip(missing)).rejects.toMatchObject({ code: 'package_integrity_failed' });
    const other = new Uint8Array([7, 7, 7]);
    const extra = await rawZip({ 'typeroll.json': JSON.stringify(manifest(files)), [imagePath]: image, [`media/${sha(other)}.png`]: other });
    await expect(readSitePackageZip(extra)).rejects.toMatchObject({ code: 'package_integrity_failed' });
    await expect(writeSitePackageZip(manifest(new Map()), files)).rejects.toMatchObject({ code: 'package_integrity_failed' });
  });

  it('refuses paths outside the whitelist, traversal and a missing or invalid manifest', async () => {
    const files = new Map([[imagePath, image]]);
    for (const name of ['../evil.txt', 'scripts/run.js', '__MACOSX/._typeroll.json', 'media/photo.png']) {
      const zip = await rawZip({ 'typeroll.json': JSON.stringify(manifest(files)), [imagePath]: image, [name]: 'x' });
      await expect(readSitePackageZip(zip), name).rejects.toMatchObject({ code: 'package_unsafe' });
    }
    await expect(readSitePackageZip(await rawZip({ [imagePath]: image }))).rejects.toMatchObject({ code: 'package_invalid' });
    await expect(readSitePackageZip(await rawZip({ 'typeroll.json': '{nope' }))).rejects.toMatchObject({ code: 'package_invalid' });
    const invalid = await rawZip({ 'typeroll.json': JSON.stringify({ ...manifest(files), format_version: 9 }), [imagePath]: image });
    await expect(readSitePackageZip(invalid)).rejects.toMatchObject({ status: 422, code: 'package_invalid', details: { errors: [expect.stringMatching(/not supported/)] } });
    await expect(readSitePackageZip(new TextEncoder().encode('not a zip at all, just some text'))).rejects.toMatchObject({ code: 'package_invalid' });
  });

  it('stops a zip bomb at the per-file cap without expanding it', async () => {
    // 60 MB of zeros compresses to about 60 KB; a media file may be 50 MB.
    const bomb = new Uint8Array(PACKAGE_LIMITS.media_bytes + 10 * 1024 * 1024);
    const path = `media/${'0'.repeat(64)}.png`;
    const zip = await rawZip({ 'typeroll.json': JSON.stringify(manifest(new Map([[path, bomb]]), { media: [] })), [path]: bomb });
    expect(zip.byteLength).toBeLessThan(1024 * 1024);
    await expect(readSitePackageZip(zip)).rejects.toMatchObject({ status: 413, code: 'package_too_large' });
  });

  it('refuses an oversized file and too many entries before reading', async () => {
    await expect(readSitePackageZip(new Uint8Array(PACKAGE_LIMITS.zip_bytes + 1))).rejects.toMatchObject({ code: 'package_too_large' });
    const many: Record<string, string> = { 'typeroll.json': '{}' };
    for (let index = 0; index <= PACKAGE_LIMITS.entries; index++) many[`media/${index.toString(16).padStart(64, '0')}.png`] = '';
    await expect(readSitePackageZip(await rawZip(many))).rejects.toMatchObject({ code: 'package_too_large' });
  });
});
