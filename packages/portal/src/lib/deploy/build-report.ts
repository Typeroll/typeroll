/**
 * Build-cost reporting: every site build an org has run, with what it cost.
 *
 * SCOPE. This reports on sites the org OWNS. Shared-in sites are deliberately
 * excluded — the compute for those builds is billed against the owning org's
 * tree, and showing them here would double-count them across two orgs'
 * reports. (`paths.deploys` is keyed by the owner org for exactly this
 * reason.)
 *
 * NOT A CROSS-ORG VIEW. There is no platform-superadmin role in this codebase
 * yet, so "all builds" means "all builds in your organization". On a
 * single-org install those are the same set. If a true cross-org operator
 * view is added later, it belongs on top of this function (loop orgs, reuse
 * `collectSiteBuilds`), not inside it.
 *
 * COST: one listDocs per owned site. At tens of sites that's fine; if an org
 * ever holds hundreds, this wants a denormalized per-org index of deploy
 * summaries rather than a fan-out read.
 */

import { paths } from '@typeroll/shared';
import type { DeployCost, DeployJob, Site } from '@typeroll/shared';
import { getStore } from '../datastore';
import { getRateCard, sumCosts } from './cost';

export interface BuildRow {
  site_id: string;
  site_name: string;
  deploy_id: string;
  version_id: string;
  environment: string;
  status: DeployJob['status'];
  started_at: string;
  finished_at?: string;
  /** Present once the job reached a terminal state under cost accounting. */
  cost?: DeployCost;
  deploy_url?: string;
  error?: string;
  triggered_by?: string;
  dry_run?: boolean;
}

export interface SiteTotal {
  site_id: string;
  site_name: string;
  builds: number;
  total: number;
}

/**
 * Where build time actually goes, summed across a set of builds.
 *
 * `PhaseTimer` has recorded this on every deploy since cost accounting
 * landed, and nothing read it — so "is the astro build 60% of a deploy or
 * 95%, and is that the same for a 20-page marketing site as for a 500-record
 * directory" was unanswerable from production data despite the data existing.
 * Any decision about build performance should start here rather than at a
 * fixture benchmark, because this covers the whole fleet.
 */
export interface PhaseAggregate {
  phase: string;
  total_s: number;
  /** Mean seconds per build that reported this phase. */
  average_s: number;
  /** Builds contributing a timing for this phase. */
  builds: number;
  /**
   * Fraction of summed build duration, 0–1. Denominator is the duration of
   * builds that reported phases — NOT every build in the window. Mixing in
   * pre-accounting builds would silently deflate every share.
   */
  share: number;
}

export interface PhaseBreakdown {
  phases: PhaseAggregate[];
  /** Builds that carried phase timings at all. */
  builds_with_phases: number;
  /** Summed duration of those builds — the denominator behind `share`. */
  measured_duration_s: number;
  /**
   * Summed duration minus summed phase time. Phases are recorded by the
   * runner's own transitions, so work outside a labelled phase (process
   * startup, the final write) lands here rather than being silently
   * redistributed across the phases that were measured.
   */
  unattributed_s: number;
}

/** Sum `cost.phases` across builds. Pure — the report and any future
 *  per-site view share one definition of "where did the time go". */
export function aggregatePhases(costs: Array<DeployCost | undefined>): PhaseBreakdown {
  const totals = new Map<string, { total: number; builds: number }>();
  let measured = 0;
  let phaseSum = 0;

  for (const cost of costs) {
    const phases = cost?.phases;
    if (!phases || Object.keys(phases).length === 0) continue;
    measured += cost?.duration_s ?? 0;
    for (const [phase, seconds] of Object.entries(phases)) {
      if (!Number.isFinite(seconds) || seconds < 0) continue;
      const entry = totals.get(phase) ?? { total: 0, builds: 0 };
      entry.total += seconds;
      entry.builds++;
      totals.set(phase, entry);
      phaseSum += seconds;
    }
  }

  const round = (n: number) => Math.round(n * 1000) / 1000;
  const phases = [...totals.entries()]
    .map(([phase, { total, builds }]) => ({
      phase,
      total_s: round(total),
      average_s: builds > 0 ? round(total / builds) : 0,
      builds,
      share: measured > 0 ? Math.round((total / measured) * 10000) / 10000 : 0,
    }))
    .sort((a, b) => b.total_s - a.total_s);

  return {
    phases,
    builds_with_phases: phases.length > 0 ? Math.max(...phases.map((p) => p.builds)) : 0,
    measured_duration_s: round(measured),
    // Clamped: a clock adjustment mid-build could make phases exceed duration,
    // and a negative "unattributed" would read as a measurement bug that isn't.
    unattributed_s: round(Math.max(0, measured - phaseSum)),
  };
}

