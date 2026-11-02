import { Resolver } from 'node:dns/promises';
import { ProviderError, ProviderTransportError } from './providers.mjs';
import { ConnectionError } from './connections';

/**
 * The Cloudflare Pages custom domain behind a website host. A proxied CNAME to
 * the project is not enough: Pages serves the host only while its custom
 * domain is `active`. Pages validates over HTTP after the record points at the
 * project, and gives up ("deactivated") when another Cloudflare for SaaS
 * hostname (for example a previous host such as Kinsta) answers the name
 * instead. Cloudflare then never validates again on its own; a PATCH of the
 * domain retries validation. That PATCH is the only write here: it never
 * changes DNS.
 */

type Provider = (route: string, options?: { method?: string; body?: unknown; missing?: boolean }) => Promise<any>;

/** Statuses for which a validation retry can help once the host points at the project. */
export const PAGES_RETRYABLE_STATUSES = ['pending', 'initializing', 'deactivated', 'error'] as const;
/** At most one automatic retry per host in this interval, whatever triggers the check. */
export const PAGES_RETRY_INTERVAL_MS = 5 * 60_000;

export interface PagesDomainObservation {
  host: string;
  /** Cloudflare's custom domain status, `missing` when the project has no such domain, or null when the read was inconclusive. */
  status: string | null;
  validation_method: string | null;
  validation_status: string | null;
  /** Cloudflare's verification/validation error text, when it reports one. */
  error_message: string | null;
  checked_at: string;
  /** The last validation retry Typeroll requested for this host. */
  retried_at: string | null;
  /** What this check did about validation. */
  retry: 'requested' | 'rate_limited' | 'dns_not_pointing' | 'failed' | null;
  /** Whether the host's DNS points at the Pages project: null when Typeroll cannot tell. */
  dns_points_at_project?: boolean | null;
  /** Why the read was inconclusive. */
  error?: string;
}

export interface PagesDomainIssue {
  code: 'pages_domain_not_active';
  host: string;
  status: string;
  message: string;
  remedy: string;
  /** Whether `retry_validation` can help now. */
  retryable: boolean;
}

export const pagesDomainRoute = (accountId: string, project: string, host?: string) =>
  `/accounts/${accountId}/pages/projects/${project}/domains${host ? `/${encodeURIComponent(host)}` : ''}`;

/** Inconclusive: transport errors, rate limits, provider outages and missing read permission. */
function inconclusiveError(error: unknown): string | null {
  if (error instanceof ProviderError) return `Cloudflare returned HTTP ${error.status} for the Pages custom domain.`;
  if (error instanceof ProviderTransportError) return 'Cloudflare could not be reached.';
  if (error instanceof ConnectionError) return error.message;
  return null;
}

function describe(host: string, domain: any, now: number): Omit<PagesDomainObservation, 'retried_at' | 'retry'> {
  if (!domain) return { host, status: 'missing', validation_method: null, validation_status: null, error_message: null, checked_at: new Date(now).toISOString() };
  const text = (value: unknown) => typeof value === 'string' && value ? value.slice(0, 300) : null;
  return { host, status: text(domain.status) ?? 'pending', validation_method: text(domain.validation_data?.method), validation_status: text(domain.validation_data?.status),
    error_message: text(domain.verification_data?.error_message) ?? text(domain.validation_data?.error_message), checked_at: new Date(now).toISOString() };
}

/**
 * Read the custom domain and, when allowed, retry its validation once.
 * `retry` decides per observation (status, DNS) whether a PATCH is wanted.
 * A provider error on the read returns an inconclusive observation; a failed
 * retry keeps the observed status.
 */
