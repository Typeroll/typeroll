import { publicationResponse } from '../deploy/public-response';
import { safeFetch as guardedFetch } from '../net/safe-fetch';
import { defaultSleep, politeDelayMs, POLITE_RETRY_STATUSES, type PoliteRetryOptions } from '../net/polite-fetch';
// Pre-cutover URL parity check.
//
// `analyzeCoverage` answers "does the DATA say this URL is handled?" — it
// matches inventory paths against page slugs and redirect rules. That's a
// necessary check, not a sufficient one: a redirect can point at a page that
// was never published, a `path` can carry a typo, a collection route template
// can resolve differently than the analyzer's inlining predicts, and a
// redirect chain can loop. All of those read as "handled" in the coverage
// report and as a 404 to Googlebot.
//
// This module answers the question that actually matters before DNS moves:
// **if I request every old URL against the new site right now, what do I
// get?** It fetches, follows redirects, and classifies the outcome.
//
// Deliberately runs against the site's fallback subdomain (or any origin the
// caller names), because at check time the real domain still points at the
// old host. That's the whole point — close the gaps while the old site is
// still serving.
//
// Every network call goes through the injected `fetchImpl` so the classifier
// is testable without a network.
//
// Hosts (the old one with check_source, and the CDN or WAF in front of the
// new one) throttle rapid crawlers, so the first pass runs at modest
// concurrency (4 by default) and retry rounds back off: a round that retries
// rate-limited results (429, 503) starts after an exponential, jittered
// delay, and within a round a 429 or 503 is retried once after the host's
// `Retry-After` (lib/net/polite-fetch).

import { applyTrailingSlash, embeddedQueryRedirectTarget, paths } from '@typeroll/shared';
import type { DeployJob, Redirect } from '@typeroll/shared';
import type { TrailingSlashPolicy } from '@typeroll/shared';
import type { ReadWriteStore } from '../datastore';
import { analyzeCoverage, type AnalyzedUrl, type UrlStatus } from './url-inventory';
import { publicUrlsFor } from '../site-public-urls';
import { vstore } from '../version-store';
import type { Site } from '@typeroll/shared';

export type ParityVerdict =
  /** 200 at the same path — the URL was preserved verbatim. */
  | 'ok'
  /** Redirected to a URL that answers 200. Link equity is passed on. */
  | 'ok_redirect'
  /** 404/410 on the new site. This is the gap: a live URL that will die. */
  | 'missing'
  /** Redirect chain that never terminated in a 200 (loop, or ends on a 404). */
  | 'broken_redirect'
  /** New site answered 5xx, or the request failed. Inconclusive — retry. */
  | 'error'
  /** Marked excluded in the inventory; checked but not counted as a gap. */
  | 'excluded';

export interface ParityResult {
  path: string;
  verdict: ParityVerdict;
  /** Status of the FIRST response (before following redirects). */
  status: number | null;
  /** Status after following the redirect chain, when one was followed. */
  final_status?: number;
  /** Where the chain landed, relative to the checked origin when possible. */
  final_url?: string;
  /** Number of hops followed. >1 is worth flattening: each hop costs. */
  hops?: number;
  /** Status the OLD site returns for the same path, when `checkSource` is on.
   *  A path that already 404s upstream isn't a regression — it's noise in the
   *  inventory, and marking it excluded is the right fix. */
  source_status?: number;
  /** Failure detail for `error`. */
  error?: string;
  /** Carried through from the inventory so callers can prioritise. */
  gsc_clicks?: number;
  /** Requests made for this path when an inconclusive result was retried. */
  attempts?: number;
  /** A query-string rule moved the visitor on with the published inline
   *  script, not an HTTP redirect. Browsers and Google follow it; it is not a 301. */
  client_redirect?: true;
}

export interface ParitySummary {
  checked: number;
  ok: number;
  ok_redirect: number;
  missing: number;
  broken_redirect: number;
  error: number;
  excluded: number;
}

