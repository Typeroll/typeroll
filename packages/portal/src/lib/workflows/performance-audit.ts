// PERFORMANCE_AUDIT workflow.
//
// Runs Google PageSpeed Insights against every published page and stores
// Core Web Vitals + Lighthouse scores. Requires PAGESPEED_API_KEY (free
// Google API key) — degrades to a no-op message without it.

import { paths , MAIN_VERSION_ID } from '@typeroll/shared';
import { vstore } from '../version-store';
import type { Page, Site } from '@typeroll/shared';
import { type WorkflowDef } from './types';

interface PageSpeedResult {
  page_id: string;
  url: string;
  title: string;
  performance: number;
  accessibility: number;
  seo: number;
  best_practices: number;
  lcp_seconds?: number;
  cls?: number;
  inp_ms?: number;
}

export const performanceAuditWorkflow: WorkflowDef = {
  type: 'performance_audit',
  label: 'Performance audit',
  description: 'Run PageSpeed Insights on every page and track Core Web Vitals over time.',
  steps: [
    {
      name: 'lighthouse',
      label: 'Run PageSpeed Insights',
      async run(ctx) {
        const apiKey = process.env.PAGESPEED_API_KEY;
        const site = await ctx.store.getDoc<Site>(paths.site(ctx.orgId, ctx.siteId));
        const origin = site?.domain ? `https://${site.domain}` : null;
        if (!origin) throw new Error('Site has no domain — set one before running performance audits.');

        const pages = await vstore.pages(ctx.orgId, ctx.siteId, MAIN_VERSION_ID);
        const published = pages.filter((p) => p.status === 'published');
        ctx.log(`Checking ${published.length} pages on ${origin}`);

        if (!apiKey) {
          ctx.log('PAGESPEED_API_KEY not set — skipping live audits.');
          return { results: { skipped: true, reason: 'PAGESPEED_API_KEY not configured' } };
        }

        const results: PageSpeedResult[] = [];
        for (let i = 0; i < published.length; i++) {
          const p = published[i];
          ctx.setProgress({ total: published.length, completed: i });
          const url = `${origin}/${p.slug === 'home' ? '' : p.slug}`;
          try {
            const r = await runPageSpeed(url, apiKey);
            results.push({ page_id: p.id, url, title: p.title, ...r });
            ctx.log(`${p.title}: perf ${r.performance}`);
          } catch (e) {
            ctx.log(`Failed for ${url}: ${e instanceof Error ? e.message : e}`);
          }
        }

        const avg = (key: keyof PageSpeedResult) =>
          Math.round(
            results.reduce((s, r) => s + (Number(r[key]) || 0), 0) / Math.max(results.length, 1)
          );
        return {
          results: {
            pages: results,
            averages: {
              performance: avg('performance'),
              accessibility: avg('accessibility'),
              seo: avg('seo'),
              best_practices: avg('best_practices'),
            },
          },
        };
      },
    },
  ],
};

async function runPageSpeed(url: string, apiKey: string) {
  const endpoint = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
  endpoint.searchParams.set('url', url);
  endpoint.searchParams.set('key', apiKey);
  for (const cat of ['performance', 'accessibility', 'seo', 'best-practices']) {
    endpoint.searchParams.append('category', cat);
  }
  endpoint.searchParams.set('strategy', 'mobile');

  const res = await fetch(endpoint, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`PSI ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as {
    lighthouseResult?: {
      categories: Record<string, { score: number }>;
      audits: Record<string, { numericValue?: number }>;
    };
  };
  const cat = body.lighthouseResult?.categories ?? {};
  const audits = body.lighthouseResult?.audits ?? {};

  return {
    performance: Math.round((cat['performance']?.score ?? 0) * 100),
    accessibility: Math.round((cat['accessibility']?.score ?? 0) * 100),
    seo: Math.round((cat['seo']?.score ?? 0) * 100),
    best_practices: Math.round((cat['best-practices']?.score ?? 0) * 100),
    lcp_seconds: round((audits['largest-contentful-paint']?.numericValue ?? 0) / 1000, 2),
    cls: round(audits['cumulative-layout-shift']?.numericValue ?? 0, 3),
    inp_ms: Math.round(audits['interactive']?.numericValue ?? 0),
  };
}

function round(n: number, places: number): number {
  return Number(n.toFixed(places));
}
