/**
 * Cost accounting for site builds.
 *
 * WHAT WE'RE MEASURING. A deploy runs synchronously inside one request —
 * Cloud Tasks POSTs the deploy-worker, and the whole build (materialize →
 * astro → bundle → upload) happens before that request returns. Cloud Run
 * bills request-based instances for the time they're handling a request, at
 * the instance's allocated vCPU + memory. So the marginal platform cost of a
 * build is simply:
 *
 *     duration × (vcpu × cpu_rate + memory_gib × memory_rate) + request_fee
 *
 * That's why wall-clock is the right clock here and not process CPU time:
 * the astro build is a CHILD process, so `process.cpuUsage()` wouldn't see
 * it, and Cloud Run charges for allocated capacity during the request
 * regardless of how busy the CPU actually was.
 *
 * WHY THE RATES ARE ENV-CONFIGURABLE. Cloud pricing changes, differs by
 * region tier, and drops substantially under committed-use discounts. Baking
 * today's list price into the binary would quietly go stale. The defaults
 * below are Cloud Run's published tier-1 request-based rates; override per
 * deployment via env when your actual rates differ, or when you're not on
 * Cloud Run at all.
 *
 * These are ESTIMATES, not billing records — see the DeployCost doc comment.
 * Notably the numbers are GROSS: Cloud Run's monthly free tier is not
 * subtracted, so a low-volume install's real invoice is lower than the sum of
 * these rows.
 */

import type { DeployCost } from '@typeroll/shared';

export interface RateCard {
  currency: string;
  cpu_per_vcpu_second: number;
  memory_per_gib_second: number;
  per_request: number;
  /** Resources allocated to the instance running the build. */
  vcpu: number;
  memory_gib: number;
}

/**
 * Cloud Run tier-1, request-based billing (the shape this platform deploys
 * in). Allocation defaults mirror the `--cpu=1 --memory=1Gi` in
 * .github/workflows/deploy.yml — if you change the Cloud Run sizing there,
 * change these too (or set the env vars).
 */
export const DEFAULT_RATES: RateCard = {
  currency: 'USD',
  cpu_per_vcpu_second: 0.000024,
  memory_per_gib_second: 0.0000025,
  per_request: 0.0000004,
  vcpu: 1,
  memory_gib: 1,
};

/** Parse a positive number from env, falling back when unset/garbage. */
function num(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function getRateCard(env: NodeJS.ProcessEnv = process.env): RateCard {
  return {
    currency: env.DEPLOY_COST_CURRENCY?.trim() || DEFAULT_RATES.currency,
    cpu_per_vcpu_second: num(env.DEPLOY_COST_CPU_PER_VCPU_SECOND, DEFAULT_RATES.cpu_per_vcpu_second),
    memory_per_gib_second: num(env.DEPLOY_COST_MEM_PER_GIB_SECOND, DEFAULT_RATES.memory_per_gib_second),
    per_request: num(env.DEPLOY_COST_PER_REQUEST, DEFAULT_RATES.per_request),
    vcpu: num(env.DEPLOY_COST_VCPU, DEFAULT_RATES.vcpu),
    memory_gib: num(env.DEPLOY_COST_MEMORY_GIB, DEFAULT_RATES.memory_gib),
  };
}

export interface ComputeCostArgs {
  durationMs: number;
  rates: RateCard;
  /** Milliseconds per runner phase, as observed by the queue. */
  phaseMs?: Record<string, number>;
  outputBytes?: number;
  outputFiles?: number;
}

/**
 * Round to 8 decimals. A single build costs on the order of $0.0005, so
 * cents-precision would collapse every row to 0.00 — but unbounded floats
 * would serialize as 0.0004800000000000001. Eight places keeps sub-cent
 * resolution readable and stable across JSON round-trips.
 */
function round(n: number): number {
  return Math.round(n * 1e8) / 1e8;
}

export function computeDeployCost(args: ComputeCostArgs): DeployCost {
  const { rates } = args;
  // Clamp: a clock adjustment mid-build shouldn't produce a negative cost.
  const durationS = Math.max(0, args.durationMs) / 1000;

  const cpu = round(durationS * rates.vcpu * rates.cpu_per_vcpu_second);
  const memory = round(durationS * rates.memory_gib * rates.memory_per_gib_second);
  const request = round(rates.per_request);

  const phases = args.phaseMs
    ? Object.fromEntries(
        Object.entries(args.phaseMs).map(([k, ms]) => [k, Math.round(ms) / 1000]),
      )
    : undefined;

  return {
    currency: rates.currency,
    total: round(cpu + memory + request),
    cpu,
    memory,
    request,
    duration_s: Math.round(durationS * 1000) / 1000,
    vcpu: rates.vcpu,
    memory_gib: rates.memory_gib,
    rates: {
      cpu_per_vcpu_second: rates.cpu_per_vcpu_second,
      memory_per_gib_second: rates.memory_per_gib_second,
      per_request: rates.per_request,
    },
    ...(phases && Object.keys(phases).length > 0 ? { phases } : {}),
    ...(args.outputBytes !== undefined ? { output_bytes: args.outputBytes } : {}),
    ...(args.outputFiles !== undefined ? { output_files: args.outputFiles } : {}),
    estimated: true,
  };
}

/**
 * Accumulates time per phase as the runner reports transitions.
 *
 * The runner already emits `onPhase(label)` for progress display, so phase
 * timings come for free: each transition closes the previous phase. Call
 * `finish()` when the build ends to close the phase still open.
 */
export class PhaseTimer {
  private readonly totals: Record<string, number> = {};
  private current: string | null = null;
  private mark: number;

  constructor(private readonly now: () => number = () => Date.now()) {
    this.mark = this.now();
  }

  enter(phase: string): void {
    this.close();
    this.current = phase;
  }

  finish(): Record<string, number> {
    this.close();
    this.current = null;
    return this.totals;
  }

  private close(): void {
    const t = this.now();
    if (this.current !== null) {
      // Same phase reported twice in a row accumulates rather than resets —
      // the runner labels some phases identically across retries.
      this.totals[this.current] = (this.totals[this.current] ?? 0) + (t - this.mark);
    }
    this.mark = t;
  }
}

/** Sum a set of cost rows. Rows in a different currency are skipped — mixing
 *  currencies into one total would be a silent lie. The caller gets the count
 *  back so it can say so in the UI. */
export function sumCosts(
  costs: Array<DeployCost | undefined>,
  currency: string,
): { total: number; counted: number; skipped: number } {
  let total = 0;
  let counted = 0;
  let skipped = 0;
  for (const c of costs) {
    if (!c) continue;
    if (c.currency !== currency) {
      skipped++;
      continue;
    }
    total += c.total;
    counted++;
  }
  return { total: round(total), counted, skipped };
}
