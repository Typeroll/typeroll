// URL_PARITY workflow.
//
// The pre-cutover gate: request every URL from the legacy site's inventory
// against the NEW site (its fallback subdomain, since the real domain still
// points at the old host) and report what a visitor — or Googlebot — would
// actually get. Coverage analysis says the data looks right; this says the
// site answers right.
//
// Pauses for review with the gap list rather than completing silently. The
// whole value is a human looking at "17 URLs will 404" before DNS moves.
//
// The check runs in chunks: each chunk requests at most
// URL_PARITY_CHECKS_PER_CHUNK URLs (fewer when its time budget ends first)
// and yields the plan with every result so far as its cursor, so a large
// inventory survives a restart and no URL is requested twice.

import { paths, MAIN_VERSION_ID } from '@typeroll/shared';
import type { Site } from '@typeroll/shared';
import { advanceSiteParity, finishSiteParity, planSiteParity, type SiteParityPlan } from '../wp/url-parity';
import type { UrlStatus } from '../wp/url-inventory';
import { reviewGate, stepYield, type WorkflowDef } from './types';

/** URL requests one chunk starts at most; its time budget usually ends it sooner. */
export const URL_PARITY_CHECKS_PER_CHUNK = 150;

export const urlParityWorkflow: WorkflowDef = {
  type: 'url_parity',
  label: 'URL parity check',
  description:
    'Request every URL from the migration inventory against the new site and report which ones 404, loop, or error — before you point DNS at it.',
  steps: [
    {
      name: 'check_urls',
      label: 'Request every inventory URL',
      async run(ctx) {
        const cfg = ctx.config as {
          target_origin?: string;
          source_origin?: string;
          check_source?: string | boolean;
          statuses?: string;
        };
        const args = {
          store: ctx.store,
          orgId: ctx.orgId,
          siteId: ctx.siteId,
          versionId: MAIN_VERSION_ID,
          sourceOrigin: cfg.source_origin?.trim() || undefined,
          checkSource: cfg.check_source === true || cfg.check_source === 'true',
          onProgress: (done: number, total: number) => {
            ctx.setProgress({ total, completed: done });
            if (done % 25 === 0) ctx.log(`Checked ${done}/${total}`);
          },
        };

        let plan = ctx.cursor as SiteParityPlan | undefined;
        if (!plan) {
          const site = await ctx.store.getDoc<Site>(paths.site(ctx.orgId, ctx.siteId));
          if (!site) throw new Error('Site not found');
          plan = await planSiteParity({
            ...args,
            site: { ...site, id: ctx.siteId },
            targetOrigin: cfg.target_origin?.trim() || undefined,
            statuses: parseStatuses(cfg.statuses),
          });
          if (plan.inventory_total === 0) {
            ctx.log('Inventory is empty — nothing to check. Populate it first (migration workflow, or POST /api/v1/sites/{id}/migration-urls).');
          }
        }

        const finished = await advanceSiteParity(args, plan, {
          shouldStop: () => ctx.shouldYield?.() ?? false,
          maxChecks: URL_PARITY_CHECKS_PER_CHUNK,
        });
        if (!finished) return stepYield(plan);

        const report = await finishSiteParity(args, plan);
        ctx.log(
          `Checked ${report.checked} URL(s) against ${report.target_origin}: ` +
          `${report.summary.ok} ok, ${report.summary.ok_redirect} via redirect, ` +
          `${report.summary.missing} missing, ${report.summary.broken_redirect} broken redirect, ` +
          `${report.summary.error} error`,
        );
        if (report.redirects_verified) {
          ctx.log(`Stamped verification on ${report.redirects_verified} redirect rule(s)`);
        }

        const gaps = report.results.filter(
          (r) => r.verdict === 'missing' || r.verdict === 'broken_redirect',
        );

        return {
          state: { gap_count: gaps.length },
          results: {
            target_origin: report.target_origin,
            summary: report.summary,
            inventory_total: report.inventory_total,
            truncated: report.truncated,
            redirects_verified: report.redirects_verified,
            gaps,
            // Full list second: the gaps are what gets acted on, and a
            // 400-row array first would bury them in the results panel.
            all_results: report.results,
          },
        };
      },
    },

    {
      name: 'review',
      label: 'Review gaps before cutover',
      needsReview: true,
      async run(ctx) {
        const gapCount = Number(ctx.state.gap_count ?? 0);
        return reviewGate(
          gapCount === 0
            ? 'Every checked URL resolves on the new site. Safe to point DNS.'
            : `${gapCount} URL(s) would break after cutover. Fix them with a redirect (or mark them excluded if the 404 is intended), then re-run this check.`,
          { gap_count: gapCount },
        );
      },
    },
  ],
};

function parseStatuses(raw: unknown): UrlStatus[] | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const allowed: UrlStatus[] = ['migrated', 'redirected', 'excluded', 'unhandled', 'matched_draft'];
  const picked = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is UrlStatus => (allowed as string[]).includes(s));
  return picked.length ? picked : undefined;
}