export interface BuildReport {
  currency: string;
  /** Window in days the rows cover; 0 means "everything". */
  days: number;
  rows: BuildRow[];
  totals: {
    builds: number;
    /** Builds that carry a cost row. Older jobs predate cost accounting. */
    costed_builds: number;
    /** Builds skipped from the total because they were priced in another
     *  currency (rate card changed mid-window). Surfaced so the UI can say so
     *  rather than quietly under-reporting. */
    other_currency_builds: number;
    total_cost: number;
    average_cost: number;
    total_duration_s: number;
    failed: number;
  };
  /** Where the time went. See `aggregatePhases`. */
  phase_breakdown: PhaseBreakdown;
  by_site: SiteTotal[];
  /** True when `limit` clipped the result — the totals then describe only the
   *  rows returned, not the whole window. Never let a truncated list read as
   *  a complete one. */
  truncated: boolean;
}

export interface BuildReportOptions {
  /** Only include builds started within this many days. 0 = no window. */
  days?: number;
  /** Cap on returned rows, newest first. */
  limit?: number;
  /** Restrict to one site. */
  siteId?: string;
  /** Only failed builds, only succeeded, etc. */
  status?: DeployJob['status'];
}

async function collectSiteBuilds(orgId: string, site: Site): Promise<BuildRow[]> {
  const store = getStore();
  let jobs: DeployJob[] = [];
  try {
    jobs = await store.listDocs<DeployJob>(paths.deploys(orgId, site.id));
  } catch {
    // A site with no deploys yet has no collection. Not an error.
    return [];
  }
  return jobs.map((j) => ({
    site_id: site.id,
    site_name: site.name ?? site.id,
    deploy_id: j.id,
    version_id: j.version_id,
    environment: j.environment,
    status: j.status,
    started_at: j.started_at,
    finished_at: j.finished_at,
    cost: j.cost,
    deploy_url: j.deploy_url,
    error: j.error,
    triggered_by: j.triggered_by,
    dry_run: (j as DeployJob & { dry_run?: boolean }).dry_run,
  }));
}

export async function buildCostReport(
  orgId: string,
  options: BuildReportOptions = {},
): Promise<BuildReport> {
  const store = getStore();
  const days = options.days ?? 30;
  const limit = options.limit ?? 200;

  const allSites = await store.listDocs<Site>(paths.sites(orgId));
  const sites = options.siteId ? allSites.filter((s) => s.id === options.siteId) : allSites;

  const perSite = await Promise.all(sites.map((s) => collectSiteBuilds(orgId, s)));
  let rows = perSite.flat();

  if (days > 0) {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    rows = rows.filter((r) => {
      const t = Date.parse(r.started_at);
      // Keep rows with an unparseable timestamp — dropping them would hide
      // builds rather than surface a data problem.
      return Number.isNaN(t) || t >= cutoff;
    });
  }
  if (options.status) rows = rows.filter((r) => r.status === options.status);

  rows.sort((a, b) => (Date.parse(b.started_at) || 0) - (Date.parse(a.started_at) || 0));

  const truncated = rows.length > limit;
  if (truncated) rows = rows.slice(0, limit);

  // Report in the CURRENT rate card's currency; rows priced in anything else
  // are counted separately rather than summed across currencies.
  const currency = getRateCard().currency;
  const { total, counted, skipped } = sumCosts(rows.map((r) => r.cost), currency);

  const bySiteMap = new Map<string, SiteTotal>();
  for (const r of rows) {
    const entry = bySiteMap.get(r.site_id) ?? {
      site_id: r.site_id,
      site_name: r.site_name,
      builds: 0,
      total: 0,
    };
    entry.builds++;
    if (r.cost && r.cost.currency === currency) entry.total += r.cost.total;
    bySiteMap.set(r.site_id, entry);
  }
  const by_site = [...bySiteMap.values()]
    .map((s) => ({ ...s, total: Math.round(s.total * 1e8) / 1e8 }))
    .sort((a, b) => b.total - a.total);

  const totalDuration = rows.reduce((acc, r) => acc + (r.cost?.duration_s ?? 0), 0);

  return {
    currency,
    days,
    rows,
    totals: {
      builds: rows.length,
      costed_builds: counted,
      other_currency_builds: skipped,
      total_cost: total,
      average_cost: counted > 0 ? Math.round((total / counted) * 1e8) / 1e8 : 0,
      total_duration_s: Math.round(totalDuration * 1000) / 1000,
      failed: rows.filter((r) => r.status === 'failed').length,
    },
    phase_breakdown: aggregatePhases(rows.map((r) => r.cost)),
    by_site,
    truncated,
  };
}
