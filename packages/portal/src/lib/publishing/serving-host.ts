import { createSafeFetch } from '../net/safe-fetch';

/**
 * Who answers a public host. Every Typeroll publication sends
 * X-Typeroll-Publication and serves /.well-known/typeroll/publication.json;
 * anything else is another host, whatever DNS says. A Cloudflare for SaaS
 * custom hostname registered by a previous host outranks the customer's own
 * zone record, so a correct CNAME does not prove who serves the domain.
 */

export const PUBLICATION_MARKER = '/.well-known/typeroll/publication.json';
const PUBLICATION_HEADER = 'x-typeroll-publication';
const PUBLICATION_ID = /^[A-Za-z0-9-]{1,128}$/;

export interface ProviderHint {
  provider: string;
  name: string;
  /** The header that identified the provider, for example "x-kinsta-cache: HIT". */
  evidence: string;
  /** The provider fronts customer domains with Cloudflare for SaaS custom hostnames. */
  cloudflare_for_saas: boolean;
}

type ProviderRule = { provider: string; name: string; header: string; pattern?: RegExp; cloudflare_for_saas: boolean; dashboard?: string };

/** A deliberately small, explicit table. Specific hosts come before the generic WordPress signal. */
const PROVIDER_RULES: ProviderRule[] = [
  { provider: 'kinsta', name: 'Kinsta', header: 'x-kinsta-cache', cloudflare_for_saas: true, dashboard: 'MyKinsta → Domains' },
  { provider: 'wp_engine', name: 'WP Engine', header: 'x-powered-by', pattern: /wp engine/i, cloudflare_for_saas: true, dashboard: 'WP Engine User Portal → Domains' },
  { provider: 'wix', name: 'Wix', header: 'x-wix-request-id', cloudflare_for_saas: false },
  { provider: 'squarespace', name: 'Squarespace', header: 'x-served-by', pattern: /squarespace/i, cloudflare_for_saas: false },
  { provider: 'squarespace', name: 'Squarespace', header: 'server', pattern: /squarespace/i, cloudflare_for_saas: false },
  { provider: 'shopify', name: 'Shopify', header: 'x-shopid', cloudflare_for_saas: false },
  { provider: 'netlify', name: 'Netlify', header: 'x-nf-request-id', cloudflare_for_saas: false },
  { provider: 'vercel', name: 'Vercel', header: 'x-vercel-id', cloudflare_for_saas: false },
  { provider: 'wordpress', name: 'WordPress', header: 'link', pattern: /\/wp-json\/?>/i, cloudflare_for_saas: false },
];

/** Name a likely previous host from well-known response headers. Never a guess from the body. */
export function providerHint(...sources: Array<Headers | null | undefined>): ProviderHint | null {
  for (const rule of PROVIDER_RULES) {
    for (const headers of sources) {
      const value = headers?.get(rule.header);
      if (value == null || (rule.pattern && !rule.pattern.test(value))) continue;
      return { provider: rule.provider, name: rule.name, evidence: `${rule.header}: ${value}`.slice(0, 160), cloudflare_for_saas: rule.cloudflare_for_saas };
    }
  }
  return null;
}

/** Plain remedy text for a host answered by someone other than Typeroll. */
export function otherHostRemedy(hint: ProviderHint | null): string {
  if (hint && !hint.cloudflare_for_saas) {
    return `Remove the domain from ${hint.name} and check that its DNS records point to Typeroll.`;
  }
  const dashboard = PROVIDER_RULES.find(rule => rule.provider === hint?.provider)?.dashboard ?? 'MyKinsta → Domains';
  return `Remove the domain from the previous host's dashboard (for example ${dashboard}); its Cloudflare for SaaS hostname outranks your own DNS.`;
}

export function publicationHeader(response: Response | null | undefined): string | null {
  const value = response?.headers.get(PUBLICATION_HEADER)?.trim();
  return value && PUBLICATION_ID.test(value) ? value : null;
}

/** The publication marker body, `{ id, paths }`. Any other body is not a Typeroll marker. */
export async function markerPublication(response: Response | null | undefined): Promise<string | null> {
  const header = publicationHeader(response);
  if (header || !response?.ok) return header;
  try {
    const body = JSON.parse(await response.text()) as { id?: unknown };
    return typeof body?.id === 'string' && PUBLICATION_ID.test(body.id) ? body.id : null;
  } catch { return null; }
}

export type ServingStatus = 'serving' | 'other_host' | 'other_publication' | 'inconclusive';

export interface ServingObservation {
  host: string;
  role: 'website' | 'redirect';
  status: ServingStatus;
  http_status: number | null;
  /** The Typeroll publication that answered, or null when none did. */
  publication: string | null;
  provider_hint: ProviderHint | null;
  location?: string | null;
  error?: string;
}

