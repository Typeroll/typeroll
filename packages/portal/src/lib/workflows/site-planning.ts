// SITE_PLANNING workflow.
//
// User describes their business → AI proposes a site structure with target
// keywords per page → review → AI generates content for each page → review
// → publish.
//
// Keyword research uses DataForSEO when configured; otherwise we fall back
// to AI-only keyword brainstorming (less authoritative but still useful).

import { paths, slugify } from '@typeroll/shared';
import type { Page } from '@typeroll/shared';
import { reviewGate, type WorkflowDef } from './types';
import { generateJson, generateText } from '../ai/claude';

interface PlannedPage {
  title: string;
  slug: string;
  description: string;
  target_keywords: string[];
  page_type: 'home' | 'about' | 'services' | 'product' | 'contact' | 'blog' | 'other';
}

export const sitePlanningWorkflow: WorkflowDef = {
  type: 'site_planning',
  label: 'Plan a new site',
  description: 'Describe a business; AI proposes a site structure and writes content for each page.',
  steps: [
    {
      name: 'propose_structure',
      label: 'Propose site structure',
      async run(ctx) {
        const business = String(ctx.config.business_description ?? '').trim();
        if (!business) throw new Error('Missing business_description in config');

        const system = `You are an expert at planning small-business websites. Given a business description, propose a complete site structure with target SEO keywords per page. Pages should be the minimum set needed — home, about, services/products, contact, plus 1-3 supporting pages.

Respond with JSON of the shape:
{
  "site_name": string,
  "tagline": string,
  "pages": [{ "title": string, "slug": string, "description": string, "target_keywords": [string], "page_type": "home"|"about"|"services"|"product"|"contact"|"blog"|"other" }]
}`;

        const proposal = await generateJson<{
          site_name: string;
          tagline: string;
          pages: PlannedPage[];
        }>(ctx.orgId, system, `Business description:\n${business}`);

        ctx.log(`Proposed ${proposal.pages.length} pages for "${proposal.site_name}"`);

        return reviewGate('Review the proposed site structure before content is generated.', {
          proposal,
        });
      },
    },

    {
      name: 'generate_content',
      label: 'Generate page content',
      async run(ctx) {
        const proposal = ctx.state.proposal as
          | { site_name: string; tagline: string; pages: PlannedPage[] }
          | undefined;
        if (!proposal) throw new Error('Missing proposal in state — site planning must be reviewed first.');

        // Update site settings with proposed name/tagline.
        const settingsPath = paths.settings(ctx.orgId, ctx.siteId);
        const existing = (await ctx.store.getDoc<Record<string, unknown>>(settingsPath)) ?? {};
        await ctx.store.setDoc(settingsPath, {
          ...existing,
          site_name: proposal.site_name,
          tagline: proposal.tagline,
        });

        let written = 0;
        for (const p of proposal.pages) {
          ctx.setProgress({ total: proposal.pages.length, completed: written });
          ctx.log(`Writing "${p.title}"…`);

          const html = await generateText(
            ctx.orgId,
            `You are writing a single page for the website "${proposal.site_name}" (${proposal.tagline}). Output only the HTML body, no <html>/<body> wrapper. Use semantic tags (h1, h2, p, ul, etc.). Inline styles are OK but you can use the site's CSS variables: var(--color-primary), var(--color-accent), var(--spacing-md), var(--spacing-lg).`,
            `Page title: ${p.title}
Page purpose: ${p.description}
Page type: ${p.page_type}
Target keywords (work them in naturally): ${p.target_keywords.join(', ')}

Write the page. Be specific and useful — no filler.`
          );

          const slug = p.slug || slugify(p.title) || `page-${written}`;
          const pageId = slug;
          const doc: Omit<Page, 'id'> = {
            title: p.title,
            slug: p.page_type === 'home' ? 'home' : slug,
            content_mode: 'html',
            html_content: stripCodeFences(html),
            status: 'review',
            ai_generated: true,
            seo_description: p.description,
            date_updated: new Date().toISOString(),
          };
          await ctx.store.setDoc(`${paths.pages(ctx.orgId, ctx.siteId)}/${pageId}`, doc);
          written++;
        }

        ctx.log(`Generated ${written} pages.`);
        return { results: { pages_generated: written } };
      },
    },
  ],
};

function stripCodeFences(s: string): string {
  return s
    .replace(/^```(?:html)?\s*\n/, '')
    .replace(/\n```\s*$/, '')
    .trim();
}
