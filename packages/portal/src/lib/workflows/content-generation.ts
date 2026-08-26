// CONTENT_GENERATION workflow.
//
// On-demand: generate a new page from a topic prompt. Useful both as a
// user-triggered action ("write a page about X") and as a sub-step of
// other workflows (filling a keyword gap, etc.). The output is saved as a
// draft for review.

import { paths, slugify , MAIN_VERSION_ID } from '@typeroll/shared';
import { vstore } from '../version-store';
import type { Page, SiteSettings } from '@typeroll/shared';
import { type WorkflowDef } from './types';
import { generateText } from '../ai/claude';

export const contentGenerationWorkflow: WorkflowDef = {
  type: 'content_generation',
  label: 'Generate page',
  description: 'AI writes a new page on a topic, saved as a draft for review.',
  steps: [
    {
      name: 'generate',
      label: 'Write the page',
      async run(ctx) {
        const topic = String(ctx.config.topic ?? '').trim();
        if (!topic) throw new Error('Missing topic in config');
        const tone = String(ctx.config.tone ?? 'professional, friendly');
        const audience = String(ctx.config.audience ?? 'general readers');

        const settings = await vstore.settings(ctx.orgId, ctx.siteId, MAIN_VERSION_ID);
        const siteName = settings?.site_name ?? 'this site';
        ctx.log(`Generating "${topic}" for ${siteName}…`);

        const html = await generateText(
          ctx.orgId,
          `You are a writer producing a single web page for "${siteName}". Output HTML body only (no <html>/<body>, no markdown fences). Use semantic tags (h1, h2, p, ul). The site has these CSS variables you can use inline: var(--color-primary), var(--color-accent), var(--spacing-md), var(--spacing-lg). Write for ${audience} in a ${tone} tone. Be specific — no filler.`,
          `Topic: ${topic}\n\nWrite the page. Include a clear H1, scannable structure, and at least one call to action when relevant.`
        );

        const title = extractTitle(html, topic);
        const slug = slugify(title) || `page-${Date.now()}`;
        const doc: Omit<Page, 'id'> = {
          title,
          slug,
          content_mode: 'html',
          html_content: stripFences(html),
          status: 'draft',
          ai_generated: true,
          date_updated: new Date().toISOString(),
        };
        const pageId = slug;
        await ctx.store.setDoc(`${paths.pages(ctx.orgId, ctx.siteId)}/${pageId}`, doc);
        ctx.log(`Saved draft at /${slug}`);
        return { results: { page_id: pageId, slug, title } };
      },
    },
  ],
};

function extractTitle(html: string, fallback: string): string {
  const m = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (m) return m[1].replace(/<[^>]+>/g, '').trim() || fallback;
  return fallback;
}

function stripFences(s: string): string {
  return s.replace(/^```(?:html)?\s*\n/, '').replace(/\n```\s*$/, '').trim();
}