export interface CheckParityOptions {
  /** Origin of the NEW site to test against, e.g. `https://acme.typeroll.app`. */
  targetOrigin: string;
  /** Origin of the OLD site. Only used when `checkSource` is true. */
  sourceOrigin?: string;
  /** Also request each path upstream, to separate "we lost it" from "it was
   *  already gone". Doubles the request count — off by default. */
  checkSource?: boolean;
  /** Skip entries the inventory marks excluded. On by default: they've been
   *  signed off, and checking them buries the real gaps in noise. */
  skipExcluded?: boolean;
  concurrency?: number;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  /** Extra rounds for inconclusive results (timeouts, network errors, 429 and
   *  5xx). Each round runs at low concurrency with twice the timeout. */
  retryRounds?: number;
  /** Cap on redirect hops before calling it a broken chain. */
  maxHops?: number;
  /** Canonical URL policy for the target site. A redirect that only adds or
   *  removes the canonical trailing slash is reported as `ok`, not as a
   *  content redirect that needs review. */
  trailingSlashPolicy?: TrailingSlashPolicy;
  fetchImpl?: typeof fetch;
  onProgress?: (done: number, total: number) => void;
  /** Backoff of retry rounds; tests inject `sleep`. */
  polite?: PoliteRetryOptions;
}

const publicationFetch: typeof fetch = (...args) => fetch(...args);

/** Parallel requests of the first pass, polite to throttling hosts and CDNs. */
export const PARITY_DEFAULT_CONCURRENCY = 4;

const DEFAULTS = {
  concurrency: PARITY_DEFAULT_CONCURRENCY,
  timeoutMs: 15_000,
  retryRounds: 2,
  retryConcurrency: 3,
  retryLimit: 60,
  maxHops: 5,
};

/**
 * Backoff in retry rounds: one polite retry per request, and short enough
 * waits for a synchronous verify call. A round waits base·2^(round-1).
 */
const RETRY_POLITE = { retries: 1, baseDelayMs: 2_000, maxDelayMs: 10_000 } as const;

/** Result of a host refusing for now (429, 503), as opposed to failing. */
function isRateLimited(result: ParityResult): boolean {
  const status = result.hops ? result.final_status ?? null : result.status;
  return status !== null && POLITE_RETRY_STATUSES.has(status);
}

/** One request to make: an inventory entry expanded to one observed path. */
export type ParityCheck = Pick<AnalyzedUrl, 'path' | 'excluded' | 'gsc_clicks'>;

/**
 * Resumable progress of a parity check. Plain JSON, so a workflow can persist
 * it between chunks and continue in another process: the first pass walks
 * `checks` in order from `next`; retry rounds then walk `pending` from
 * `pending_next`. A check is never requested again once its result is saved,
 * except as an inconclusive result in a retry round.
 */
export interface ParityProgress {
  checks: ParityCheck[];
  /** One slot per check; null until it has been requested. */
  results: Array<ParityResult | null>;
  next: number;
  done: number;
  /** 0 during the first pass, 1..retryRounds during retries. */
  round: number;
  pending: number[] | null;
  pending_next: number;
}

/** Expand inventory entries to the paths to request, as checkUrlParity does. */
export function startParity(
  urls: Array<Pick<AnalyzedUrl, 'path' | 'excluded' | 'gsc_clicks'> & Partial<Pick<AnalyzedUrl, 'full_url' | 'observed_paths'>>>,
): ParityProgress {
  const checks = urls.flatMap((entry) => {
    const observed = entry.observed_paths?.length ? entry.observed_paths : [entry.path];
    return [...new Set(observed)].map((path) => ({
      path,
      ...(entry.excluded ? { excluded: true } : {}),
      ...(entry.gsc_clicks !== undefined ? { gsc_clicks: entry.gsc_clicks } : {}),
    }));
  });
  return { checks, results: checks.map(() => null), next: 0, done: 0, round: 0, pending: null, pending_next: 0 };
}

export interface AdvanceParityOptions extends CheckParityOptions {
  /** Start no new request once this returns true; requests in flight finish. */
  shouldStop?: () => boolean;
  /** Start at most this many requests in this call. */
  maxChecks?: number;
}

/**
 * Advance a parity check by a bounded amount of work, mutating `state`.
 * Returns true once every check and retry round is done. Requests already
 * started always finish and are recorded, so `state` is consistent whenever
 * this returns.
 */
