// Media integrity at finalize (eval finding #20): a corrupted upload used
// to sail through finalize and get blessed with immutable cache headers —
// invisible until rendered. Now the stored bytes are hashed on every
// finalize (returned to the caller), an expected_sha256 mismatch throws
// MediaIntegrityError BEFORE cache headers are applied, and truncated SVGs
// are rejected outright.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { paths } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';

const PDF_BYTES = Buffer.from('%PDF-1.4 fake test payload');
const PDF_SHA = createHash('sha256').update(PDF_BYTES).digest('hex');

let storedBytes = PDF_BYTES;
const sent: string[] = [];

vi.mock('@aws-sdk/client-s3', () => {
  class GetObjectCommand { constructor(public input: unknown) {} }
  class CopyObjectCommand { constructor(public input: unknown) {} }
  class S3Client {
    async send(cmd: { constructor: { name: string } }) {
      sent.push(cmd.constructor.name);
      if (cmd.constructor.name === 'GetObjectCommand') {
        return { Body: { transformToByteArray: async () => new Uint8Array(storedBytes) } };
      }
      return {};
    }
  }
  return { S3Client, GetObjectCommand, CopyObjectCommand };
});

const CONFIG = {
  accountId: 'acc', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's',
  publicBase: 'https://cdn.example',
};

async function seedMedia(mime = 'application/pdf'): Promise<void> {
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(`${paths.media(ORG, SITE)}/m1`, {
    filename: 'a.pdf', mime_type: mime, r2_key: 'sites/x/a.pdf',
    cdn_url: 'https://cdn.example/a.pdf', created_at: new Date().toISOString(),
  });
}

describe('finalizeMedia integrity', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
    vi.resetModules();
    sent.length = 0;
    storedBytes = PDF_BYTES;
  });

  it('always returns the stored sha256 + size so callers can byte-verify', async () => {
    await seedMedia();
    const { finalizeMedia } = await import('../../lib/media-finalize');
    const result = await finalizeMedia(ORG, SITE, 'm1', CONFIG);
    expect(result.sha256).toBe(PDF_SHA);
    expect(result.size_bytes).toBe(PDF_BYTES.length);
    expect(sent).toContain('CopyObjectCommand');
  });

  it('expected_sha256 mismatch throws BEFORE cache headers are applied', async () => {
    await seedMedia();
    const { finalizeMedia, MediaIntegrityError } = await import('../../lib/media-finalize');
    await expect(
      finalizeMedia(ORG, SITE, 'm1', CONFIG, { expectedSha256: 'a'.repeat(64) }),
    ).rejects.toBeInstanceOf(MediaIntegrityError);
    expect(sent).not.toContain('CopyObjectCommand');
  });

  it('matching expected_sha256 passes (case-insensitive)', async () => {
    await seedMedia();
    const { finalizeMedia } = await import('../../lib/media-finalize');
    const result = await finalizeMedia(ORG, SITE, 'm1', CONFIG, {
      expectedSha256: PDF_SHA.toUpperCase(),
    });
    expect(result.sha256).toBe(PDF_SHA);
  });

  it('rejects a truncated SVG (the silently-corrupted-logo class)', async () => {
    await seedMedia('image/svg+xml');
    storedBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L10');
    const { finalizeMedia, MediaIntegrityError } = await import('../../lib/media-finalize');
    await expect(finalizeMedia(ORG, SITE, 'm1', CONFIG)).rejects.toBeInstanceOf(MediaIntegrityError);
    expect(sent).not.toContain('CopyObjectCommand');
  });
});

describe('svgLooksComplete', () => {
  it('accepts complete SVGs incl. trailing whitespace/newline', async () => {
    const { svgLooksComplete } = await import('../../lib/media-finalize');
    expect(svgLooksComplete(Buffer.from('<svg xmlns="x"><path/></svg>'))).toBe(true);
    expect(svgLooksComplete(Buffer.from('<?xml version="1.0"?>\n<svg>\n</svg>\n\n'))).toBe(true);
  });
  it('rejects truncation and non-SVG content', async () => {
    const { svgLooksComplete } = await import('../../lib/media-finalize');
    expect(svgLooksComplete(Buffer.from('<svg><path d="M0 0'))).toBe(false);
    expect(svgLooksComplete(Buffer.from('not an svg at all'))).toBe(false);
  });
});
