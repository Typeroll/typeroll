import { checkPreviousHost, type PreviousHost } from './publishing/previous-hosts';
import type { Site, SiteSettings } from '@typeroll/shared';
import { publicUrlsFor } from './site-public-urls';
import { assertPublicDestination } from './extensions/public-http';
import { parseOutboundUrl } from './net/safe-fetch';
import { missingDns, publicationResponse } from './deploy/public-response';
import { markerPublication, otherHostRemedy, providerHint, publicationHeader, PUBLICATION_MARKER, type ProviderHint } from './publishing/serving-host';

const BODY_LIMIT = 2 * 1024 * 1024;

// Default transport: the publication checker. Public HTTPS only, pinned to a
// validated address, no redirect following (probeTarget follows and validates
// hops itself). A site host created minutes ago can still be cached as
// missing by the portal's resolver; the checker then confirms it through
// public DNS instead of failing with ENOTFOUND.
const diagnosticsFetch: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const { response, close } = await publicationResponse(url, init ?? {});
  try {
    const body = init?.method === 'HEAD' || [101, 204, 205, 304].includes(response.status) ? null : await readLimited(response);
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } finally {
    await close();
  }
};

async function readLimited(response: Response): Promise<ArrayBuffer | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > BODY_LIMIT) break;
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  const joined = Buffer.concat(chunks);
  return joined.buffer.slice(joined.byteOffset, joined.byteOffset + joined.byteLength) as ArrayBuffer;
}

/** The publication checker validates every address itself, including a host
 *  only public DNS knows yet, so a missing local DNS answer is not final here. */
async function validateForPublicationChecker(url: URL): Promise<void> {
  try {
    await assertPublicDestination(url);
  } catch (error) {
    if (!missingDns(error)) throw error;
  }
}

const NOT_RESOLVABLE = 'The host does not resolve in DNS yet. A new site address can take a few minutes to appear; run the check again shortly.';

function describeFailure(error: unknown, fallback: string): string {
  if (missingDns(error)) return NOT_RESOLVABLE;
  return error instanceof Error ? error.message : fallback;
}

export type IndexingTargetKind = 'fallback' | 'production';

export interface IndexingTargetDiagnostic {
  kind: IndexingTargetKind;
  origin: string;
  expected: 'noindex' | 'indexable';
  expectation_reason: 'fallback_protection' | 'platform_robots_blocked' | 'sitewide_noindex' | 'public_site';
  reachable: boolean;
  head_status: number | null;
  get_status: number | null;
  x_robots_tag: string | null;
  meta_robots: string | null;
  header_noindex: boolean;
  meta_noindex: boolean;
  effective_noindex: boolean;
  robots_txt_status: number | null;
  robots_txt_blocks_all: boolean | null;
  /** The Typeroll publication that answered (X-Typeroll-Publication, else publication.json), or null. */
  serving_publication: string | null;
  /** Whether the expected Typeroll publication answered; null when nothing answered. */
  serving_typeroll: boolean | null;
  /** A likely previous host named by a well-known response header. */
  provider_hint: ProviderHint | null;
  matches_expected: boolean;
  issues: string[];
}

export interface SiteIndexingDiagnosticReport {
  previous_hosts?: PreviousHost[];
  checked_at: string;
  sitewide_noindex: boolean;
  ready: boolean;
  targets: IndexingTargetDiagnostic[];
  issues: string[];
}

export interface SiteIndexingDiagnosticOptions {
  /** Publishing policy supplied by the authenticated route, never inferred from the response being tested. */
  robotsBlocked?: boolean;
  previousHosts?: PreviousHost[];
  publicationId?: string;
  fetchImpl?: typeof fetch;
  validateDestination?: (url: URL) => Promise<void>;
  now?: () => Date;
  timeoutMs?: number;
}

/**
 * Probe the public addresses Typeroll itself has recorded for a site. The
 * report deliberately keeps crawl policy (robots.txt) separate from indexing
 * directives (X-Robots-Tag and HTML meta), because one cannot substitute for
 * the other.
 */
