// Parity guard: the preview head must carry the published page's CSS in the
// published order. The built page (site-template BaseLayout) inlines Astro's
// reset.css + global.css at the end of <head>, after the site's custom CSS, so
// equal-specificity base rules there win. A preview that put custom CSS last
// showed different widths, fonts and line-heights than the live site.

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths, siteThemeCss, WEBFONT_FALLBACK_CSS, CONTENT_WELL_CSS } from '@typeroll/shared';
import type { Page, Site, SiteSettings, SiteVersion } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';
const templateCss = (name: string) =>
  readFileSync(new URL(`../../../../site-template/src/styles/${name}`, import.meta.url), 'utf8');

async function seedSite(settings: Partial<SiteSettings> = {}, page: Partial<Page> = {}): Promise<void> {
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), {
    name: 'Parity Site', created_at: new Date().toISOString(),
  } satisfies Partial<Site>);
  await getStore().setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
    name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false,
  } satisfies Partial<SiteVersion>);
  await getStore().setDoc(paths.settings(ORG, SITE, MAIN_VERSION_ID), settings);
  await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/home`, {
    id: 'home', title: 'Home', slug: 'home',
    content_mode: 'html', status: 'published',
    html_content: '<p>Hello</p>',
    ...page,
  } satisfies Page);
}

describe('renderPreview — head CSS parity with the published page', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('emits theme tokens, content well, site CSS, page CSS and then the template base CSS', async () => {
    const settings = {
      colors: { primary: '#123456', secondary: '#222', accent: '#333', background: '#fff', surface: '#eee', text: '#111', text_light: '#666' },
      fonts: { heading: 'Outfit', body: 'Inter', size_base: 16 },
      custom_css: ':root{--container-narrow:760px}',
    } satisfies Partial<SiteSettings>;
    await seedSite(settings, { custom_css: '.page-only{color:red}' });
    const { renderPreview } = await import('../../lib/render-preview');
    const html = (await renderPreview(ORG, SITE, 'home', MAIN_VERSION_ID))!;
    const head = html.slice(0, html.indexOf('</head>'));

    const order = [
      siteThemeCss(settings),
      CONTENT_WELL_CSS,
      WEBFONT_FALLBACK_CSS,
      settings.custom_css,
      '.page-only{color:red}',
      templateCss('reset.css'),
      templateCss('global.css'),
    ].map(css => head.indexOf(css));
    expect(order.every(index => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('does not emit a second, hand-maintained copy of the template base rules', async () => {
    await seedSite();
    const { renderPreview } = await import('../../lib/render-preview');
    const html = (await renderPreview(ORG, SITE, 'home', MAIN_VERSION_ID))!;
    expect(html.split('.tr-grid-prose-sidebar').length - 1).toBe(templateCss('global.css').split('.tr-grid-prose-sidebar').length - 1);
    expect(html).not.toContain('body{font-family:var(--font-body),-apple-system,BlinkMacSystemFont,sans-serif');
  });
});