export interface ServingIssue { code: 'domain_served_by_other_host' | 'domain_serving_other_publication'; host: string; message: string; remedy: string }

const servingFetch = createSafeFetch({ label: 'Serving check', maxRedirects: 0, timeoutMs: 10_000, maxBytes: 64 * 1024 });

type Attempt = { response: Response | null; error?: string };

async function attempt(fetchImpl: typeof fetch, url: string, method: 'GET' | 'HEAD'): Promise<Attempt> {
  try {
    return { response: await fetchImpl(url, { method, redirect: 'manual', signal: AbortSignal.timeout(10_000),
      headers: { 'Cache-Control': 'no-cache', 'User-Agent': 'Typeroll-Serving-Check/1.0' } }) };
  } catch (error) {
    return { response: null, error: error instanceof Error ? error.message : 'The request failed.' };
  }
}

/** A Cloudflare challenge or an origin/edge error is not evidence of another host. */
function unproven(responses: Array<Response | null>, hint: ProviderHint | null): boolean {
  if (hint) return false;
  const received = responses.filter((response): response is Response => !!response);
  return !received.length || received.every(response => response.status >= 500 || response.headers.has('cf-mitigated'));
}

function cancel(response: Response | null) { void response?.body?.cancel().catch(() => {}); }

/** Read-only: one HEAD of the home page and one GET of the publication marker. */
export async function observeWebsiteHost(host: string, expected: string, fetchImpl: typeof fetch = servingFetch): Promise<ServingObservation> {
  const [root, marker] = await Promise.all([attempt(fetchImpl, `https://${host}/`, 'HEAD'), attempt(fetchImpl, `https://${host}${PUBLICATION_MARKER}`, 'GET')]);
  cancel(root.response);
  const publication = publicationHeader(root.response) ?? await markerPublication(marker.response);
  cancel(marker.response);
  const hint = providerHint(root.response?.headers, marker.response?.headers);
  const base = { host, role: 'website' as const, http_status: root.response?.status ?? marker.response?.status ?? null, publication, provider_hint: hint };
  if (publication) return { ...base, status: publication === expected ? 'serving' : 'other_publication' };
  if (unproven([root.response, marker.response], hint)) {
    return { ...base, status: 'inconclusive', error: root.error ?? marker.error ?? `The host answered HTTP ${base.http_status} without a Typeroll publication.` };
  }
  return { ...base, status: 'other_host' };
}

/** A redirect host must answer the approved 301 to the website host (or still serve the current publication). */
export async function observeRedirectHost(host: string, target: string, expected: string, fetchImpl: typeof fetch = servingFetch): Promise<ServingObservation> {
  const path = `${PUBLICATION_MARKER}?typeroll_serving_check=${encodeURIComponent(expected)}`;
  const result = await attempt(fetchImpl, `https://${host}${path}`, 'GET');
  const response = result.response;
  const location = response?.headers.get('location') ?? null;
  const publication = await markerPublication(response);
  cancel(response);
  const hint = providerHint(response?.headers);
  const base = { host, role: 'redirect' as const, http_status: response?.status ?? null, publication, provider_hint: hint, location };
  if (response?.status === 301 && location === `https://${target}${path}`) return { ...base, status: 'serving' };
  if (publication) return { ...base, status: publication === expected ? 'serving' : 'other_publication' };
  if (unproven([response], hint)) return { ...base, status: 'inconclusive', error: result.error ?? `The host answered HTTP ${base.http_status} without the expected redirect.` };
  return { ...base, status: 'other_host' };
}

export function servingIssue(observation: ServingObservation, expected: string): ServingIssue | null {
  if (observation.status === 'other_host') {
    const source = observation.provider_hint ? ` It looks like ${observation.provider_hint.name} (${observation.provider_hint.evidence}).` : '';
    const what = observation.role === 'redirect' ? 'neither redirects to the website nor serves this site\'s Typeroll publication' : 'is not served by Typeroll: the response carries no Typeroll publication';
    const remedy = otherHostRemedy(observation.provider_hint);
    return { code: 'domain_served_by_other_host', host: observation.host, remedy,
      message: `${observation.host} ${what}.${source} Visitors and search engines see the other host, not this site. ${remedy}` };
  }
  if (observation.status === 'other_publication') {
    const remedy = 'Check that the domain is not attached to another Typeroll site or project, purge stale cache if needed, then run the check again.';
    return { code: 'domain_serving_other_publication', host: observation.host, remedy,
      message: `${observation.host} serves Typeroll publication ${observation.publication}, not the current publication ${expected}. ${remedy}` };
  }
  return null;
}
