/**
 * Thin Cloudflare API client for the bits the portal needs at site-
 * creation, custom-domain, and site-deletion time. Separate from
 * `cloudflare-pages.ts` (the deploy adapter, which handles the upload
 * pipeline) so the two can be tested + reasoned about independently.
 *
 * Token scopes required:
 *   - Account / Cloudflare Pages / Edit   (create projects, attach domains)
 *   - Zone    / DNS                / Edit (write fallback subdomain CNAMEs)
 *
 * All methods throw on non-2xx with a message that includes CF's error
 * payload so callers can surface something meaningful.
 */

const API_BASE = 'https://api.cloudflare.com/client/v4';

export interface CloudflareApiConfig {
  accountId: string;
  apiToken: string;
}

export interface CustomDomainStatus {
  name: string;
  /** Cloudflare's reported state. `active` is the green-light signal —
   *  the domain serves traffic, the cert is issued. Everything else is
   *  either provisioning or stuck. */
  status: 'pending' | 'active' | 'deactivated' | 'blocked' | 'error';
  /** SSL/cert provisioning sub-state, when CF surfaces it. */
  verification_status: string | null;
  /** DNS-validation sub-state, when CF surfaces it. */
  validation_status: string | null;
  certificate_authority: string | null;
}

export class CloudflareApi {
  constructor(private cfg: CloudflareApiConfig) {}

  // ─── Pages projects ───────────────────────────────────────────────────

  /** Create a new Cloudflare Pages project. Idempotent: returns the
   *  existing project's info on conflict. */
  async createPagesProject(name: string, productionBranch = 'main'): Promise<{ name: string; subdomain: string }> {
    const res = await this.fetch(`/accounts/${this.cfg.accountId}/pages/projects`, {
      method: 'POST',
      body: JSON.stringify({
        name,
        production_branch: productionBranch,
      }),
    });
    if (res.ok) {
      const data = await res.json() as { result: { name: string; subdomain: string } };
      return { name: data.result.name, subdomain: data.result.subdomain };
    }
    if (res.status === 409 || res.status === 400) {
      // Already exists. Look it up and return.
      const existing = await this.getPagesProject(name);
      if (existing) return existing;
    }
    throw await error('createPagesProject', res);
  }

  async getPagesProject(name: string): Promise<{ name: string; subdomain: string } | null> {
    const res = await this.fetch(`/accounts/${this.cfg.accountId}/pages/projects/${name}`);
    if (res.status === 404) return null;
    if (!res.ok) throw await error('getPagesProject', res);
    const data = await res.json() as { result: { name: string; subdomain: string } };
    return { name: data.result.name, subdomain: data.result.subdomain };
  }

  async deletePagesProject(name: string): Promise<void> {
    const res = await this.fetch(`/accounts/${this.cfg.accountId}/pages/projects/${name}`, {
      method: 'DELETE',
    });
    if (res.status === 404) return; // already gone
    if (!res.ok) throw await error('deletePagesProject', res);
  }

  /** Attach a custom domain (e.g. customer's apex domain) to a project.
   *  After this call, the customer still has to make their DNS resolve
   *  to <project>.pages.dev for the domain to actually serve. */
  async attachCustomDomain(project: string, domain: string): Promise<void> {
    const res = await this.fetch(`/accounts/${this.cfg.accountId}/pages/projects/${project}/domains`, {
      method: 'POST',
      body: JSON.stringify({ name: domain }),
    });
    if (res.ok || res.status === 409) return; // 409 = already attached
    throw await error('attachCustomDomain', res);
  }

  async removeCustomDomain(project: string, domain: string): Promise<void> {
    const res = await this.fetch(`/accounts/${this.cfg.accountId}/pages/projects/${project}/domains/${domain}`, {
      method: 'DELETE',
    });
    if (res.status === 404) return;
    if (!res.ok) throw await error('removeCustomDomain', res);
  }