export async function advanceParity(state: ParityProgress, opts: AdvanceParityOptions): Promise<boolean> {
  const doFetch = opts.fetchImpl ?? publicationFetch;
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULTS.concurrency);
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
  const maxHops = opts.maxHops ?? DEFAULTS.maxHops;
  const skipExcluded = opts.skipExcluded !== false;
  const targetOrigin = stripTrailingSlash(opts.targetOrigin);
  const { checks, results } = state;
  const budget = opts.maxChecks ?? Infinity;
  let started = 0;
  const stop = () => started >= budget || (opts.shouldStop?.() ?? false);

  if (state.round === 0) {
    const worker = async (): Promise<void> => {
      for (;;) {
        if (state.next >= checks.length || stop()) return;
        const i = state.next++;
        started++;
        const entry = checks[i];
        results[i] = entry.excluded && skipExcluded
          ? { path: entry.path, verdict: 'excluded', status: null, gsc_clicks: entry.gsc_clicks }
          : await checkOne(entry, { doFetch, targetOrigin, timeoutMs, maxHops, opts });
        state.done++;
        opts.onProgress?.(state.done, checks.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, checks.length - state.next) }, worker));
    if (state.next < checks.length) return false;
    state.round = 1;
    state.pending = null;
  }

  // A busy host times out a few requests under parallel load and answers them
  // at once when asked again. Retry only inconclusive results, more gently.
  const retryRounds = Math.max(0, opts.retryRounds ?? DEFAULTS.retryRounds);
  const polite: PoliteRetryOptions = { ...RETRY_POLITE, ...opts.polite };
  while (state.round <= retryRounds) {
    if (state.pending === null) {
      const pending = results.flatMap((result, index) => result && isRetryable(result) ? [index] : []);
      // Many failures mean the host is down, not busy: report them without waiting longer.
      if (!pending.length || pending.length > Math.max(DEFAULTS.retryLimit, checks.length / 4)) break;
      state.pending = pending;
      state.pending_next = 0;
      // A host that asked us to slow down gets a pause before it is asked again.
      if (pending.some((index) => isRateLimited(results[index]!))) await (polite.sleep ?? defaultSleep)(politeDelayMs(state.round, null, polite), polite.signal);
    }
    const pending = state.pending;
    const round = state.round;
    const retryWorker = async (): Promise<void> => {
      for (;;) {
        if (state.pending_next >= pending.length || stop()) return;
        const index = pending[state.pending_next++];
        started++;
        const retried = { count: 0 };
        const result = await checkOne(checks[index], { doFetch, targetOrigin, timeoutMs: timeoutMs * 2, maxHops, opts, polite: { ...polite, onRetry: (info) => { retried.count++; polite.onRetry?.(info); } } });
        results[index] = { ...result, attempts: round + 1 + retried.count };
      }
    };
    await Promise.all(Array.from({ length: Math.min(DEFAULTS.retryConcurrency, pending.length - state.pending_next) }, retryWorker));
    if (state.pending_next < pending.length) return false;
    state.round++;
    state.pending = null;
  }
  state.round = retryRounds + 1;
  state.pending = null;
  return true;
}

/** Summarize a finished parity check, worst-first like checkUrlParity. */
export function finishParity(state: ParityProgress): { results: ParityResult[]; summary: ParitySummary } {
  const results = state.results.filter((r): r is ParityResult => r !== null);
  const summary: ParitySummary = {
    checked: results.length,
    ok: 0, ok_redirect: 0, missing: 0, broken_redirect: 0, error: 0, excluded: 0,
  };
  for (const r of results) summary[r.verdict]++;

  results.sort((a, b) => {
    const rank = verdictRank(a.verdict) - verdictRank(b.verdict);
    if (rank !== 0) return rank;
    const ca = a.gsc_clicks ?? 0;
    const cb = b.gsc_clicks ?? 0;
    if (ca !== cb) return cb - ca;
    return a.path.localeCompare(b.path);
  });

  return { results, summary };
}

/**
 * Check every URL against the new site. Returns one result per input URL,
 * ordered worst-first so the caller can act on the head of the list.
 */
export async function checkUrlParity(
  urls: Array<Pick<AnalyzedUrl, 'path' | 'excluded' | 'gsc_clicks'> & Partial<Pick<AnalyzedUrl, 'full_url' | 'observed_paths'>>>,
  opts: CheckParityOptions,
): Promise<{ results: ParityResult[]; summary: ParitySummary }> {
  const state = startParity(urls);
  while (!(await advanceParity(state, opts))) { /* unbounded: runs to the end */ }
  return finishParity(state);
}

