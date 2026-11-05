import { beforeEach, describe, expect, it } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { Site, SiteVersion } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';
const BRANCH = 'settings-branch';

describe('content snapshot — branch settings', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
  });

  it('exports the version-aware consent settings consumed by the static builder', async () => {
    const { getStore } = await import('../../lib/datastore');
    const store = getStore();
    await store.setDoc(paths.site(ORG, SITE), {
      name: 'Branch site', created_at: new Date().toISOString(),
    } satisfies Partial<Site>);
    await store.setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
      name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false,
    } satisfies Partial<SiteVersion>);
    await store.setDoc(paths.version(ORG, SITE, BRANCH), {
      name: 'Branch', kind: 'branch', base_version_id: MAIN_VERSION_ID,
      created_at: new Date().toISOString(), robots_blocked: true,
    } satisfies Partial<SiteVersion>);
    await store.setDoc(paths.settings(ORG, SITE, MAIN_VERSION_ID), {
      language: 'en', cookie_consent: { enabled: false, text: 'Main copy' },
    });
    await store.setDoc(paths.settings(ORG, SITE, BRANCH), {
      language: 'en', cookie_consent: { enabled: true, text: 'Branch consent marker' },
    });

    const { contentSnapshot } = await import('../../lib/export');
    const snapshot = await contentSnapshot(store, ORG, SITE, BRANCH);
    const settings = snapshot.get(paths.settings(ORG, SITE, BRANCH)) as { cookie_consent?: { enabled?: boolean; text?: string } };
    expect(settings.cookie_consent).toEqual({ enabled: true, text: 'Branch consent marker' });
    expect(snapshot.get(paths.version(ORG, SITE, BRANCH))).toMatchObject({ kind: 'branch', robots_blocked: true });
    // Ids live in the document path, never in the exported data.
    expect(snapshot.get(paths.site(ORG, SITE))).not.toHaveProperty('id');
  });
});
