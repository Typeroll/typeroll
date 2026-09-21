// The old inline delete kept the bytes in the two cases that matter most:
// objects in an organization's own R2 (the normal case once a customer
// connects storage) and variants (up to a dozen per image). Both silently.
// These pin the enumeration and the ordering that replaced it.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Media } from '@typeroll/shared';
import { mediaObjects, variantKey } from '../../lib/media-deletion';

const organizationStorage = {
  provider: 'organization_r2' as const,
  account_id: 'a'.repeat(32),
  bucket: 'moveria-media',
  key: 'media/ab12cd34ef/hero.jpg',
  generation: '3',
  state: 'ready' as const,
  grant_expires_at: '',
};

function media(over: Partial<Media> = {}): Media {
  return { id: 'm1', filename: 'hero.jpg', cdn_url: 'https://cdn.typeroll.com/media/ab12cd34ef/hero.jpg', created_at: '', ...over };
}

describe('variantKey', () => {
  it('takes the path, which is the key the object was written under', () => {
    expect(variantKey('https://cdn.typeroll.com/media/ab12cd34ef/hero-800-abc.webp'))
      .toBe('media/ab12cd34ef/hero-800-abc.webp');
  });

  it('survives a custom media host', () => {
    expect(variantKey('https://media.moveria.se/media/ab12cd34ef/hero-800-abc.avif'))
      .toBe('media/ab12cd34ef/hero-800-abc.avif');
  });

  it('returns nothing for a malformed or absent url rather than inventing a key', () => {
    expect(variantKey(undefined)).toBeUndefined();
    expect(variantKey('not a url')).toBeUndefined();
    expect(variantKey('https://cdn.typeroll.com/')).toBeUndefined();
  });
});

describe('mediaObjects', () => {
  it('includes an object in organization storage — the case the old route skipped entirely', () => {
    const objects = mediaObjects(media({ storage: organizationStorage }));
    expect(objects).toHaveLength(1);
    expect(objects[0]).toMatchObject({ key: 'media/ab12cd34ef/hero.jpg', source: 'storage' });
    expect(objects[0]!.location?.bucket).toBe('moveria-media');
  });

  it('includes every variant, which the old route never touched', () => {
    const objects = mediaObjects(media({
      storage: organizationStorage,
      variants: [
        { width: 800, format: 'webp', cdn_url: 'https://cdn.typeroll.com/media/ab12cd34ef/hero-800.webp', size_bytes: 1 },
        { width: 800, format: 'avif', cdn_url: 'https://cdn.typeroll.com/media/ab12cd34ef/hero-800.avif', size_bytes: 1 },
        { width: 1600, format: 'webp', cdn_url: 'https://cdn.typeroll.com/media/ab12cd34ef/hero-1600.webp', size_bytes: 1 },
      ],
    }));
    expect(objects.filter((o) => o.source === 'variant')).toHaveLength(3);
    // Variants live beside their base object, so they go to the same bucket.
    expect(objects.every((o) => o.location?.bucket === 'moveria-media')).toBe(true);
  });

  it('routes a pre-storage object to the managed bucket via a null location', () => {
    const objects = mediaObjects(media({ r2_key: 'orgs/acme/sites/old/images/logo.png' }));
    expect(objects).toEqual([
      { key: 'orgs/acme/sites/old/images/logo.png', location: null, source: 'r2_key' },
    ]);
  });

  it('includes the pre-migration copy, which lives in a different bucket', () => {
    const objects = mediaObjects(media({
      storage: organizationStorage,
      migration_source: { provider: 'legacy_r2', account_id: 'b'.repeat(32), bucket: 'typeroll-managed', key: 'sites/old/hero.jpg' },
    }));
    const source = objects.find((o) => o.source === 'migration_source');
    expect(source?.key).toBe('sites/old/hero.jpg');
    expect(source?.location?.bucket).toBe('typeroll-managed');
  });

  it('does not delete the same key twice when r2_key mirrors storage.key', () => {
    const objects = mediaObjects(media({ storage: organizationStorage, r2_key: organizationStorage.key }));
    expect(objects).toHaveLength(1);
  });

  it('returns nothing for a record that points at no object', () => {
    expect(mediaObjects(media())).toEqual([]);
  });
});

describe('purgeSiteMedia ordering', () => {
  beforeEach(() => vi.resetModules());

  it('keeps the record when its objects survive, so the bytes stay findable', async () => {
    vi.doMock('../../lib/publishing/media-storage', () => ({
      storageClient: async () => ({ send: async () => { throw new Error('R2 unavailable'); } }),
    }));
    const { makeTmpFixtures, resetDatastore } = await import('../helpers/tmp-fixtures');
    makeTmpFixtures();
    await resetDatastore();
    const { paths } = await import('@typeroll/shared');
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(`${paths.media('acme', 's1')}/m1`, media({ storage: organizationStorage }));

    const { purgeSiteMedia } = await import('../../lib/media-deletion');
    const result = await purgeSiteMedia('acme', 's1');

    expect(result.records_removed).toBe(0);
    expect(result.records_retained).toBe(1);
    expect(result.failed[0]).toMatchObject({ media_id: 'm1', source: 'storage' });
    expect(await getStore().getDoc(`${paths.media('acme', 's1')}/m1`)).not.toBeNull();
  });

  it('removes the record once every object is gone', async () => {
    const sent: string[] = [];
    vi.doMock('../../lib/publishing/media-storage', () => ({
      storageClient: async () => ({ send: async (command: { input: { Key: string } }) => { sent.push(command.input.Key); } }),
    }));
    const { makeTmpFixtures, resetDatastore } = await import('../helpers/tmp-fixtures');
    makeTmpFixtures();
    await resetDatastore();
    const { paths } = await import('@typeroll/shared');
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(`${paths.media('acme', 's1')}/m1`, media({
      storage: organizationStorage,
      variants: [{ width: 800, format: 'webp', cdn_url: 'https://cdn.typeroll.com/media/ab12cd34ef/hero-800.webp', size_bytes: 1 }],
    }));

    const { purgeSiteMedia } = await import('../../lib/media-deletion');
    const result = await purgeSiteMedia('acme', 's1');

    expect(result.objects_deleted).toBe(2);
    expect(result.records_removed).toBe(1);
    expect(sent).toEqual(['media/ab12cd34ef/hero.jpg', 'media/ab12cd34ef/hero-800.webp']);
    expect(await getStore().getDoc(`${paths.media('acme', 's1')}/m1`)).toBeNull();
  });
});