async function checkOne(
  entry: Pick<AnalyzedUrl, 'path' | 'excluded' | 'gsc_clicks'>,
  args: {
    doFetch: typeof fetch;
    targetOrigin: string;
    timeoutMs: number;
    maxHops: number;
    opts: CheckParityOptions;
    /** Retry rounds only: wait out 429 and 503 as the host asks. */
    polite?: PoliteRetryOptions;
  },
): Promise<ParityResult> {
  const { doFetch, targetOrigin, timeoutMs, maxHops, opts, polite } = args;
  const base: ParityResult = { path: entry.path, verdict: 'error', status: null, gsc_clicks: entry.gsc_clicks };

  if (opts.checkSource && opts.sourceOrigin) {
    const src = await safeFetch(doFetch, join(stripTrailingSlash(opts.sourceOrigin), entry.path), timeoutMs, 'follow', false, polite);
    if (src.ok) base.source_status = src.response.status;
  }

  let current = join(targetOrigin, entry.path);
  let hops = 0;
  let firstStatus: number | null = null;
  let clientRedirect = false;

  for (;;) {
    // Query-string rules are published as an inline script in the document
    // that answers the path (or 404.html), so read the body for those URLs.
    const attempt = await safeFetch(doFetch, current, timeoutMs, 'manual', hasQuery(current), polite);
    if (!attempt.ok) {
      // A failed later hop keeps the first status (a redirect) and has no
      // final_status; isRetryable treats it as the transient failure it is.
      return { ...base, verdict: 'error', status: firstStatus, ...(hops > 0 ? { hops, final_url: current } : {}), error: attempt.error };
    }
    const res = attempt.response;
    if (firstStatus === null) firstStatus = res.status;

    if (isRedirect(res.status)) {
      const location = res.headers.get('location');
      if (!location) {
        return { ...base, verdict: 'broken_redirect', status: firstStatus, hops, error: 'redirect without Location' };
      }
      hops++;
      if (hops > maxHops) {
        return { ...base, verdict: 'broken_redirect', status: firstStatus, hops, final_url: current, error: 'too many hops (loop?)' };
      }
      let next: string;
      try {
        next = new URL(location, current).toString();
      } catch {
        return { ...base, verdict: 'broken_redirect', status: firstStatus, hops, error: `unparseable Location: ${location}` };
      }
      if (next === current) {
        return { ...base, verdict: 'broken_redirect', status: firstStatus, hops, final_url: next, error: 'self-referential redirect' };
      }
      current = next;
      continue;
    }

    const scripted = attempt.body !== undefined && (res.ok || res.status === 404)
      ? embeddedQueryRedirectTarget(attempt.body, current)
      : null;
    if (scripted) {
      hops++;
      if (hops > maxHops) {
        return { ...base, verdict: 'broken_redirect', status: firstStatus, hops, final_url: current, client_redirect: true, error: 'too many hops (loop?)' };
      }
      if (scripted === current) {
        return { ...base, verdict: 'broken_redirect', status: firstStatus, hops, final_url: current, client_redirect: true, error: 'self-referential redirect' };
      }
      clientRedirect = true;
      current = scripted;
      continue;
    }

    // Terminal response.
    const canonicalOnly = hops > 0 && res.ok && isCanonicalSlashRedirect(
      entry.path,
      current,
      targetOrigin,
      opts.trailingSlashPolicy ?? 'ignore',
    );
    const verdict: ParityVerdict = res.ok
      ? (hops > 0 && !canonicalOnly ? 'ok_redirect' : 'ok')
      : res.status === 404 || res.status === 410
        ? 'missing'
        : 'error';
    return {
      ...base,
      verdict,
      status: firstStatus,
      ...(hops > 0 ? { hops, final_status: res.status, final_url: current } : {}),
      ...(clientRedirect ? { client_redirect: true as const } : {}),
      ...(verdict === 'error' ? { error: [401,403,429].includes(res.status) ? `Verifier access blocked (HTTP ${res.status}). Allow the Typeroll-URL-Parity verifier in the host's access/bot policy and retry this check; this does not prove a missing page or actual crawler access.` : `unexpected status ${res.status}` } : {}),
    };
  }
}

