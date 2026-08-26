// llms.txt — the AEO (answer-engine optimization) counterpart of
// sitemap.xml, per the llmstxt.org convention: a markdown map of the site
// for AI assistants. Same visibility rules as the sitemap (published
// pages, noindex excluded), so a page hidden from Google is hidden from
// ChatGPT/Claude/Perplexity too.

import type { APIRoute } from 'astro';
import { getAllPages, getCollectionItemRoutes, getSiteSettings, urlFor } from '../lib/content';

export const GET: APIRoute = async ({ site }) => {
  const base = site ? site.toString().replace(/\/$/, '') : '';
  const settings = await getSiteSettings();
  const pages = await getAllPages({ includeUnlisted: false });

  const lines: string[] = [`# ${settings.site_name ?? 'Website'}`];
  const summary = settings.tagline || settings.default_meta_description;
  if (summary) lines.push('', `> ${String(summary).replace(/\s+/g, ' ').trim()}`);

  const pageRows = pages
    .filter((p) => !p.noindex)
    .map((p) => {
      const desc = (p.seo_description ?? '').replace(/\s+/g, ' ').trim();
      return `- [${p.title}](${base}${urlFor(p)})${desc ? `: ${desc}` : ''}`;
    });
  if (pageRows.length > 0) lines.push('', '## Pages', '', ...pageRows);

  const itemRoutes = await getCollectionItemRoutes();
  const itemRows = itemRoutes
    .filter(({ item }) => !(item as Record<string, unknown>).noindex)
    .map(({ path, item }) => {
      const withSlash = path === '/' || path.endsWith('/') ? path : `${path}/`;
      const title = String((item as Record<string, unknown>).title ?? item.id);
      return `- [${title}](${base}${withSlash})`;
    });
  if (itemRows.length > 0) lines.push('', '## Content', '', ...itemRows);

  return new Response(lines.join('\n') + '\n', {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
