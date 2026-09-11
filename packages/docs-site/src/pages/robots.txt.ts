import type { APIRoute } from 'astro';
import { docsTarget } from '../../scripts/docs-target.mjs';

export const GET: APIRoute = () => new Response(
  `User-agent: *\nAllow: /\n\nSitemap: ${docsTarget().publicUrl}sitemap-index.xml\n`,
  { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
);
