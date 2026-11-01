// Cloudflare Web Analytics (RUM) calls for the Analytics app, made with the
// credential of the account that owns the site's analytics (see
// analytics-account.ts). Every failure is a typed error carrying only the
// HTTP status and Cloudflare's numeric error codes: provider bodies are never
// copied into messages or logs.

const API_BASE = 'https://api.cloudflare.com/client/v4';
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

export type WebAnalyticsFailure = 'access' | 'rate_limited' | 'unavailable' | 'site_limit';

/** Cloudflare allows this many Web Analytics sites added by hostname (not proxied) per account; it is a soft limit. */
export const UNPROXIED_SITE_LIMIT = 10;

export class WebAnalyticsProviderError extends Error {
  constructor(readonly kind: WebAnalyticsFailure, readonly status: number, readonly codes: number[] = []) {
    super(`Cloudflare Web Analytics request failed (HTTP ${status}${codes.length ? `, codes ${codes.join(', ')}` : ''})`);
    this.name = 'WebAnalyticsProviderError';
  }
}

export interface WebAnalyticsSite {
  site_tag: string;
  /** The public beacon token embedded in published pages. */
  site_token: string;
  hosts: string[];
}

export interface TrafficByReferer {
  total_visits: number;
  total_pageviews: number;
  by_referer: Array<{ referer: string; visits: number; pageviews: number }>;
}

interface Envelope<T> { success?: boolean; result?: T; errors?: Array<{ code?: unknown }>; result_info?: { total_pages?: number } }
interface RawSite { site_tag?: unknown; site_token?: unknown; rules?: Array<{ host?: unknown }>; ruleset?: { rules?: Array<{ host?: unknown }> } }

function failureKind(status: number): WebAnalyticsFailure {
  if (status === 401 || status === 403) return 'access';
  if (status === 429) return 'rate_limited';
  return 'unavailable';
}

function toSite(raw: RawSite | undefined): WebAnalyticsSite | null {
  if (!raw || typeof raw.site_tag !== 'string' || typeof raw.site_token !== 'string' || !raw.site_tag || !raw.site_token) return null;
  const hosts = [...(raw.rules ?? []), ...(raw.ruleset?.rules ?? [])]
    .map((rule) => rule?.host).filter((host): host is string => typeof host === 'string' && host.length > 0);
  return { site_tag: raw.site_tag, site_token: raw.site_token, hosts: [...new Set(hosts)] };
}

