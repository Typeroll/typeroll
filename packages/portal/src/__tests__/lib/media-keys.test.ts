// Media R2 keys use an anonymous random per-SITE media_id, never the org/site
// name — the public CDN URL must not leak the customer and must survive a site
// moving between orgs. Key shape: media/{media_id}/{filename}.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { paths, type Site } from '@typeroll/shared';

const ORG = 'acme-agency-4';
const SITE = 'blog';

describe('siteMediaPrefix', () => {
  beforeEach(async () => { makeTmpFixtures(); await resetDatastore(); });

  it('randomMediaId is 10 chars of [0-9a-z]', async () => {
    const { randomMediaId } = await import('../../lib/media-keys');
    for (let i = 0; i < 50; i++) expect(randomMediaId()).toMatch(/^[0-9a-z]{10}$/);
    expect(randomMediaId()).not.toBe(randomMediaId()); // random
  });

  it('uses the site media_id (not org/site names) and the media/{id} shape', async () => {
    const { getStore } = await import('../../lib/datastore');
    const { siteMediaPrefix } = await import('../../lib/media-keys');
    await getStore().setDoc(paths.site(ORG, SITE), {
      name: 'Blog', media_id: 'abc123xyz0',
      created_at: new Date().toISOString(),
    } satisfies Partial<Site>);

    const prefix = await siteMediaPrefix(ORG, SITE);
    expect(prefix).toBe('media/abc123xyz0');
    expect(prefix).not.toContain(ORG);
    expect(prefix).not.toContain(SITE);
    expect(prefix).not.toContain('orgs/');
  });

  it('lazily backfills + persists a media_id for a site created before the field', async () => {
    const { getStore } = await import('../../lib/datastore');
    const { siteMediaPrefix } = await import('../../lib/media-keys');
    await getStore().setDoc(paths.site(ORG, SITE), {
      name: 'Blog', created_at: new Date().toISOString(),
    } satisfies Partial<Site>);

    const p1 = await siteMediaPrefix(ORG, SITE);
    expect(p1).toMatch(/^media\/[0-9a-z]{10}$/);

    const site = await getStore().getDoc<Site>(paths.site(ORG, SITE));
    expect(site?.media_id).toMatch(/^[0-9a-z]{10}$/);

    // stable on the next call (same id, not regenerated)
    expect(await siteMediaPrefix(ORG, SITE)).toBe(p1);
  });
});
