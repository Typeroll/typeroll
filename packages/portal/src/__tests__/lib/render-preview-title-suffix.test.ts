// Parity guard: the preview <title> must be composed the same way as the
// static site's SEOHead.astro — (seo_title || title) + default_seo_suffix,
// skipping the suffix when the base already ends with it. Discovered as
// drift — an agent set default_seo_suffix via update_site_settings, checked
// the preview, saw no suffix, and nearly concluded the setting was broken.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { Page, Site, SiteSettings, SiteVersion } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';

async function seedSite(
  settings: Partial<SiteSettings>,
  pageFields: Partial<Page> = {},
): Promise<void> {
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), {
    name: 'Title Site', created_at: new Date().toISOString(),
  } satisfies Partial<Site>);
  await getStore().setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
    name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false,
  } satisfies Partial<SiteVersion>);
  await getStore().setDoc(paths.settings(ORG, SITE, MAIN_VERSION_ID), settings);
  await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/home`, {
    id: 'home', title: 'Home', slug: 'home',
    content_mode: 'html', status: 'published',
    html_content: '<p>Hello</p>',
    ...pageFields,
  } satisfies Page);
}

async function previewTitle(): Promise<string> {
  const { renderPreview } = await import('../../lib/render-preview');
  const html = await renderPreview(ORG, SITE, 'home', MAIN_VERSION_ID);
  expect(html).toBeTruthy();
  const m = html!.match(/<title>([^<]*)<\/title>/);
  expect(m).toBeTruthy();
  return m![1];
}

async function previewMetaDescription(): Promise<string> {
  const { renderPreview } = await import('../../lib/render-preview');
  const html = await renderPreview(ORG, SITE, 'home', MAIN_VERSION_ID);
  expect(html).toBeTruthy();
  const m = html!.match(/<meta name="description" content="([^"]*)"/);
  expect(m).toBeTruthy();
  return m![1];
}

describe('renderPreview — <title> suffix (SEOHead parity)', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('appends default_seo_suffix to the page title', async () => {
    await seedSite({ default_seo_suffix: ' — Acme Inc' });
    expect(await previewTitle()).toBe('Home — Acme Inc');
  });

  it('prefers seo_title over title as the base, then appends the suffix', async () => {
    await seedSite({ default_seo_suffix: ' — Acme Inc' }, { seo_title: 'Welcome Home' });
    expect(await previewTitle()).toBe('Welcome Home — Acme Inc');
  });

  it('does not double-append when the base already ends with the suffix', async () => {
    await seedSite({ default_seo_suffix: ' — Acme Inc' }, { seo_title: 'Home — Acme Inc' });
    expect(await previewTitle()).toBe('Home — Acme Inc');
  });

  it('emits the bare title when no suffix is configured', async () => {
    await seedSite({});
    expect(await previewTitle()).toBe('Home');
  });
});

describe('renderPreview — meta description fallback chain (SEOHead parity)', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('prefers the page seo_description', async () => {
    await seedSite(
      { default_meta_description: 'Site fallback.', tagline: 'Tagline.' },
      { seo_description: 'Page-specific description.' },
    );
    expect(await previewMetaDescription()).toBe('Page-specific description.');
  });

  it('falls back to default_meta_description when the page has none', async () => {
    await seedSite({ default_meta_description: 'Site fallback.', tagline: 'Tagline.' });
    expect(await previewMetaDescription()).toBe('Site fallback.');
  });

  it('falls back to the tagline when neither is set', async () => {
    await seedSite({ tagline: 'Tagline.' });
    expect(await previewMetaDescription()).toBe('Tagline.');
  });
});
