import type { APIRoute } from 'astro';
import { getAllPages, getBlockRegistry, getContentTypes, getPageTemplate, getPartials, getSiteSettings, isVersionRobotsBlocked, urlFor } from '../lib/content';
import { imageSitemapEntry, pageSitemapImages } from '../lib/image-sitemap';

export const GET: APIRoute = async ({ site }) => {
  const base = site ? site.toString().replace(/\/$/, '') : '';
  const settings = await getSiteSettings();
  const blocked = settings.sitewide_noindex || await isVersionRobotsBlocked();
  let entries = '';
  if (!blocked) {
    const [pages, types, registry, partials] = await Promise.all([
      getAllPages({ includeUnlisted: false }), getContentTypes(), getBlockRegistry(), getPartials(),
    ]);
    const templates = new Map<string, ReturnType<typeof getPageTemplate>>();
    for (const page of pages) {
      if (page.noindex) continue;
      const type = types.find(item => item.id === (page.content_type ?? 'page'))!;
      const loc = `${base}${urlFor(page, settings.trailing_slash)}`;
      if (page.template && !templates.has(page.template)) templates.set(page.template, getPageTemplate(page.template));
      const template = page.template ? await templates.get(page.template) : null;
      entries += imageSitemapEntry(loc, pageSitemapImages(page, {
        pageUrl: loc, contentType: type, registry, template: template?.blocks, partials: partials.freeBlocks,
      }));
    }
  }
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">${entries}</urlset>`, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
};