export interface SiteParityArgs {
  store: ReadWriteStore;
  orgId: string;
  siteId: string;
  versionId: string;
  site: Site & { id: string };
  /** Override the origin to test. Defaults to the site's fallback subdomain
   *  (the pre-cutover URL), then its live production URL. */
  targetOrigin?: string;
  sourceOrigin?: string;
  checkSource?: boolean;
  /** Only check inventory entries with these coverage statuses. The useful
   *  narrowing is `['unhandled','redirected']` — the ones most likely to be
   *  wrong — but the default is everything, because "migrated" is exactly
   *  the claim a parity check exists to falsify. */
  statuses?: UrlStatus[];
  limit?: number;
  concurrency?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  onProgress?: (done: number, total: number) => void;
}

export interface SiteParityReport {
  target_origin: string;
  checked: number;
  /** Number of requests in a complete run, including observed slash variants. */
  expected_checks: number;
  /** Inventory size before filtering/limiting, so a capped run can't read
   *  as full coverage. */
  inventory_total: number;
  truncated: boolean;
  summary: ParitySummary;
  results: ParityResult[];
  redirects_verified: number;
}

export interface StoredSiteParityEvidence extends SiteParityReport {
  version_id: string;
  checked_at: string;
  deployment_job_id: string | null;
  deployment_finished_at: string | null;
  complete: true;
  /** Detailed rows are intentionally omitted from persistent evidence. */
  results: [];
}

/**
 * What a site parity run checks, resolved once at its start. Plain JSON: the
 * URL parity workflow keeps it, with the progress, between chunks.
 */
export interface SiteParityPlan {
  target_origin: string;
  trailing_slash: TrailingSlashPolicy;
  expected_checks: number;
  inventory_total: number;
  truncated: boolean;
  /** A status filter narrowed the run; it then leaves no stored evidence. */
  filtered: boolean;
  progress: ParityProgress;
}

/** Resolve the origin and the inventory slice to check, without requesting anything. */
export async function planSiteParity(args: SiteParityArgs): Promise<SiteParityPlan> {
  const urls = publicUrlsFor(args.site);
  const targetOrigin = stripTrailingSlash(
    args.targetOrigin || urls.fallback || urls.production || '',
  );
  if (!targetOrigin) {
    throw new Error(
      'No origin to check against. The site has no live domain yet — pass target_origin explicitly, for example the temporary address it publishes to.',
    );
  }

  const { urls: inventory } = await analyzeCoverage(args.store, args.orgId, args.siteId, args.versionId);
  const filtered = args.statuses?.length
    ? inventory.filter((u) => args.statuses!.includes(u.status))
    : inventory;
  const limit = args.limit && args.limit > 0 ? args.limit : filtered.length;
  const slice = filtered.slice(0, limit);
  const expectedChecks = inventory.reduce(
    (total, entry) => total + new Set(entry.observed_paths?.length ? entry.observed_paths : [entry.path]).size,
    0,
  );
  return {
    target_origin: targetOrigin,
    trailing_slash: (await vstore.settings(args.orgId, args.siteId, args.versionId))?.trailing_slash ?? 'always',
    expected_checks: expectedChecks,
    inventory_total: inventory.length,
    truncated: slice.length < filtered.length,
    filtered: Boolean(args.statuses?.length),
    progress: startParity(slice),
  };
}

/** Advance a planned site parity run by a bounded amount of work; true once done. */
export function advanceSiteParity(
  args: Pick<SiteParityArgs, 'sourceOrigin' | 'checkSource' | 'concurrency' | 'timeoutMs' | 'fetchImpl' | 'onProgress'>,
  plan: SiteParityPlan,
  bounds: Pick<AdvanceParityOptions, 'shouldStop' | 'maxChecks'> = {},
): Promise<boolean> {
  return advanceParity(plan.progress, {
    targetOrigin: plan.target_origin,
    sourceOrigin: args.sourceOrigin,
    checkSource: args.checkSource,
    concurrency: args.concurrency,
    timeoutMs: args.timeoutMs,
    fetchImpl: args.fetchImpl,
    onProgress: args.onProgress,
    trailingSlashPolicy: plan.trailing_slash,
    ...bounds,
  });
}

