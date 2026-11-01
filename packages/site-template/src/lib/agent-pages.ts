// Pages offered to AI agents through llms.txt, llms-full.txt and the per-page
// Markdown files. Same visibility as sitemap.xml: published, indexable pages
// only, and nothing at all on a robots-blocked version or a noindex site.
// Unlisted pages stay out, as they always have in llms.txt.

import { languageSectionFor, markdownPathFor, pageMarkdown, publicContentPage, type AgentPage, type SiteSettings } from '@typeroll/shared';
import { getAllPages, getContentTypes, getSiteSettings, isHomePage, isVersionRobotsBlocked, urlFor } from './content';

export { markdownPathFor, type AgentPage };

export async function getAgentPages(): Promise<{ settings: SiteSettings; pages: AgentPage[] }> {
  const settings = await getSiteSettings();
  if (settings.sitewide_noindex || await isVersionRobotsBlocked()) return { settings, pages: [] };
  const types = new Map((await getContentTypes()).map(type => [type.id, type]));
  const pages = (await getAllPages({ includeUnlisted: false }))
    .filter(page => page.status === 'published' && !page.noindex)
    .map(page => {
      const type = types.get(page.content_type ?? 'page');
      const path = urlFor(page, settings.trailing_slash);
      return {
        page: type ? publicContentPage(page, type) : page,
        type,
        path,
        markdownPath: markdownPathFor(isHomePage(page) ? '/' : path),
        section: languageSectionFor(settings.language_sections, page.language)?.language,
      };
    });
  return { settings, pages };
}

export function agentPageMarkdown(entry: AgentPage, base: string): string {
  return pageMarkdown(entry.page, { url: `${base}${entry.path}`, contentType: entry.type });
}
