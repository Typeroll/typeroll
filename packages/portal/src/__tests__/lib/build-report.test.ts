// The org-wide build-cost report: aggregation across sites, the time window,
// filters, and the honesty guarantees (truncation flagged, cross-currency
// rows excluded rather than silently summed, shared-in sites not counted).

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { paths, MAIN_VERSION_ID } from '@typeroll/shared';
import type { DeployCost } from '@typeroll/shared';

const ORG = 'orgone';
const OTHER_ORG = 'orgtwo';

function cost(total: number, currency = 'USD', duration = 10): DeployCost {
  return {
    currency,
    total,
    cpu: total,
    memory: 0,
    request: 0,
    duration_s: duration,
    vcpu: 1,
    memory_gib: 1,
    rates: { cpu_per_vcpu_second: 0.000024, memory_per_gib_second: 0.0000025, per_request: 0.0000004 },
    estimated: true,
  };
}

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

async function seed(): Promise<void> {
  const { getStore } = await import('../../lib/datastore');
  const store = getStore();
  await store.setDoc(paths.site(ORG, 'alpha'), { name: 'Alpha', created_at: daysAgo(90) });
  await store.setDoc(paths.site(ORG, 'beta'), { name: 'Beta', created_at: daysAgo(90) });
  // Another org's site + deploy. Must never appear in ORG's report.
  await store.setDoc(paths.site(OTHER_ORG, 'gamma'), { name: 'Gamma', created_at: daysAgo(90) });
  await store.setDoc(paths.deploy(OTHER_ORG, 'gamma', 'g1'), {
    version_id: MAIN_VERSION_ID, environment: 'production', status: 'succeeded',
    started_at: daysAgo(1), cost: cost(99),
  });

  const mk = async (site: string, id: string, patch: Record<string, unknown>) => {
    await store.setDoc(paths.deploy(ORG, site, id), {
      version_id: MAIN_VERSION_ID,
      environment: 'production',
      status: 'succeeded',
      started_at: daysAgo(1),
      ...patch,
    });
  };

  await mk('alpha', 'a1', { started_at: daysAgo(1), cost: cost(0.002) });
  await mk('alpha', 'a2', { started_at: daysAgo(3), cost: cost(0.003) });
  await mk('alpha', 'a3', { started_at: daysAgo(45), cost: cost(0.5) }); // outside 30d
  await mk('beta', 'b1', { started_at: daysAgo(2), cost: cost(0.001) });
  await mk('beta', 'b2', { started_at: daysAgo(2), status: 'failed', error: 'boom', cost: cost(0.006) });
  await mk('beta', 'b3', { started_at: daysAgo(4) }); // pre-cost-accounting job
}

describe('buildCostReport', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
    await seed();
  });

  it('aggregates every owned site and excludes other orgs', async () => {
    const { buildCostReport } = await import('../../lib/deploy/build-report');
    const report = await buildCostReport(ORG, { days: 30 });

    expect(report.rows.map((r) => r.deploy_id).sort()).toEqual(['a1', 'a2', 'b1', 'b2', 'b3']);
    expect(report.rows.some((r) => r.site_id === 'gamma')).toBe(false);
    // 0.002 + 0.003 + 0.001 + 0.006 — b3 has no cost row.
    expect(report.totals.total_cost).toBeCloseTo(0.012, 10);
    expect(report.totals.builds).toBe(5);
    expect(report.totals.costed_builds).toBe(4);
    expect(report.totals.failed).toBe(1);
  });

  it('honours the time window and 0 = all time', async () => {
    const { buildCostReport } = await import('../../lib/deploy/build-report');
    expect((await buildCostReport(ORG, { days: 30 })).rows).toHaveLength(5);
    // 2.5d rather than an integer: the seeded rows sit exactly on the whole-day
    // marks, and a cutoff computed microseconds later would land on the wrong
    // side of them. Half-day windows keep the assertion about the filter
    // instead of about clock skew.
    expect((await buildCostReport(ORG, { days: 2.5 })).rows.map((r) => r.deploy_id).sort())
      .toEqual(['a1', 'b1', 'b2']);
    const all = await buildCostReport(ORG, { days: 0 });
    expect(all.rows).toHaveLength(6);
    expect(all.totals.total_cost).toBeCloseTo(0.512, 10);
  });

  it('sorts newest first', async () => {
    const { buildCostReport } = await import('../../lib/deploy/build-report');
    const report = await buildCostReport(ORG, { days: 0 });
    const times = report.rows.map((r) => Date.parse(r.started_at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('breaks cost down per site, biggest spender first', async () => {
    const { buildCostReport } = await import('../../lib/deploy/build-report');
    const report = await buildCostReport(ORG, { days: 30 });
    expect(report.by_site.map((s) => s.site_id)).toEqual(['beta', 'alpha']);
    expect(report.by_site[0]).toMatchObject({ site_name: 'Beta', builds: 3 });
    expect(report.by_site[0].total).toBeCloseTo(0.007, 10);
    expect(report.by_site[1].total).toBeCloseTo(0.005, 10);
  });

  it('filters by site and by status', async () => {
    const { buildCostReport } = await import('../../lib/deploy/build-report');
    const bySite = await buildCostReport(ORG, { days: 30, siteId: 'alpha' });
    expect(bySite.rows.every((r) => r.site_id === 'alpha')).toBe(true);

    const failed = await buildCostReport(ORG, { days: 30, status: 'failed' });
    expect(failed.rows.map((r) => r.deploy_id)).toEqual(['b2']);
    expect(failed.rows[0].error).toBe('boom');
  });

  it('flags truncation so a clipped list never reads as complete', async () => {
    const { buildCostReport } = await import('../../lib/deploy/build-report');
    const full = await buildCostReport(ORG, { days: 30 });
    expect(full.truncated).toBe(false);

    const clipped = await buildCostReport(ORG, { days: 30, limit: 2 });
    expect(clipped.truncated).toBe(true);
    expect(clipped.rows).toHaveLength(2);
    expect(clipped.totals.builds).toBe(2);
  });

  it('excludes rows priced in another currency instead of adding them up', async () => {
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(paths.deploy(ORG, 'alpha', 'a4'), {
      version_id: MAIN_VERSION_ID, environment: 'production', status: 'succeeded',
      started_at: daysAgo(1), cost: cost(100, 'EUR'),
    });

    const { buildCostReport } = await import('../../lib/deploy/build-report');
    const report = await buildCostReport(ORG, { days: 30 });
    expect(report.totals.other_currency_builds).toBe(1);
    expect(report.totals.total_cost).toBeCloseTo(0.012, 10); // the EUR 100 is NOT in here
  });

  it('returns an empty report for an org with no sites', async () => {
    const { buildCostReport } = await import('../../lib/deploy/build-report');
    const report = await buildCostReport('emptyorg', { days: 30 });
    expect(report.rows).toEqual([]);
    expect(report.totals).toMatchObject({ builds: 0, total_cost: 0, average_cost: 0 });
  });
});