/** Stamp the redirect rules, store complete evidence and build the report of a finished run. */
export async function finishSiteParity(
  args: Pick<SiteParityArgs, 'store' | 'orgId' | 'siteId' | 'versionId'>,
  plan: SiteParityPlan,
): Promise<SiteParityReport> {
  const { results, summary } = finishParity(plan.progress);
  const redirects = await vstore.redirects(args.orgId, args.siteId, args.versionId);
  const redirects_verified = await recordRedirectVerification(
    args.store, args.orgId, args.siteId, args.versionId, redirects, results,
  );
  const report: SiteParityReport = {
    target_origin: plan.target_origin,
    checked: results.length,
    expected_checks: plan.expected_checks,
    inventory_total: plan.inventory_total,
    truncated: plan.truncated,
    summary,
    results,
    redirects_verified,
  };
  if (!plan.filtered && !report.truncated) {
    const deploys = await args.store.listDocs<DeployJob>(paths.deploys(args.orgId, args.siteId));
    const latestDeploy = deploys
      .filter((job) => job.version_id === args.versionId && job.status === 'succeeded' && job.dry_run !== true)
      .sort((a, b) => (b.finished_at ?? b.started_at).localeCompare(a.finished_at ?? a.started_at))[0];
    const evidence: StoredSiteParityEvidence = {
      ...report,
      version_id: args.versionId,
      checked_at: new Date().toISOString(),
      deployment_job_id: latestDeploy?.id ?? null,
      deployment_finished_at: latestDeploy?.finished_at ?? null,
      complete: true,
      results: [],
    };
    await args.store.setDoc(
      paths.migrationVerification(args.orgId, args.siteId, args.versionId),
      evidence as unknown as Record<string, unknown>,
    );
  }
  return report;
}

/**
 * End-to-end parity run for one site: read the inventory, hit every URL on
 * the new site, stamp the redirect rules, report. Used by the v1 route
 * (synchronous, agents); the workflow runs the same three parts in chunks.
 */
export async function runSiteParityCheck(args: SiteParityArgs): Promise<SiteParityReport> {
  const plan = await planSiteParity(args);
  while (!(await advanceSiteParity(args, plan))) { /* unbounded: runs to the end */ }
  return finishSiteParity(args, plan);
}

/**
 * Stamp the parity outcome onto the redirect rules it exercised.
 *
 * `Redirect.verified` / `last_checked` have been in the data model since
 * redirects shipped and nothing wrote them — a rule was "probably fine"
 * forever. A parity run is exactly the event that knows: it followed the
 * chain and saw where it landed.
 *
 * Only rules whose `from_path` was actually checked are touched, so a
 * filtered or partial run never marks an unchecked rule as verified.
 */
export async function recordRedirectVerification(
  store: ReadWriteStore,
  orgId: string,
  siteId: string,
  versionId: string,
  redirects: Redirect[],
  results: ParityResult[],
): Promise<number> {
  const byPath = new Map<string, ParityResult>();
  for (const r of results) {
    const key = r.path.replace(/\/+$/, '') || '/';
    const previous = byPath.get(key);
    if (!previous || verdictRank(r.verdict) < verdictRank(previous.verdict)) byPath.set(key, r);
  }

  const now = new Date().toISOString();
  let written = 0;
  for (const rule of redirects) {
    const key = rule.from_path.replace(/\/+$/, '') || '/';
    const result = byPath.get(key);
    if (!result) continue;
    // 'error' is inconclusive (timeout, 5xx upstream) — recording it as
    // unverified would turn a flaky network into a false alarm.
    if (result.verdict === 'error' || result.verdict === 'excluded') continue;
    const verified = result.verdict === 'ok' || result.verdict === 'ok_redirect';
    if (rule.verified === verified && rule.last_checked === now) continue;
    await store.updateDoc(`${paths.redirects(orgId, siteId, versionId)}/${rule.id}`, {
      verified,
      last_checked: now,
    });
    written++;
  }
  return written;
}

type FetchAttempt =
  | { ok: true; response: Response; body?: string }
  | { ok: false; error: string };

/** Enough for any page head, where the query redirect script sits. */
const BODY_LIMIT = 1024 * 1024;

function hasQuery(url: string): boolean {
  try { return new URL(url).search.length > 1; } catch { return false; }
}

