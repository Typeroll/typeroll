// Phase aggregation over recorded build costs.
//
// `PhaseTimer` has written per-phase timings onto every deploy since cost
// accounting landed and nothing read them, so "where does build time actually
// go, across the whole fleet" was unanswerable from data that already existed.
// These tests pin the aggregation's honesty properties rather than its
// arithmetic: the share denominator, what happens to builds without phases,
// and that unmeasured time is surfaced instead of redistributed.

import { describe, it, expect } from 'vitest';
import { aggregatePhases } from '../../lib/deploy/build-report';
import type { DeployCost } from '@typeroll/shared';

function cost(duration_s: number, phases?: Record<string, number>): DeployCost {
  return {
    currency: 'USD',
    total: 0.001,
    cpu: 0.001,
    memory: 0,
    request: 0,
    duration_s,
    vcpu: 1,
    memory_gib: 1,
    rates: { cpu_per_vcpu_second: 0.000024, memory_per_gib_second: 0.0000025, per_request: 0.0000004 },
    ...(phases ? { phases } : {}),
    estimated: true,
  };
}

describe('aggregatePhases', () => {
  it('sums per phase and orders by total time descending', () => {
    const out = aggregatePhases([
      cost(100, { building: 60, uploading: 30, materializing: 10 }),
      cost(100, { building: 80, uploading: 10, materializing: 10 }),
    ]);

    expect(out.phases.map((p) => p.phase)).toEqual(['building', 'uploading', 'materializing']);
    expect(out.phases[0]).toMatchObject({ phase: 'building', total_s: 140, builds: 2, average_s: 70 });
    expect(out.phases[1]!.total_s).toBe(40);
  });

  it('computes share against measured builds only, not the whole window', () => {
    // One build predates cost accounting (no phases). Including its 900s in
    // the denominator would deflate every share to near zero and make the
    // astro build look cheap when it is 70% of every measured deploy.
    const out = aggregatePhases([
      cost(100, { building: 70, uploading: 30 }),
      cost(900),
    ]);

    expect(out.measured_duration_s).toBe(100);
    expect(out.builds_with_phases).toBe(1);
    expect(out.phases.find((p) => p.phase === 'building')!.share).toBe(0.7);
  });

  it('surfaces time outside any labelled phase rather than redistributing it', () => {
    // The runner labels phases by transition, so process startup and the final
    // write land outside all of them. Spreading that across the measured
    // phases would overstate whichever phase happened to be largest.
    const out = aggregatePhases([cost(100, { building: 60, uploading: 25 })]);

    expect(out.unattributed_s).toBe(15);
    expect(out.phases.reduce((a, p) => a + p.total_s, 0)).toBe(85);
  });

  it('never reports negative unattributed time when the clock moved', () => {
    const out = aggregatePhases([cost(10, { building: 30 })]);
    expect(out.unattributed_s).toBe(0);
  });

  it('ignores builds with no cost row and with an empty phase map', () => {
    const out = aggregatePhases([undefined, cost(50), cost(50, {})]);
    expect(out.phases).toEqual([]);
    expect(out.builds_with_phases).toBe(0);
    expect(out.measured_duration_s).toBe(0);
  });

  it('drops a garbage phase value instead of poisoning the total', () => {
    const out = aggregatePhases([
      cost(100, { building: 60, uploading: Number.NaN, bundling: -5 }),
    ]);
    expect(out.phases.map((p) => p.phase)).toEqual(['building']);
    expect(out.phases[0]!.total_s).toBe(60);
  });

  it('counts per-phase builds separately so a phase that only some builds run is not averaged wrong', () => {
    // Pagefind only runs when a page uses core/search. Its average must be
    // over the builds that indexed, not over every build in the window.
    const out = aggregatePhases([
      cost(100, { building: 60, 'indexing search': 20 }),
      cost(100, { building: 60 }),
    ]);

    const search = out.phases.find((p) => p.phase === 'indexing search')!;
    expect(search.builds).toBe(1);
    expect(search.average_s).toBe(20);
    expect(out.phases.find((p) => p.phase === 'building')!.builds).toBe(2);
  });
});