  /**
   * Read the current status of a custom domain attached to a Pages
   * project. Returns null when the domain isn't attached. Used by the
   * domain-lifecycle service to poll for DNS + cert verification.
   *
   * CF's top-level `status` is one of:
   *   - `pending`     — DNS or cert not yet verified
   *   - `active`      — fully working (our `verified` state — customer
   *                     still has to click "activate" to flip live URL)
   *   - `deactivated` — manually disabled
   *   - `blocked`     — blocked by CF (rare)
   *   - `error`       — unrecoverable error
   *
   * `verification_data.status` is the SSL provisioning state and can be
   * lagging behind `status`. We surface both so the service can decide
   * whether to leave the domain in `pending` until the cert lands.
   */
  async getCustomDomainStatus(project: string, domain: string): Promise<CustomDomainStatus | null> {
    const res = await this.fetch(`/accounts/${this.cfg.accountId}/pages/projects/${project}/domains/${domain}`);
    if (res.status === 404) return null;
    if (!res.ok) throw await error('getCustomDomainStatus', res);
    const data = await res.json() as {
      result: {
        name: string;
        status?: string;
        verification_data?: { status?: string; method?: string };
        validation_data?: { status?: string; method?: string; txt_name?: string; txt_value?: string };
        certificate_authority?: string;
      };
    };
    const r = data.result;
    return {
      name: r.name,
      status: (r.status ?? 'pending') as CustomDomainStatus['status'],
      verification_status: r.verification_data?.status ?? null,
      validation_status: r.validation_data?.status ?? null,
      certificate_authority: r.certificate_authority ?? null,
    };
  }

  // ─── DNS ─────────────────────────────────────────────────────────────

  /** Resolve a zone id from its domain name. Cached per-instance because
   *  zone ids never change but lookups are slow. */
  private zoneIdCache = new Map<string, string>();
  async getZoneId(zoneName: string): Promise<string> {
    const cached = this.zoneIdCache.get(zoneName);
    if (cached) return cached;
    const res = await this.fetch(`/zones?name=${encodeURIComponent(zoneName)}`);
    if (!res.ok) throw await error('getZoneId', res);
    const data = await res.json() as { result: Array<{ id: string; name: string }> };
    const zone = data.result.find((z) => z.name === zoneName);
    if (!zone) throw new Error(`No Cloudflare zone found for "${zoneName}"`);
    this.zoneIdCache.set(zoneName, zone.id);
    return zone.id;
  }

  /** Create or update a DNS record. Idempotent — if a record with the
   *  same name+type exists, it's updated. */
  async upsertDnsRecord(args: {
    zoneId: string;
    type: 'CNAME' | 'A' | 'TXT';
    name: string;
    content: string;
    proxied?: boolean;
    ttl?: number;
  }): Promise<void> {
    // Find an existing record.
    const list = await this.fetch(
      `/zones/${args.zoneId}/dns_records?type=${args.type}&name=${encodeURIComponent(args.name)}`,
    );
    if (!list.ok) throw await error('upsertDnsRecord:list', list);
    const found = ((await list.json()) as { result: Array<{ id: string }> }).result[0];

    const body = JSON.stringify({
      type: args.type,
      name: args.name,
      content: args.content,
      proxied: args.proxied ?? false,
      ttl: args.ttl ?? 1, // 1 = automatic
    });

    if (found) {
      const res = await this.fetch(`/zones/${args.zoneId}/dns_records/${found.id}`, {
        method: 'PUT',
        body,
      });
      if (!res.ok) throw await error('upsertDnsRecord:update', res);
    } else {
      const res = await this.fetch(`/zones/${args.zoneId}/dns_records`, {
        method: 'POST',
        body,
      });
      if (!res.ok) throw await error('upsertDnsRecord:create', res);
    }
  }

  async deleteDnsRecord(zoneId: string, name: string, type: string): Promise<void> {
    const list = await this.fetch(
      `/zones/${zoneId}/dns_records?type=${type}&name=${encodeURIComponent(name)}`,
    );
    if (!list.ok) throw await error('deleteDnsRecord:list', list);
    const records = ((await list.json()) as { result: Array<{ id: string }> }).result;
    for (const r of records) {
      const res = await this.fetch(`/zones/${zoneId}/dns_records/${r.id}`, { method: 'DELETE' });
      if (!res.ok) throw await error('deleteDnsRecord:delete', res);
    }
  }

