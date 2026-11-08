import { afterEach, expect, it, vi } from 'vitest';
import { S3Client } from '../../lib/net/s3';
import { createBuildMediaGrants } from '../../lib/publishing/r2-build-grants';
import { mediaReceiptKey } from '../../../../../scripts/fixtures/static-publication/media-receipt.mjs';

afterEach(() => vi.restoreAllMocks());

it('grants the exact completion receipt and keeps private preparation unpublished', async () => {
  const client = new S3Client({ region: 'auto', endpoint: 'https://example.r2.cloudflarestorage.com', forcePathStyle: true, credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' } });
  let grant: any;
  vi.spyOn(client, 'send').mockImplementation(async (command: any) => { grant = JSON.parse(command.input.Body.toString()); return {}; });
  const entry = { source_key: 'private/media/site/originals/a.png', public_key: 'media/site/a.png', public_path: '/a.png', sha256: 'a'.repeat(64), mime_type: 'image/png', aliases: [{ key: 'media/site/old.png', url: 'https://media.example.com/old.png' }] };
  const manifest = { account_id: 'a'.repeat(32), site_prefix: 'media/site', original_bucket: 'private', public_bucket: 'public', entries: [entry] };
  try {
    await createBuildMediaGrants(client, manifest, 'b'.repeat(64));
    const key = mediaReceiptKey(manifest, entry);
    expect(Object.keys(grant.objects).filter(key => key.includes('.prepared-v2.'))).toEqual([key]);
    expect(grant.objects[entry.public_key + '.v2.original.' + entry.sha256.slice(0, 16) + '.avif']).toBeDefined();
    expect(Object.keys(grant.prepared).some(key => key.endsWith('/original.avif'))).toBe(true);
    expect(Object.keys(grant.objects).some(key => key.includes('.v1.'))).toBe(false);
    expect(grant.objects[key].headers['if-none-match']).toBe('*');
    expect(new URL(grant.objects[key].get).pathname).toBe('/public/' + key);
    await createBuildMediaGrants(client, { ...manifest, cache_only: true }, 'b'.repeat(64));
    expect(grant.objects).toEqual({});
  } finally { client.destroy(); }
});

it('grants the exact share copy and receipt of a share image on a separate media host, and nothing on the website host', async () => {
  const client = new S3Client({ region: 'auto', endpoint: 'https://example.r2.cloudflarestorage.com', forcePathStyle: true, credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' } });
  let grant: any;
  vi.spyOn(client, 'send').mockImplementation(async (command: any) => { grant = JSON.parse(command.input.Body.toString()); return {}; });
  const entry = { source_key: 'private/media/site/originals/logo.svg', public_key: 'media/site/logo.svg', public_path: '/logo.svg', cdn_url: 'https://media.example.com/logo.svg',
    sha256: 'a'.repeat(64), mime_type: 'image/svg+xml', share_source: true, aliases: [{ key: 'media/site/old/logo.svg', url: 'https://media.shared.example/old/logo.svg' }] };
  const manifest = { delivery: 'r2', media_host: 'media.example.com', website_host: 'www.example.com', share_background: '#fbfaf6', account_id: 'a'.repeat(32), site_prefix: 'media/site', original_bucket: 'private', public_bucket: 'public', entries: [entry] };
  const suffix = `.share-s1.card.${'a'.repeat(16)}.fbfaf6.png`;
  try {
    await createBuildMediaGrants(client, manifest, 'b'.repeat(64));
    expect(Object.keys(grant.objects).filter(key => key.includes('.share-')).sort()).toEqual([
      entry.public_key + suffix, entry.public_key + suffix + '.receipt.json', 'media/site/old/logo.svg' + suffix].sort());
    expect(grant.objects[entry.public_key + suffix].headers).toMatchObject({ 'content-type': 'image/png', 'if-none-match': '*' });
    await createBuildMediaGrants(client, { ...manifest, delivery: 'static', media_host: 'www.example.com' }, 'b'.repeat(64));
    expect(Object.keys(grant.objects).some(key => key.includes('.share-'))).toBe(false);
  } finally { client.destroy(); }
});