async function readLimited(res: Response): Promise<string | undefined> {
  if (!res.body) return undefined;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (size >= BODY_LIMIT) break;
    }
  } catch {
    return text || undefined;
  } finally {
    void reader.cancel().catch(() => {});
  }
  return text;
}

/** One request, retried while the host answers 429 or 503 when `polite` is given. */
async function safeFetch(
  doFetch: typeof fetch,
  url: string,
  timeoutMs: number,
  redirect: RequestRedirect,
  readBody = false,
  polite?: PoliteRetryOptions,
): Promise<FetchAttempt> {
  const retries = polite ? Math.max(0, polite.retries ?? 0) : 0;
  for (let attempt = 1; ; attempt++) {
    const result = await fetchOnce(doFetch, url, timeoutMs, redirect, readBody);
    if (!polite || !result.ok || attempt > retries || !POLITE_RETRY_STATUSES.has(result.response.status)) return result;
    const delayMs = politeDelayMs(attempt, result.response.headers.get('retry-after'), polite);
    polite.onRetry?.({ attempt, status: result.response.status, delayMs });
    await (polite.sleep ?? defaultSleep)(delayMs, polite.signal);
  }
}

async function fetchOnce(
  doFetch: typeof fetch,
  url: string,
  timeoutMs: number,
  redirect: RequestRedirect,
  readBody: boolean,
): Promise<FetchAttempt> {
  const finish = async (res: Response): Promise<FetchAttempt> => {
    if (readBody && !isRedirect(res.status)) return { ok: true, response: res, body: await readLimited(res) };
    void res.body?.cancel?.().catch(() => {});
    return { ok: true, response: res };
  };
  try {
    // GET, not HEAD: static hosts (Cloudflare Pages included) and CDNs are
    // less consistent about HEAD, and a 405 on HEAD would read as a broken
    // URL. Only URLs with a query string read the body (capped), to find the
    // published query redirect script; others cost headers plus an aborted stream.
    const init: RequestInit = {
      method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'Typeroll-URL-Parity/1.0' },
    };
    if (doFetch === publicationFetch) {
      if (url.startsWith('https://')) {
        const checked = await publicationResponse(new URL(url), init);
        try { return await finish(checked.response); } finally { await checked.close(); }
      }
      // Plain-http origins (often the old WordPress source) get the same
      // public-destination guard; 'follow' re-checks every redirect hop.
      const res = await guardedFetch(url, { ...init, redirect }, {
        allowHttp: true, privateNetwork: 'self_hosted_opt_in', label: 'Parity URL', timeoutMs, maxBytes: 1024 * 1024,
      });
      return await finish(res);
    }
    const res = await doFetch(url, {
      method: 'GET',
      redirect,
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'Typeroll-URL-Parity/1.0' },
    });
    return await finish(res);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Timeouts, network errors, rate limits and 5xx can pass; a real 4xx cannot. */
function isRetryable(result: ParityResult): boolean {
  if (result.verdict !== 'error') return false;
  // After a redirect, judge the hop that failed: no final status means the
  // request itself failed (timeout or network error).
  const status = result.hops ? result.final_status ?? null : result.status;
  return status === null || status === 429 || status >= 500;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function verdictRank(v: ParityVerdict): number {
  switch (v) {
    case 'missing':         return 0;
    case 'broken_redirect': return 1;
    case 'error':           return 2;
    case 'ok_redirect':     return 3;
    case 'ok':              return 4;
    case 'excluded':        return 5;
  }
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

function join(origin: string, path: string): string {
  return `${origin}${path.startsWith('/') ? '' : '/'}${path}`;
}

function isCanonicalSlashRedirect(
  originalPath: string,
  finalUrl: string,
  targetOrigin: string,
  policy: TrailingSlashPolicy,
): boolean {
  try {
    const final = new URL(finalUrl);
    const target = new URL(targetOrigin);
    if (final.origin !== target.origin) return false;
    const normalize = (value: string): string => {
      if (policy === 'ignore') {
        const [pathname, suffix = ''] = value.split(/(?=[?#])/u, 2);
        return `${pathname.replace(/\/+$/, '') || '/'}${suffix}`;
      }
      return applyTrailingSlash(value, policy);
    };
    return normalize(originalPath) === normalize(`${final.pathname}${final.search}`);
  } catch {
    return false;
  }
}
