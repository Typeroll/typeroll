// Build-cost accounting: the rate math, the env-driven rate card, the phase
// timer that feeds the breakdown, and cross-currency summing.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_RATES,
  PhaseTimer,
  computeDeployCost,
  getRateCard,
  sumCosts,
} from '../../lib/deploy/cost';

describe('getRateCard', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('DEPLOY_COST_')) delete process.env[k];
    }
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('defaults to the Cloud Run tier-1 request-based rates', () => {
    expect(getRateCard({} as NodeJS.ProcessEnv)).toEqual(DEFAULT_RATES);
  });

  it('lets a deployment override every rate and the allocation', () => {
    const card = getRateCard({
      DEPLOY_COST_CURRENCY: 'EUR',
      DEPLOY_COST_CPU_PER_VCPU_SECOND: '0.00001',
      DEPLOY_COST_MEM_PER_GIB_SECOND: '0.000001',
      DEPLOY_COST_PER_REQUEST: '0',
      DEPLOY_COST_VCPU: '2',
      DEPLOY_COST_MEMORY_GIB: '4',
    } as NodeJS.ProcessEnv);
    expect(card).toEqual({
      currency: 'EUR',
      cpu_per_vcpu_second: 0.00001,
      memory_per_gib_second: 0.000001,
      per_request: 0,
      vcpu: 2,
      memory_gib: 4,
    });
  });

  it('falls back to defaults on garbage or negative values', () => {
    const card = getRateCard({
      DEPLOY_COST_CPU_PER_VCPU_SECOND: 'free',
      DEPLOY_COST_VCPU: '-3',
      DEPLOY_COST_CURRENCY: '   ',
    } as NodeJS.ProcessEnv);
    expect(card.cpu_per_vcpu_second).toBe(DEFAULT_RATES.cpu_per_vcpu_second);
    expect(card.vcpu).toBe(DEFAULT_RATES.vcpu);
    expect(card.currency).toBe('USD');
  });

  it('accepts an explicit zero (self-hosted on hardware you already pay for)', () => {
    const card = getRateCard({ DEPLOY_COST_CPU_PER_VCPU_SECOND: '0' } as NodeJS.ProcessEnv);
    expect(card.cpu_per_vcpu_second).toBe(0);
  });
});

describe('computeDeployCost', () => {
  it('prices instance-time at the allocated vCPU + memory', () => {
    // 60s on 1 vCPU / 1 GiB at the default rates:
    //   cpu = 60 * 1 * 0.000024   = 0.00144
    //   mem = 60 * 1 * 0.0000025  = 0.00015
    //   req =                       0.0000004
    const cost = computeDeployCost({ durationMs: 60_000, rates: DEFAULT_RATES });
    expect(cost.cpu).toBeCloseTo(0.00144, 10);
    expect(cost.memory).toBeCloseTo(0.00015, 10);
    expect(cost.request).toBeCloseTo(0.0000004, 10);
    expect(cost.total).toBeCloseTo(0.0015904, 10);
    expect(cost.duration_s).toBe(60);
    expect(cost.estimated).toBe(true);
  });

  it('scales with allocation — 2 vCPU costs twice the CPU of 1', () => {
    const one = computeDeployCost({ durationMs: 10_000, rates: DEFAULT_RATES });
    const two = computeDeployCost({ durationMs: 10_000, rates: { ...DEFAULT_RATES, vcpu: 2 } });
    expect(two.cpu).toBeCloseTo(one.cpu * 2, 10);
  });

  it('snapshots the rate card onto the row so history does not re-price', () => {
    const cost = computeDeployCost({
      durationMs: 1000,
      rates: { ...DEFAULT_RATES, cpu_per_vcpu_second: 0.001 },
    });
    expect(cost.rates.cpu_per_vcpu_second).toBe(0.001);
  });

  it('clamps a negative duration (clock adjustment mid-build) to zero', () => {
    const cost = computeDeployCost({ durationMs: -5000, rates: DEFAULT_RATES });
    expect(cost.duration_s).toBe(0);
    expect(cost.cpu).toBe(0);
    // The per-request fee still applies — the request happened.
    expect(cost.total).toBe(cost.request);
  });

  it('converts phase timings to seconds and carries output size', () => {
    const cost = computeDeployCost({
      durationMs: 5000,
      rates: DEFAULT_RATES,
      phaseMs: { building: 3200, uploading: 1500 },
      outputBytes: 2048,
      outputFiles: 7,
    });
    expect(cost.phases).toEqual({ building: 3.2, uploading: 1.5 });
    expect(cost.output_bytes).toBe(2048);
    expect(cost.output_files).toBe(7);
  });

  it('omits empty phase/output fields rather than writing undefined', () => {
    const cost = computeDeployCost({ durationMs: 1000, rates: DEFAULT_RATES, phaseMs: {} });
    expect('phases' in cost).toBe(false);
    expect('output_bytes' in cost).toBe(false);
  });

  it('rounds to a stable 8dp instead of leaking float noise', () => {
    const cost = computeDeployCost({ durationMs: 1234, rates: DEFAULT_RATES });
    expect(JSON.stringify(cost.total)).toBe(String(cost.total));
    expect(cost.total.toString()).not.toContain('e-');
  });
});

describe('PhaseTimer', () => {
  it('attributes elapsed time to the phase that was open', () => {
    let now = 0;
    const timer = new PhaseTimer(() => now);
    now = 100; timer.enter('building');   // 0–100 was before any phase
    now = 400; timer.enter('uploading');  // building ran 100–400
    now = 500;
    expect(timer.finish()).toEqual({ building: 300, uploading: 100 });
  });

  it('accumulates when the same phase label is reported twice', () => {
    let now = 0;
    const timer = new PhaseTimer(() => now);
    timer.enter('building');
    now = 50; timer.enter('building');
    now = 80;
    expect(timer.finish()).toEqual({ building: 80 });
  });

  it('returns an empty map when no phase was ever entered', () => {
    expect(new PhaseTimer(() => 0).finish()).toEqual({});
  });
});

describe('sumCosts', () => {
  const usd = (total: number) =>
    ({ ...computeDeployCost({ durationMs: 0, rates: DEFAULT_RATES }), total });

  it('sums same-currency rows and ignores missing ones', () => {
    const r = sumCosts([usd(0.001), undefined, usd(0.002)], 'USD');
    expect(r.total).toBeCloseTo(0.003, 10);
    expect(r.counted).toBe(2);
    expect(r.skipped).toBe(0);
  });

  it('refuses to add across currencies and reports what it skipped', () => {
    const eur = { ...usd(5), currency: 'EUR' };
    const r = sumCosts([usd(0.001), eur], 'USD');
    expect(r.total).toBeCloseTo(0.001, 10);
    expect(r.counted).toBe(1);
    expect(r.skipped).toBe(1);
  });
});
