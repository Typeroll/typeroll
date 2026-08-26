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

import { paths, MAIN_VERSION_ID } from '@typeroll/shared';
import { vstore } from '../version-store';
import type { Page, SiteSettings } from '@typeroll/shared';
import { defaultSiteSettings } from '@typeroll/shared';
import type { ReadWriteStore } from '../datastore';
import type { DesignContext } from './ai-reconstruct';

const MAX_EXAMPLE_PAGES = 3;

export async function loadDesignContext(
  store: ReadWriteStore,
  orgId: string,
  siteId: string
): Promise<DesignContext> {
  const settings =
    (await vstore.settings(orgId, siteId, MAIN_VERSION_ID)) ?? defaultSiteSettings;

  // Pick the published HTML-mode pages as design references. Skip pages that
  // are obviously placeholders ("Start writing…" boilerplate would mislead
  // the AI).
  const pages = await vstore.pages(orgId, siteId, MAIN_VERSION_ID);
  const examples = pages
    .filter(
      (p) =>
        p.content_mode === 'html' &&
        (p.status === 'published' || p.status === 'unlisted') &&
        typeof p.html_content === 'string' &&
        p.html_content.trim().length > 100 &&
        !p.html_content.includes('Start writing…')
    )
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
    .slice(0, MAX_EXAMPLE_PAGES)
    .map((p) => ({ title: p.title, html: p.html_content ?? '' }));

  return {
    site_name: settings.site_name,
    tagline: settings.tagline,
    colors: settings.colors as unknown as Record<string, string>,
    fonts: { heading: settings.fonts.heading, body: settings.fonts.body },
    example_pages: examples,
  };
}