  // ─── Web Analytics (RUM) ──────────────────────────────────────────────

  /**
   * Create a Cloudflare Web Analytics site for `host` and return its beacon
   * token (embedded in the page) + site tag (used to read stats via the
   * GraphQL API). Idempotent-ish: if a site for the host already exists CF
   * 409s and we look it up. Requires the token to carry the Account
   * Analytics scope.
   */
  async createWebAnalyticsSite(host: string): Promise<{ site_tag: string; beacon_token: string } | null> {
    const res = await this.fetch(`/accounts/${this.cfg.accountId}/rum/site_info`, {
      method: 'POST',
      body: JSON.stringify({ host, auto_install: false }),
    });
    if (res.ok) {
      const data = await res.json() as { result: { site_tag: string; site_token: string } };
      return { site_tag: data.result.site_tag, beacon_token: data.result.site_token };
    }
    if (res.status === 409) {
      const existing = await this.findWebAnalyticsSiteByHost(host);
      if (existing) return existing;
    }
    throw await error('createWebAnalyticsSite', res);
  }

  async findWebAnalyticsSiteByHost(host: string): Promise<{ site_tag: string; beacon_token: string } | null> {
    const res = await this.fetch(`/accounts/${this.cfg.accountId}/rum/site_info/list?per_page=100`);
    if (!res.ok) return null;
    const data = await res.json() as { result: Array<{ site_tag: string; site_token: string; rules?: Array<{ host?: string }>; snippet?: string; ruleset?: { rules?: Array<{ host?: string }> } }> };
    const match = data.result.find((s) =>
      s.ruleset?.rules?.some((r) => r.host === host) || s.rules?.some((r) => r.host === host),
    );
    return match ? { site_tag: match.site_tag, beacon_token: match.site_token } : null;
  }

  /**
   * Query Web Analytics via the GraphQL Analytics API. Returns pageview and
   * visit totals grouped by referer host over the last `days` days, for the
   * insights dashboard. Returns null on any failure (dashboard degrades).
   */
  async webAnalyticsByReferer(siteTag: string, days: number): Promise<{
    total_visits: number;
    total_pageviews: number;
    by_referer: Array<{ referer: string; visits: number; pageviews: number }>;
  } | null> {
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
    try {
      const res = await this.fetch('/graphql', {
        method: 'POST',
        body: JSON.stringify({ query, variables: { accountTag: this.cfg.accountId, siteTag, since, until } }),
      });
      if (!res.ok) return null;
      const data = await res.json() as {
        data?: { viewer?: { accounts?: Array<{
          total?: Array<{ count: number; sum?: { visits: number } }>;
          byReferer?: Array<{ count: number; sum?: { visits: number }; dimensions?: { refererHost?: string } }>;
        }> } };
        errors?: unknown;
      };
      const acct = data.data?.viewer?.accounts?.[0];
      if (!acct) return null;
      return {
        total_pageviews: acct.total?.[0]?.count ?? 0,
        total_visits: acct.total?.[0]?.sum?.visits ?? 0,
        by_referer: (acct.byReferer ?? []).map((r) => ({
          referer: r.dimensions?.refererHost || '(direct)',
          pageviews: r.count,
          visits: r.sum?.visits ?? 0,
        })),
      };
    } catch {
      return null;
    }
  }

  // ─── Internals ────────────────────────────────────────────────────────

  private fetch(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.cfg.apiToken}`,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
  }
}

async function error(op: string, res: Response): Promise<Error> {
  let body = '';
  try {
    body = await res.text();
  } catch { /* ignore */ }
  return new Error(`Cloudflare API ${op} failed (${res.status}): ${body.slice(0, 500)}`);
}

/** Build the canonical Pages project name for a Typeroll site.
 *  Keeps to CF's <58 char + lowercase + hyphen rules. */
export function pagesProjectNameForSite(orgId: string, siteId: string): string {
  const raw = `tr-${orgId}-${siteId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  // CF caps project names at 58 chars; truncate from the end (orgId+siteId is
  // typically short, but be defensive).
  return raw.slice(0, 58).replace(/-+$/, '');
}
