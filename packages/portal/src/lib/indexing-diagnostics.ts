import type { Site, SiteSettings } from '@typeroll/shared';
import { publicUrlsFor } from './site-public-urls';
import { assertPublicDestination } from './extensions/public-http';

export type IndexingTargetKind = 'fallback' | 'production';

export interface IndexingTargetDiagnostic {
  kind: IndexingTargetKind;
  origin: string;
  expected: 'noindex' | 'indexable';
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
  matches_expected: boolean;
  issues: string[];
}

export interface SiteIndexingDiagnosticReport {
  checked_at: string;
  sitewide_noindex: boolean;
  ready: boolean;
  targets: IndexingTargetDiagnostic[];
  issues: string[];
}

export interface SiteIndexingDiagnosticOptions {
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
  const entries: Array<{ kind: IndexingTargetKind; origin: string; expected: 'noindex' | 'indexable' }> = [];
  if (urls.fallback) entries.push({ kind: 'fallback', origin: urls.fallback, expected: 'noindex' });
  if (urls.production && urls.production !== urls.fallback) {
    entries.push({
      kind: 'production',
      origin: urls.production,
      expected: settings.sitewide_noindex === true ? 'noindex' : 'indexable',
    });
  }

  const targets = await Promise.all(entries.map((entry) => probeTarget(entry, opts)));
  const issues = targets.flatMap((target) => target.issues.map((issue) => `${target.kind}: ${issue}`));
  if (targets.length === 0) issues.push('No fallback or live production URL is available to probe.');

  return {
    checked_at: (opts.now?.() ?? new Date()).toISOString(),
    sitewide_noindex: settings.sitewide_noindex === true,
    ready: targets.length > 0 && issues.length === 0,
    targets,
    issues,
  };
}

async function probeTarget(
  target: { kind: IndexingTargetKind; origin: string; expected: 'noindex' | 'indexable' },
  opts: SiteIndexingDiagnosticOptions,
): Promise<IndexingTargetDiagnostic> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const validate = opts.validateDestination ?? assertPublicDestination;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const root = new URL('/', ensureTrailingSlash(target.origin));
  const robotsUrl = new URL('/robots.txt', root);
  const issues: string[] = [];

  try {
    await validate(root);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : 'The target is not a public destination.');
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

  return {
    kind: target.kind,
    origin: target.origin,
    expected: target.expected,
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
    matches_expected: target.expected === 'noindex' ? effectiveNoindex : !effectiveNoindex,
    issues,
  };
}

function emptyDiagnostic(
  target: { kind: IndexingTargetKind; origin: string; expected: 'noindex' | 'indexable' },
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
    return { error: error instanceof Error ? error.message : String(error) };
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