export async function diagnoseSiteIndexing(
  site: Site & { id: string },
  settings: SiteSettings,
  opts: SiteIndexingDiagnosticOptions = {},
): Promise<SiteIndexingDiagnosticReport> {
  const urls = publicUrlsFor(site);
  const entries: IndexingTarget[] = [];
  if (urls.fallback) entries.push({ kind: 'fallback', origin: urls.fallback, expected: 'noindex', expectation_reason: 'fallback_protection' });
  if (urls.production && urls.production !== urls.fallback) {
    entries.push({
      kind: 'production',
      origin: urls.production,
      expected: opts.robotsBlocked || settings.sitewide_noindex === true ? 'noindex' : 'indexable',
      expectation_reason: opts.robotsBlocked ? 'platform_robots_blocked' : settings.sitewide_noindex === true ? 'sitewide_noindex' : 'public_site',
    });
  }

  const targets = await Promise.all(entries.map((entry) => probeTarget(entry, opts)));
  const issues = targets.flatMap((target) => target.issues.map((issue) => `${target.kind}: ${issue}`));
  const previousHosts: PreviousHost[] = [];
  for (const previous of opts.previousHosts ?? []) {
    try {
      await (opts.validateDestination ?? assertPublicDestination)(new URL(`https://${previous.host}/`));
      previousHosts.push(await checkPreviousHost(previous.host, previous.target_host, opts.publicationId ?? '', opts.fetchImpl));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Previous address could not be verified.';
      previousHosts.push({ ...previous, status: 'pending', message });
      issues.push(`previous ${previous.host}: ${message}`);
    }
  }
  if (targets.length === 0) issues.push('No fallback or live production URL is available to probe.');

  return {
    checked_at: (opts.now?.() ?? new Date()).toISOString(),
    sitewide_noindex: settings.sitewide_noindex === true,
    ready: targets.length > 0 && issues.length === 0,
    targets,
    ...(previousHosts.length ? { previous_hosts: previousHosts } : {}),
    issues,
  };
}

type IndexingTarget = Pick<IndexingTargetDiagnostic, 'kind' | 'origin' | 'expected' | 'expectation_reason'>;

async function probeTarget(
  target: IndexingTarget,
  opts: SiteIndexingDiagnosticOptions,
): Promise<IndexingTargetDiagnostic> {
  const fetchImpl = opts.fetchImpl ?? diagnosticsFetch;
  const validate = opts.validateDestination ?? (opts.fetchImpl ? assertPublicDestination : validateForPublicationChecker);
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const root = new URL('/', ensureTrailingSlash(target.origin));
  const robotsUrl = new URL('/robots.txt', root);
  const issues: string[] = [];

  try {
    await validate(root);
  } catch (error) {
    issues.push(describeFailure(error, 'The target is not a public destination.'));
    return emptyDiagnostic(target, issues);
  }

  const [head, get, robots] = await Promise.all([
    safeFetch(fetchImpl, root, 'HEAD', timeoutMs, validate),
    safeFetch(fetchImpl, root, 'GET', timeoutMs, validate),
    safeFetch(fetchImpl, robotsUrl, 'GET', timeoutMs, validate),
  ]);
  const xRobotsTag = joinHeaderValues(head.response, get.response, 'x-robots-tag');
  const html = get.response ? await safeText(get.response) : '';
  const robotsText = robots.response ? await safeText(robots.response) : '';
  const metaRobots = extractRobotsMeta(html);
  const headerNoindex = hasDirective(xRobotsTag, 'noindex');
  const metaNoindex = hasDirective(metaRobots, 'noindex');
  const effectiveNoindex = headerNoindex || metaNoindex;
  const reachable = Boolean(get.response?.ok);
  const robotsBlocksAll = robots.response?.ok ? blocksAllCrawlers(robotsText) : null;
  // Robots findings only describe this site when its own publication answered.
  const answered = Boolean(get.response || head.response);
  let servingPublication = publicationHeader(get.response) ?? publicationHeader(head.response);
  if (!servingPublication && answered) {
    const marker = await safeFetch(fetchImpl, new URL(PUBLICATION_MARKER, root), 'GET', timeoutMs, validate);
    servingPublication = await markerPublication(marker.response);
  }
  const hint = providerHint(get.response?.headers, head.response?.headers);
  const servingTyperoll = !answered ? null : opts.publicationId ? servingPublication === opts.publicationId : servingPublication !== null;
  const otherServer = Boolean(opts.publicationId) && servingTyperoll === false;

  if (!reachable) issues.push(get.error ?? `GET / returned ${get.response?.status ?? 'no response'}.`);
  if (target.expected === 'noindex' && !effectiveNoindex) {
    issues.push('Expected noindex, but neither X-Robots-Tag nor the HTML robots meta contains it.');
  }
  if (target.expected === 'indexable' && effectiveNoindex) {
    issues.push('Expected an indexable document, but an effective noindex directive was found.');
  }
  if (target.kind === 'fallback' && !headerNoindex) {
    issues.push('The fallback response is missing the documented edge X-Robots-Tag noindex protection.');
  }
  if (!robots.response?.ok) {
    issues.push(robots.error ?? `GET /robots.txt returned ${robots.response?.status ?? 'no response'}.`);
  }
  if (otherServer && servingPublication) {
    issues.push(`This address serves Typeroll publication ${servingPublication}, not the current publication ${opts.publicationId}. The robots findings describe that publication. Check that the domain is not attached to another Typeroll site or project and purge stale cache, then run the check again.`);
  } else if (otherServer) {
    const source = hint ? ` It looks like ${hint.name} (${hint.evidence}).` : '';
    issues.push(`This address is not served by Typeroll: the response carries no Typeroll publication.${source} The robots findings above describe that other host, not this site. ${otherHostRemedy(hint)}`);
  }

  return {
    kind: target.kind,
    origin: target.origin,
    expected: target.expected,
    expectation_reason: target.expectation_reason,
    reachable,
    head_status: head.response?.status ?? null,
    get_status: get.response?.status ?? null,
    x_robots_tag: xRobotsTag,
    meta_robots: metaRobots,
    header_noindex: headerNoindex,
    meta_noindex: metaNoindex,
    effective_noindex: effectiveNoindex,
    robots_txt_status: robots.response?.status ?? null,
    robots_txt_blocks_all: robotsBlocksAll,
    serving_publication: servingPublication,
    serving_typeroll: servingTyperoll,
    provider_hint: hint,
    matches_expected: !otherServer && (target.expected === 'noindex' ? effectiveNoindex : !effectiveNoindex),
    issues,
  };
}

