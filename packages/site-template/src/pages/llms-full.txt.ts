// llms-full.txt — the Markdown of every page llms.txt lists, in the same
// order, in one file. Capped at about 1 MB; pages past the cap are listed as
// links to their own Markdown files instead.

import type { APIRoute } from 'astro';
import { llmsFull } from '@typeroll/shared';
import { getAgentPages } from '../lib/agent-pages';

export const GET: APIRoute = async ({ site }) => {
  const base = site ? site.toString().replace(/\/$/, '') : '';
  const { settings, pages } = await getAgentPages();
  return new Response(llmsFull(settings, pages, base), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
