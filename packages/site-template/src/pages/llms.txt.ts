// llms.txt — the AEO (answer-engine optimization) counterpart of
// sitemap.xml, per the llmstxt.org convention: a markdown map of the site
// for AI assistants. Same visibility rules as the sitemap (published,
// indexable pages; nothing on a robots-blocked version or a noindex site),
// so a page hidden from Google is hidden from ChatGPT/Claude/Perplexity too.
// Unlisted pages stay out.
//
// Pages are grouped by Content type, and each language section gets its own
// groups. Every page also has a Markdown rendition at `<path>index.md`.

import type { APIRoute } from 'astro';
import { llmsIndex } from '@typeroll/shared';
import { getAgentPages } from '../lib/agent-pages';

export const GET: APIRoute = async ({ site }) => {
  const base = site ? site.toString().replace(/\/$/, '') : '';
  const { settings, pages } = await getAgentPages();
  return new Response(llmsIndex(settings, pages, base), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