function emptyDiagnostic(
  target: IndexingTarget,
  issues: string[],
): IndexingTargetDiagnostic {
  return {
    ...target,
    reachable: false,
    head_status: null,
    get_status: null,
    x_robots_tag: null,
    meta_robots: null,
    header_noindex: false,
    meta_noindex: false,
    effective_noindex: false,
    robots_txt_status: null,
    robots_txt_blocks_all: null,
    serving_publication: null,
    serving_typeroll: null,
    provider_hint: null,
    matches_expected: false,
    issues,
  };
}

type FetchResult = { response?: Response; error?: string };

async function safeFetch(
  fetchImpl: typeof fetch,
  url: URL,
  method: 'GET' | 'HEAD',
  timeoutMs: number,
  validateDestination: (url: URL) => Promise<void>,
): Promise<FetchResult> {
  try {
    let current = url;
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (current.protocol !== 'https:' || current.username || current.password) {
        throw new Error('Indexing diagnostics only follow public HTTPS URLs without credentials.');
      }
      // Every hop, IP literals included, must be a public HTTPS destination.
      try { parseOutboundUrl(current); } catch { throw new Error('Indexing diagnostics only follow public HTTPS URLs without credentials.'); }
      await validateDestination(current);
      const response = await fetchImpl(current, {
        method,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'user-agent': 'Typeroll-Indexing-Diagnostics/1.0' },
      });
      if (response.status < 300 || response.status >= 400) return { response };
      const location = response.headers.get('location');
      if (!location) return { response };
      if (redirects === 5) throw new Error('Indexing diagnostic exceeded 5 redirects.');
      void response.body?.cancel?.().catch(() => {});
      current = new URL(location, current);
    }
    throw new Error('Indexing diagnostic redirect loop.');
  } catch (error) {
    return { error: describeFailure(error, String(error)) };
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function joinHeaderValues(a: Response | undefined, b: Response | undefined, name: string): string | null {
  const values = [a?.headers.get(name), b?.headers.get(name)].filter((value): value is string => Boolean(value));
  return values.length ? [...new Set(values)].join(', ') : null;
}

function hasDirective(value: string | null, directive: string): boolean {
  return Boolean(value?.toLowerCase().split(/[;,]/).some((part) => part.trim().split(/\s+/).includes(directive)));
}

export function extractRobotsMeta(html: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const name = attribute(tag, 'name')?.toLowerCase();
    if (name === 'robots' || name === 'googlebot') return attribute(tag, 'content');
  }
  return null;
}

function attribute(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return match ? (match[1] ?? match[2] ?? match[3] ?? '') : null;
}

export function blocksAllCrawlers(robotsTxt: string): boolean {
  let agents: string[] = [];
  let sawDirective = false;
  for (const raw of robotsTxt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) {
      agents = [];
      sawDirective = false;
      continue;
    }
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === 'user-agent') {
      if (sawDirective) agents = [];
      agents.push(value.toLowerCase());
      sawDirective = false;
    } else if (field === 'disallow' && agents.includes('*') && value === '/') {
      return true;
    } else {
      sawDirective = true;
    }
  }
  return false;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}
