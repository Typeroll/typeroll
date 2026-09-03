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

import { applyTrailingSlash, paths } from '@typeroll/shared';
import type { Redirect } from '@typeroll/shared';
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
  /** Cap on redirect hops before calling it a broken chain. */
  maxHops?: number;
  /** Canonical URL policy for the target site. A redirect that only adds or
   *  removes the canonical trailing slash is reported as `ok`, not as a
   *  content redirect that needs review. */
  trailingSlashPolicy?: TrailingSlashPolicy;
  fetchImpl?: typeof fetch;
  onProgress?: (done: number, total: number) => void;
}

const DEFAULTS = {
  concurrency: 6,
  timeoutMs: 15_000,
  maxHops: 5,
};

/**
 * Check every URL against the new site. Returns one result per input URL,
 * ordered worst-first so the caller can act on the head of the list.
 */
export async function checkUrlParity(
  urls: Array<Pick<AnalyzedUrl, 'path' | 'excluded' | 'gsc_clicks'>>,
  opts: CheckParityOptions,
): Promise<{ results: ParityResult[]; summary: ParitySummary }> {
  const doFetch = opts.fetchImpl ?? fetch;
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULTS.concurrency);
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
  const maxHops = opts.maxHops ?? DEFAULTS.maxHops;
  const skipExcluded = opts.skipExcluded !== false;
  const targetOrigin = stripTrailingSlash(opts.targetOrigin);

  const results: ParityResult[] = new Array(urls.length);
  let cursor = 0;
  let done = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= urls.length) return;
      const entry = urls[i];
      results[i] = entry.excluded && skipExcluded
        ? { path: entry.path, verdict: 'excluded', status: null, gsc_clicks: entry.gsc_clicks }
        : await checkOne(entry, { doFetch, targetOrigin, timeoutMs, maxHops, opts });
      done++;
      opts.onProgress?.(done, urls.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));

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

async function checkOne(
  entry: Pick<AnalyzedUrl, 'path' | 'excluded' | 'gsc_clicks'>,
  args: {
    doFetch: typeof fetch;
    targetOrigin: string;
    timeoutMs: number;
    maxHops: number;
    opts: CheckParityOptions;
  },
): Promise<ParityResult> {
  const { doFetch, targetOrigin, timeoutMs, maxHops, opts } = args;
  const base: ParityResult = { path: entry.path, verdict: 'error', status: null, gsc_clicks: entry.gsc_clicks };

  if (opts.checkSource && opts.sourceOrigin) {
    const src = await safeFetch(doFetch, join(stripTrailingSlash(opts.sourceOrigin), entry.path), timeoutMs, 'follow');
    if (src.ok) base.source_status = src.response.status;
  }

  let current = join(targetOrigin, entry.path);
  let hops = 0;
  let firstStatus: number | null = null;

  for (;;) {
    const attempt = await safeFetch(doFetch, current, timeoutMs, 'manual');
    if (!attempt.ok) {
      return { ...base, verdict: 'error', status: firstStatus, error: attempt.error };
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
      ...(verdict === 'error' ? { error: `unexpected status ${res.status}` } : {}),
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
  /** Inventory size before filtering/limiting, so a capped run can't read
   *  as full coverage. */
  inventory_total: number;
  truncated: boolean;
  summary: ParitySummary;
  results: ParityResult[];
  redirects_verified: number;
}

/**
 * End-to-end parity run for one site: read the inventory, hit every URL on
 * the new site, stamp the redirect rules, report. Shared by the workflow
 * (progress-reporting, portal UI) and the v1 route (synchronous, agents).
 */
export async function runSiteParityCheck(args: SiteParityArgs): Promise<SiteParityReport> {
  const urls = publicUrlsFor(args.site);
  const targetOrigin = stripTrailingSlash(
    args.targetOrigin || urls.fallback || urls.production || '',
  );
  if (!targetOrigin) {
    throw new Error(
      'No origin to check against. The site has neither a fallback subdomain nor a live domain — pass target_origin explicitly.',
    );
  }

  const { urls: inventory } = await analyzeCoverage(args.store, args.orgId, args.siteId);
  const filtered = args.statuses?.length
    ? inventory.filter((u) => args.statuses!.includes(u.status))
    : inventory;
  const limit = args.limit && args.limit > 0 ? args.limit : filtered.length;
  const slice = filtered.slice(0, limit);

  const { results, summary } = await checkUrlParity(slice, {
    targetOrigin,
    sourceOrigin: args.sourceOrigin,
    checkSource: args.checkSource,
    concurrency: args.concurrency,
    timeoutMs: args.timeoutMs,
    fetchImpl: args.fetchImpl,
    onProgress: args.onProgress,
    trailingSlashPolicy: (await vstore.settings(
      args.orgId,
      args.siteId,
      args.versionId,
    ))?.trailing_slash ?? 'always',
  });

  const redirects = await vstore.redirects(args.orgId, args.siteId, args.versionId);
  const redirects_verified = await recordRedirectVerification(
    args.store, args.orgId, args.siteId, args.versionId, redirects, results,
  );

  return {
    target_origin: targetOrigin,
    checked: results.length,
    inventory_total: inventory.length,
    truncated: slice.length < filtered.length,
    summary,
    results,
    redirects_verified,
  };
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
  for (const r of results) byPath.set(r.path.replace(/\/+$/, '') || '/', r);

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
  | { ok: true; response: Response }
  | { ok: false; error: string };

async function safeFetch(
  doFetch: typeof fetch,
  url: string,
  timeoutMs: number,
  redirect: RequestRedirect,
): Promise<FetchAttempt> {
  try {
    // GET, not HEAD: static hosts (Cloudflare Pages included) and CDNs are
    // less consistent about HEAD, and a 405 on HEAD would read as a broken
    // URL. We never read the body, so the cost is the response headers plus
    // an aborted stream.
    const res = await doFetch(url, {
      method: 'GET',
      redirect,
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'Typeroll-URL-Parity/1.0' },
    });
    void res.body?.cancel?.().catch(() => {});
    return { ok: true, response: res };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
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