export async function observePagesDomain(provider: Provider, input: {
  accountId: string; project: string; host: string; now?: number;
  /** The previous retry for this host, for rate limiting. */
  lastRetryAt?: string | null;
  /** Skip the interval (an explicit retry request); callers rate-limit it themselves. */
  force?: boolean;
  /** Whether the host points at the project. Only consulted when a retry is otherwise due. */
  dnsPointsAtProject?: () => Promise<boolean | null>;
}): Promise<PagesDomainObservation> {
  const now = input.now ?? Date.now();
  const previousRetry = input.lastRetryAt ?? null;
  const route = pagesDomainRoute(input.accountId, input.project, input.host);
  let domain: any;
  try { domain = await provider(route, { missing: true }); }
  catch (error) {
    const reason = inconclusiveError(error);
    if (!reason) throw error;
    return { host: input.host, status: null, validation_method: null, validation_status: null, error_message: null, checked_at: new Date(now).toISOString(), retried_at: previousRetry, retry: null, error: reason };
  }
  const observed = describe(input.host, domain, now);
  const result: PagesDomainObservation = { ...observed, retried_at: previousRetry, retry: null };
  if (!(PAGES_RETRYABLE_STATUSES as readonly string[]).includes(observed.status!)) return result;
  const last = previousRetry ? Date.parse(previousRetry) : NaN;
  if (!input.force && Number.isFinite(last) && now - last < PAGES_RETRY_INTERVAL_MS) return { ...result, retry: 'rate_limited' };
  const points = input.dnsPointsAtProject ? await input.dnsPointsAtProject().catch(() => null) : true;
  result.dns_points_at_project = points;
  if (points !== true) return { ...result, retry: 'dns_not_pointing' };
  try {
    // Cloudflare: PATCH /accounts/{account}/pages/projects/{project}/domains/{domain} retries validation.
    const retried = await provider(route, { method: 'PATCH', body: {} });
    const after = retried && typeof retried === 'object' ? describe(input.host, retried, now) : observed;
    return { ...after, retried_at: new Date(now).toISOString(), retry: 'requested', dns_points_at_project: points };
  } catch (error) {
    if (!inconclusiveError(error)) throw error;
    return { ...result, retry: 'failed', error: inconclusiveError(error)! };
  }
}

/** Whether the host's record points at `project.pages.dev`, from the zone (automatic DNS) or public DNS (external). */
export async function hostPointsAtProject(input: { host: string; project: string; branch?: string;
  zone?: { provider: Provider; zoneId: string } | null; resolveCname?: (host: string) => Promise<string[]> }): Promise<boolean | null> {
  const target = `${input.branch && input.branch !== 'main' ? `${input.branch}.` : ''}${input.project}.pages.dev`;
  const normal = (value: unknown) => String(value ?? '').toLowerCase().replace(/\.$/, '');
  if (input.zone) {
    const records = (await input.zone.provider(`/zones/${input.zone.zoneId}/dns_records?name=${encodeURIComponent(input.host)}&per_page=100`))
      .filter((record: any) => ['A', 'AAAA', 'CNAME'].includes(record.type));
    return records.length === 1 && records[0].type === 'CNAME' && normal(records[0].content) === target;
  }
  const resolve = input.resolveCname ?? (async (host: string) => new Resolver({ timeout: 3000, tries: 1 }).resolveCname(host));
  try { return (await resolve(input.host)).some(value => normal(value) === target) ? true : null; }
  // External DNS may flatten or proxy the record; not seeing the CNAME is no evidence either way.
  catch { return null; }
}

/** Plain issue text for a website host whose Pages custom domain is not active. Null when active or unknown. */
export function pagesDomainIssue(observation: PagesDomainObservation | null | undefined, project?: string): PagesDomainIssue | null {
  if (!observation?.status || observation.status === 'active') return null;
  const { host, status } = observation;
  const target = project ? `${project}.pages.dev` : 'the Pages project';
  const reported = observation.error_message ? ` Cloudflare reports: "${observation.error_message}".` : '';
  const retryable = (PAGES_RETRYABLE_STATUSES as readonly string[]).includes(status);
  const remedy = status === 'missing'
    ? `Prepare the domain change again so Typeroll attaches ${host} to the Pages project.`
    : status === 'blocked'
      ? `Cloudflare blocked ${host} for this Pages project. Check the hostname in Cloudflare → Workers & Pages → the project → Custom domains (and any CAA records), then prepare the domain change again.`
      : `Make sure no other provider still claims ${host}: remove it from the previous host's dashboard (for example MyKinsta → Domains), because its Cloudflare for SaaS hostname outranks your own DNS and blocks validation. Keep the proxied CNAME ${host} → ${target}. Then retry validation (guide_publishing_domain_change with action retry_validation, or Retry validation in Publishing); Typeroll also retries automatically on its follow-up checks.`;
  const meaning = status === 'deactivated'
    ? 'Cloudflare stopped validating it, so Pages does not serve the host (visitors typically get HTTP 522) and does not try again on its own.'
    : status === 'missing'
      ? 'The Pages project has no custom domain for it, so Pages does not serve the host.'
      : `Pages does not serve the host until the domain is active.`;
  return { code: 'pages_domain_not_active', host, status, retryable, remedy,
    message: `The Cloudflare Pages custom domain ${host} is ${status}, not active. ${meaning}${reported} ${remedy}` };
}
