// Parity guard: the preview head must emit the same icon links as the
// static site's SEOHead.astro (favicon + apple-touch-icon). Discovered as
// drift — an agent set the icons via update_site_settings and the preview
// silently lacked them.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { Page, Site, SiteSettings, SiteVersion } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';

async function seedSite(settings: Partial<SiteSettings> = {}): Promise<void> {
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), {
    name: 'Icon Site', created_at: new Date().toISOString(),
  } satisfies Partial<Site>);
  await getStore().setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
    name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false,
  } satisfies Partial<SiteVersion>);
  await getStore().setDoc(paths.settings(ORG, SITE, MAIN_VERSION_ID), settings);
  await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/home`, {
    id: 'home', title: 'Home', slug: 'home',
    content_mode: 'html', status: 'published',
    html_content: '<p>Hello</p>',
  } satisfies Page);
}

describe('renderPreview — head icon links (SEOHead parity)', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('emits favicon, apple-touch and 192px icon links when set in settings', async () => {
    await seedSite({
      favicon: '/media/favicon.png',
      apple_touch_icon: '/media/apple-touch-icon.png',
      icon_192: '/media/icon-192.png',
    });
    const { renderPreview } = await import('../../lib/render-preview');
    const html = await renderPreview(ORG, SITE, 'home', MAIN_VERSION_ID);
    expect(html).toBeTruthy();
    expect(html!).toContain('<link rel="icon" href="/media/favicon.png" />');
    expect(html!).toContain(
      '<link rel="apple-touch-icon" sizes="180x180" href="/media/apple-touch-icon.png" />',
    );
    expect(html!).toContain('<link rel="icon" type="image/png" sizes="192x192" href="/media/icon-192.png" />');
  });

  it('omits icon links when not set', async () => {
    await seedSite();
    const { renderPreview } = await import('../../lib/render-preview');
    const html = await renderPreview(ORG, SITE, 'home', MAIN_VERSION_ID);
    expect(html).toBeTruthy();
    expect(html!).not.toContain('rel="icon"');
    expect(html!).not.toContain('rel="apple-touch-icon"');
  });
});
