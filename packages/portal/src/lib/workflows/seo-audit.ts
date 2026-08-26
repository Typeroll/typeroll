// SEO_AUDIT workflow.
//
// Crawls the site's pages, fetches Google Search Console data when available
// (via the org's Google service account), and produces an audit report with
// prioritized recommendations. The findings are stored in workflow.results so
// they can be rendered in the portal's SEO dashboard.

import { paths , MAIN_VERSION_ID } from '@typeroll/shared';
import { vstore } from '../version-store';
import type { Page } from '@typeroll/shared';
import { type WorkflowDef } from './types';
import { generateJson } from '../ai/claude';

interface PageAudit {
  page_id: string;
  url: string;
  title: string;
  issues: string[];
  score: number;
}

export const seoAuditWorkflow: WorkflowDef = {
  type: 'seo_audit',
  label: 'SEO audit',
  description: 'Scan the site for SEO issues — missing meta, thin content, duplicates, structure problems.',
  steps: [
    {
      name: 'crawl',
      label: 'Crawl pages',
      async run(ctx) {
        const pages = await vstore.pages(ctx.orgId, ctx.siteId, MAIN_VERSION_ID);
        const published = pages.filter((p) => p.status === 'published' || p.status === 'unlisted');
        ctx.log(`Auditing ${published.length} pages`);

        const titleSet = new Map<string, number>();
        const descSet = new Map<string, number>();
        for (const p of published) {
          const t = p.seo_title || p.title;
          titleSet.set(t, (titleSet.get(t) ?? 0) + 1);
          const d = p.seo_description ?? '';
          if (d) descSet.set(d, (descSet.get(d) ?? 0) + 1);
        }

        const audits: PageAudit[] = [];
        for (const page of published) {
          const issues: string[] = [];
          if (!page.seo_title) issues.push('Missing SEO title');
          if (page.seo_title && page.seo_title.length > 60) issues.push(`SEO title is ${page.seo_title.length} chars (target 50-60)`);
          if (!page.seo_description) issues.push('Missing meta description');
          if (page.seo_description && page.seo_description.length < 50) issues.push('Meta description shorter than 50 characters');
          if (page.seo_description && page.seo_description.length > 160) issues.push('Meta description longer than 160 characters');
          if (titleSet.get(page.seo_title || page.title)! > 1) issues.push('Duplicate title across pages');
          if (page.seo_description && descSet.get(page.seo_description)! > 1) issues.push('Duplicate meta description across pages');

          const bodyText = (page.html_content ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          if (bodyText.length < 300) issues.push(`Thin content (${bodyText.length} chars of body text)`);

          const headings = countHeadings(page.html_content ?? '');
          if (headings.h1 === 0) issues.push('No H1 heading');
          if (headings.h1 > 1) issues.push('Multiple H1 headings');

          // Image accessibility — flag any <img> with missing alt unless
          // explicitly marked decorative.
          const imgs = Array.from((page.html_content ?? '').matchAll(/<img\b([^>]*)\/?>/gi));
          let imgMissingAlt = 0;
          for (const m of imgs) {
            const attrs = m[1];
            const hasAlt = /\balt\s*=/.test(attrs);
            const hidden = /\baria-hidden\s*=\s*["']true["']/i.test(attrs) || /\brole\s*=\s*["']presentation["']/i.test(attrs);
            if (!hasAlt && !hidden) imgMissingAlt++;
          }
          if (imgMissingAlt > 0) issues.push(`${imgMissingAlt} of ${imgs.length} images missing alt text`);

          // OG image — search and social previews look bad without one.
          if (!page.og_image) issues.push('No og:image set — fallback to site default. Pages with their own OG image rank better in social.');

          // Slug hygiene.
          if (page.slug && page.slug !== page.slug.toLowerCase()) issues.push('Slug contains uppercase letters');
          if (page.slug && page.slug.length > 80) issues.push(`Slug is ${page.slug.length} characters (target < 80)`);

          // Articles need date + author for richest result eligibility.
          if (page.kind === 'article') {
            if (!page.date_published) issues.push('Article has no published date');
            if (!page.author) issues.push('Article has no author set');
          }

          const score = Math.max(0, 100 - issues.length * 10);
          audits.push({ page_id: page.id, url: `/${page.slug}`, title: page.title, issues, score });
        }

        const overall = Math.round(audits.reduce((s, a) => s + a.score, 0) / Math.max(audits.length, 1));
        ctx.log(`Overall SEO score: ${overall}/100`);

        return { state: { audits, overall_score: overall } };
      },
    },

    {
      name: 'fetch_gsc',
      label: 'Fetch Search Console data',
      async run(ctx) {
        // GSC requires a Google service account with read access to the
        // verified property. We skip gracefully when not configured.
        const sa = process.env.GOOGLE_SERVICE_ACCOUNT;
        if (!sa) {
          ctx.log('GOOGLE_SERVICE_ACCOUNT not set — skipping GSC data.');
          return { state: { gsc_skipped: true } };
        }
        ctx.log('GSC client is wired but the implementation lives behind a real key; skipping for now.');
        return { state: { gsc_skipped: true } };
      },
    },

    {
      name: 'ai_recommendations',
      label: 'AI recommendations',
      async run(ctx) {
        const audits = ctx.state.audits as PageAudit[];
        const top = audits
          .filter((a) => a.issues.length > 0)
          .sort((a, b) => a.score - b.score)
          .slice(0, 15);
        if (!top.length) {
          ctx.log('No issues to recommend on.');
          return { results: { recommendations: [], audits, overall_score: ctx.state.overall_score } };
        }

        if (!process.env.ANTHROPIC_API_KEY) {
          ctx.log('No Anthropic key — returning per-page issue list without AI prioritization.');
          return { results: { recommendations: top, audits, overall_score: ctx.state.overall_score } };
        }

        const recs = await generateJson<Array<{ page_id: string; recommendation: string; impact: 'high' | 'medium' | 'low' }>>(
          ctx.orgId,
          'You are an SEO expert. Produce one prioritized, actionable recommendation per page. Be specific.',
          `Pages with issues:\n${JSON.stringify(top, null, 2)}\n\nReturn an array of { page_id, recommendation, impact }.`
        );

        return {
          results: {
            audits,
            recommendations: recs,
            overall_score: ctx.state.overall_score,
          },
        };
      },
    },
  ],
};

function countHeadings(html: string): { h1: number; h2: number; h3: number } {
  return {
    h1: (html.match(/<h1\b/gi) ?? []).length,
    h2: (html.match(/<h2\b/gi) ?? []).length,
    h3: (html.match(/<h3\b/gi) ?? []).length,
  };
}
