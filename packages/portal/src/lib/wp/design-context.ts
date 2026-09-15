// Build a DesignContext from the target Typeroll site.
//
// The migration uses this as the AI's reference for the new design. The
// customer is expected to have already set up the target site — colors,
// fonts, header/footer partials, and ideally one or two example pages
// (home, about, services, anything) — BEFORE running the migration.
//
// If the target site is empty (just default settings, no pages), the AI
// still works but produces minimal generic markup — there's nothing to
// match. Document this in the migration UI ("set up your design first").

import { buildCoreBlockRegistry, composePageWithTemplate, renderBlocks, pageContentValues, createPageSource, MAIN_VERSION_ID } from '@typeroll/shared';
import { vstore } from '../version-store';
import { defaultSiteSettings } from '@typeroll/shared';
import type { DesignContext } from './ai-reconstruct';

const MAX_EXAMPLE_PAGES = 3;

export async function loadDesignContext(
  orgId: string,
  siteId: string,
  versionId: string = MAIN_VERSION_ID,
): Promise<DesignContext> {
  const settings =
    (await vstore.settings(orgId, siteId, versionId)) ?? defaultSiteSettings;

  const pages = await vstore.pages(orgId, siteId, versionId);
  const types = await vstore.contentTypes(orgId, siteId, versionId);
  const templates = await vstore.pageTemplates(orgId, siteId, versionId);
  const registry = buildCoreBlockRegistry();
  for (const type of await vstore.blockTypes(orgId, siteId, versionId)) registry.set(type.id, type);
  const pageSource = createPageSource(types, pages);
  const examples = pages
    .filter(page => page.status === 'published' || page.status === 'unlisted')
    .sort((a, b) => {
      // Prefer home > about > services > anything else. The home page is
      // usually the strongest design reference.
      const priority = (slug: string) => {
        if (slug === 'home' || slug === '' || slug === '/') return 0;
        if (slug.includes('about')) return 1;
        if (slug.includes('service') || slug.includes('what-we-do')) return 2;
        return 3;
      };
      return priority(a.slug) - priority(b.slug);
    })
    .map(page => {
      if (page.content_mode === 'html') return { title: page.title, html: page.html_content ?? '' };
      const type = types.find(type => type.id === (page.content_type ?? 'page'));
      const template = templates.find(template => template.id === (page.template || type?.template));
      const blocks = template ? composePageWithTemplate(template.blocks, page.blocks ?? []) : page.blocks ?? [];
      return { title: page.title, html: renderBlocks(blocks, { registry, pageSource, context: { page: pageContentValues(page), content_type: type as unknown as Record<string, unknown> } }) };
    })
    .filter(page => page.html.trim().length > 100 && !page.html.includes('Start writing…'))
    .slice(0, MAX_EXAMPLE_PAGES);

  return {
    site_name: settings.site_name,
    tagline: settings.tagline,
    colors: settings.colors as unknown as Record<string, string>,
    fonts: { heading: settings.fonts.heading, body: settings.fonts.body },
    example_pages: examples,
  };
}
