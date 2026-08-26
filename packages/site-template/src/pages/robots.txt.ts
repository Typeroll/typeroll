import type { APIRoute } from 'astro';
import { getSiteSettings, isVersionRobotsBlocked } from '../lib/content';
import { withSitemapLines } from '@typeroll/shared';

export const GET: APIRoute = async ({ site }) => {
  // Branches and any version explicitly flagged robots_blocked get a hard
  // Disallow regardless of the user-configured robots_txt — the version
  // setting always wins over content the customer typed in.
  if (await isVersionRobotsBlocked()) {
    return new Response(`User-agent: *\nDisallow: /\n`, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  const settings = await getSiteSettings();
  const base = site ? site.toString().replace(/\/$/, '') : '';
  const sitemap = base ? `${base}/sitemap.xml` : '/sitemap.xml';
  const imageSitemap = base ? `${base}/sitemap-images.xml` : '/sitemap-images.xml';

  const body = withSitemapLines(settings.robots_txt, [sitemap, imageSitemap]);

  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