export function webAnalyticsApi(token: string, accountId: string, fetchImpl: typeof fetch = fetch) {
  if (!/^[a-f0-9]{32}$/.test(accountId)) throw new Error('Invalid Cloudflare account ID');

  async function send(path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
    try {
      return await fetchImpl(`${API_BASE}${path}`, {
        method: init.method ?? 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch {
      throw new WebAnalyticsProviderError('unavailable', 0);
    }
  }

  async function rest<T>(path: string, init: { method?: string; body?: unknown; missing?: boolean } = {}): Promise<Envelope<T> | null> {
    const response = await send(path, init);
    if (init.missing && response.status === 404) return null;
    let data: Envelope<T> | null = null;
    try { data = await response.json() as Envelope<T>; } catch { /* handled below */ }
    const codes = Array.isArray(data?.errors) ? data!.errors.map((item) => Number(item?.code)).filter(Number.isSafeInteger) : [];
    if (!response.ok) throw new WebAnalyticsProviderError(failureKind(response.status), response.status, codes);
    if (!data || data.success !== true) throw new WebAnalyticsProviderError('unavailable', response.status, codes);
    return data;
  }

  const root = `/accounts/${accountId}/rum/site_info`;

  async function listSites(): Promise<WebAnalyticsSite[]> {
    const sites: WebAnalyticsSite[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const data = await rest<RawSite[]>(`${root}/list?per_page=${PAGE_SIZE}&page=${page}`);
      const batch = Array.isArray(data?.result) ? data!.result : [];
      for (const raw of batch) {
        const site = toSite(raw);
        if (site) sites.push(site);
      }
      const totalPages = Number(data?.result_info?.total_pages);
      if (batch.length < PAGE_SIZE || (Number.isFinite(totalPages) && page >= totalPages)) break;
    }
    return sites;
  }

  return {
    listSites,

    async getSite(siteTag: string): Promise<WebAnalyticsSite | null> {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(siteTag)) return null;
      const data = await rest<RawSite>(`${root}/${siteTag}`, { missing: true });
      return data ? toSite(data.result) : null;
    },

    async findByToken(siteToken: string): Promise<WebAnalyticsSite | null> {
      return (await listSites()).find((site) => site.site_token === siteToken) ?? null;
    },

    /** Create a site for a host that is not proxied through this account (no automatic snippet injection). */
    async createSite(host: string): Promise<WebAnalyticsSite> {
      try {
        const data = await rest<RawSite>(root, { method: 'POST', body: { host, auto_install: false } });
        const site = toSite(data?.result);
        if (!site) throw new WebAnalyticsProviderError('unavailable', 200);
        return site;
      } catch (error) {
        // A site for this host may already exist in the account: reuse it rather than fail.
        if (error instanceof WebAnalyticsProviderError && (error.status === 409 || error.status === 400)) {
          const sites = await listSites();
          const existing = sites.find((site) => site.hosts.includes(host));
          if (existing) return existing;
          // Cloudflare's refusal (e.g. code 10014) names no reason. A full account is the usual one.
          if (sites.length >= UNPROXIED_SITE_LIMIT) throw new WebAnalyticsProviderError('site_limit', error.status, error.codes);
        }
        throw error;
      }
    },

    /** Visits and page views over `days`, grouped by referring host, from the GraphQL Analytics API. */
    async trafficByReferer(siteTag: string, days: number): Promise<TrafficByReferer> {
      const since = new Date(Date.now() - days * 86_400_000).toISOString();
      const until = new Date().toISOString();
      const query = `query($accountTag:string!,$siteTag:string!,$since:Time!,$until:Time!){
        viewer { accounts(filter:{accountTag:$accountTag}) {
          total: rumPageloadEventsAdaptiveGroups(limit:1, filter:{siteTag:$siteTag, datetime_geq:$since, datetime_leq:$until}) { count sum { visits } }
          byReferer: rumPageloadEventsAdaptiveGroups(limit:100, filter:{siteTag:$siteTag, datetime_geq:$since, datetime_leq:$until}, orderBy:[count_DESC]) {
            count sum { visits } dimensions { refererHost }
          }
        } }
      }`;
      const response = await send('/graphql', { method: 'POST', body: { query, variables: { accountTag: accountId, siteTag, since, until } } });
      if (!response.ok) throw new WebAnalyticsProviderError(failureKind(response.status), response.status);
      let data: {
        data?: { viewer?: { accounts?: Array<{
          total?: Array<{ count: number; sum?: { visits: number } }>;
          byReferer?: Array<{ count: number; sum?: { visits: number }; dimensions?: { refererHost?: string } }>;
        }> } } | null;
        errors?: Array<{ message?: unknown; extensions?: { code?: unknown } }> | null;
      };
      try { data = await response.json(); } catch { throw new WebAnalyticsProviderError('unavailable', response.status); }
      if (Array.isArray(data.errors) && data.errors.length) {
        // GraphQL reports authorization failures with HTTP 200 and an error entry.
        const denied = data.errors.some((item) => item?.extensions?.code === 'authz' ||
          (typeof item?.message === 'string' && /not authori[sz]ed|authz|permission/i.test(item.message)));
        throw new WebAnalyticsProviderError(denied ? 'access' : 'unavailable', response.status);
      }
      const accounts = data.data?.viewer?.accounts;
      // A token without access to the account sees no account at all.
      if (!Array.isArray(accounts) || !accounts.length) throw new WebAnalyticsProviderError('access', response.status);
      const account = accounts[0];
      return {
        total_pageviews: account.total?.[0]?.count ?? 0,
        total_visits: account.total?.[0]?.sum?.visits ?? 0,
        by_referer: (account.byReferer ?? []).map((row) => ({
          referer: row.dimensions?.refererHost || '(direct)',
          pageviews: row.count,
          visits: row.sum?.visits ?? 0,
        })),
      };
    },
  };
}

export type WebAnalyticsApi = ReturnType<typeof webAnalyticsApi>;
