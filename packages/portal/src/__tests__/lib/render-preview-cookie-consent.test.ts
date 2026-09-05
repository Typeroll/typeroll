import { beforeEach, describe, expect, it } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { Page, Site, SiteVersion } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';
const BRANCH = 'consent-branch';

async function seed(): Promise<void> {
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  const store = getStore();
  await store.setDoc(paths.site(ORG, SITE), {
    name: 'Consent preview', created_at: new Date().toISOString(),
  } satisfies Partial<Site>);
  await store.setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
    name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false,
  } satisfies Partial<SiteVersion>);
  await store.setDoc(paths.version(ORG, SITE, BRANCH), {
    name: 'Consent', kind: 'branch', base_version_id: MAIN_VERSION_ID,
    created_at: new Date().toISOString(), robots_blocked: true,
  } satisfies Partial<SiteVersion>);
  await store.setDoc(paths.settings(ORG, SITE, MAIN_VERSION_ID), {
    language: 'en',
  });
  await store.setDoc(paths.settings(ORG, SITE, BRANCH), {
    language: 'en',
    cookie_consent: {
      enabled: true,
      text: '<p>Branch consent marker</p>',
      privacy_policy_url: '/privacy/',
      scripts_optional: '<script>window.previewOptional=true</script>',
    },
  });
  await store.setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/home`, {
    id: 'home', title: 'Home', slug: '', content_mode: 'html', status: 'published',
    html_content: '<p>Hello</p>',
  } satisfies Page);
}

describe('renderPreview — branch cookie consent parity', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('renders branch consent and keeps optional scripts inert', async () => {
    await seed();
    const { renderPreview } = await import('../../lib/render-preview');
    const html = await renderPreview(ORG, SITE, 'home', BRANCH, {
      allowScripts: true,
      browseRoot: `/preview/${SITE}`,
      embedSuffix: '?t=test',
    });

    expect(html).toContain('Branch consent marker');
    expect(html).toContain('id="tr-consent"');
    expect(html).toContain('data-cookie-consent-early="1"');
    expect(html).toContain('type="text/plain" data-tr-consent="optional"');
    expect(html).toContain(`href="/preview/${SITE}/privacy/?t=test"`);
  });

  it('does not emit executable consent content in the script-disabled editor canvas', async () => {
    await seed();
    const { renderPreview } = await import('../../lib/render-preview');
    const html = await renderPreview(ORG, SITE, 'home', BRANCH, { allowScripts: false });
    expect(html).not.toContain('id="tr-consent"');
    expect(html).not.toContain('window.previewOptional');
  });
});
