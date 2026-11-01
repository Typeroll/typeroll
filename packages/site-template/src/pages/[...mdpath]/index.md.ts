// Markdown rendition of each indexable page at `<page path>index.md`, for AI
// agents. Announced from the page head and listed in llms.txt.

import type { APIRoute, GetStaticPaths } from 'astro';
import { agentPageMarkdown, getAgentPages, type AgentPage } from '../../lib/agent-pages';

export const getStaticPaths: GetStaticPaths = async () => {
  const { pages } = await getAgentPages();
  return pages.map(entry => ({
    params: { mdpath: entry.markdownPath.replace(/^\/+/, '').replace(/\/?index\.md$/, '') || undefined },
    props: { entry },
  }));
};

export const GET: APIRoute = async ({ props, site }) => {
  const base = site ? site.toString().replace(/\/$/, '') : '';
  return new Response(agentPageMarkdown((props as { entry: AgentPage }).entry, base), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
};
