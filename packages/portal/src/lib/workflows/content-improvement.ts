// CONTENT_IMPROVEMENT workflow.
//
// Finds pages that are likely to benefit from a rewrite (thin content, stale,
// missing meta) and uses AI to produce improved versions. The improved
// versions are saved as drafts (status='review') so the customer can review
// before publishing — we never silently overwrite live content.

import { paths, MAIN_VERSION_ID } from '@typeroll/shared';
import { vstore } from '../version-store';
import type { Page } from '@typeroll/shared';
import { type WorkflowDef } from './types';
import { generateText } from '../ai/claude';

export const contentImprovementWorkflow: WorkflowDef = {
  type: 'content_improvement',
  label: 'Improve content',
  description: 'AI identifies weak pages and produces improved versions saved as drafts for review.',
  steps: [
    {
      name: 'identify_weak',
      label: 'Identify weak pages',
      async run(ctx) {
        const limit = Number(ctx.config.limit ?? 5);
        const all = await vstore.pages(ctx.orgId, ctx.siteId, MAIN_VERSION_ID);
        const live = all.filter((p) => p.status === 'published');

        const scored = live.map((p) => {
          const text = (p.html_content ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          let score = 100;
          if (!p.seo_title) score -= 15;
          if (!p.seo_description) score -= 15;
          if (text.length < 300) score -= 20;
          if (text.length < 100) score -= 30;
          const lastUpdated = p.date_updated ? Date.parse(p.date_updated) : 0;
          const monthsOld = lastUpdated ? (Date.now() - lastUpdated) / (1000 * 60 * 60 * 24 * 30) : 12;
          if (monthsOld > 12) score -= 15;
          if (monthsOld > 24) score -= 15;
          return { page: p, score, textLen: text.length, monthsOld };
        });
        scored.sort((a, b) => a.score - b.score);

        const targets = scored.slice(0, limit);
        ctx.log(`Targeting ${targets.length} weakest pages`);
        return {
          state: {
            targets: targets.map((t) => ({ page_id: t.page.id, score: t.score, textLen: t.textLen })),
          },
        };
      },
    },

    {
      name: 'ai_improve',
      label: 'AI improvements',
      async run(ctx) {
        const targets = ctx.state.targets as Array<{ page_id: string; score: number; textLen: number }>;
        let improved = 0;

        for (let i = 0; i < targets.length; i++) {
          const t = targets[i];
          ctx.setProgress({ total: targets.length, completed: i });
          const page = await vstore.page(ctx.orgId, ctx.siteId, MAIN_VERSION_ID, t.page_id);
          if (!page) continue;

          ctx.log(`Improving "${page.title}"…`);
          const improvedHtml = await generateText(
            ctx.orgId,
            `You are improving an existing page. Keep the same topic and audience; rewrite for clarity, depth, and SEO. Use semantic HTML (h1, h2, h3, p, ul, etc.). Inline styles OK. Site CSS variables available: var(--color-primary), var(--color-accent), var(--spacing-md). Output only the HTML body — no <html>/<body> wrapper, no markdown fences.`,
            `Page title: ${page.title}\nCurrent HTML:\n${page.html_content ?? ''}\n\nProduce an improved HTML body.`,
            { maxTokens: 6000 }
          );

          // Save improvement as the next version on the same doc, but set
          // status='review' so the customer reviews before publishing.
          await ctx.store.updateDoc(paths.page(ctx.orgId, ctx.siteId, t.page_id), {
            html_content: stripFences(improvedHtml),
            status: 'review',
            date_updated: new Date().toISOString(),
            ai_generated: true,
          });

          // Snapshot the previous version into revisions.
          const revisionId = `${Date.now()}`;
          await ctx.store.setDoc(`${paths.revisions(ctx.orgId, ctx.siteId, t.page_id)}/${revisionId}`, {
            content_mode: page.content_mode,
            html_content: page.html_content,
            blocks: page.blocks,
            seo_title: page.seo_title,
            seo_description: page.seo_description,
            created_at: new Date().toISOString(),
            created_by: 'ai',
            note: 'Pre-improvement snapshot',
          });
          improved++;
        }

        return { results: { improved_count: improved } };
      },
    },
  ],
};

function stripFences(s: string): string {
  return s.replace(/^```(?:html)?\s*\n/, '').replace(/\n```\s*$/, '').trim();
}
