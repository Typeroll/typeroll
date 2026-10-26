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
   *  to <project>.pages.dev for the domain to actually serve.
   *
   *  Idempotent for the same project only: a 409 counts as success when
   *  the domain is already attached to `project`. A 409 for a domain that
   *  another Pages project holds throws CloudflareConflictError — treating
   *  it as success would report a hostname as ours while it serves someone
   *  else's site. */
  async attachCustomDomain(project: string, domain: string): Promise<void> {
    const res = await this.fetch(`/accounts/${this.cfg.accountId}/pages/projects/${project}/domains`, {
      method: 'POST',
      body: JSON.stringify({ name: domain }),
    });
    if (res.ok) return;
    if (res.status === 409) {
      if (await this.getCustomDomainStatus(project, domain)) return; // already attached here
      throw new CloudflareConflictError(
        'domain_in_use',
        `${domain} is already attached to another Cloudflare Pages project.`,
      );
    }
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

  /** DNS records with this exact name and type (content normalized to
   *  lowercase without a trailing dot). */
  async findDnsRecords(zoneId: string, type: string, name: string): Promise<Array<{ id: string; content: string }>> {
    const list = await this.fetch(
      `/zones/${zoneId}/dns_records?type=${type}&name=${encodeURIComponent(name)}`,
    );
    if (!list.ok) throw await error('findDnsRecords', list);
    const records = ((await list.json()) as { result: Array<{ id: string; content?: string }> }).result;
    return records.map((r) => ({ id: r.id, content: normalizeDnsContent(r.content) }));
  }

  /** Create or update a DNS record. Idempotent — if a record with the
   *  same name+type and the same content exists, it's updated in place.
   *  An existing record whose content differs is never overwritten: that
   *  record routes the hostname somewhere else (another site's Pages
   *  project), so this throws CloudflareConflictError instead. */
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
    const found = ((await list.json()) as { result: Array<{ id: string; content?: string }> }).result[0];
    if (found && normalizeDnsContent(found.content) !== normalizeDnsContent(args.content)) {
      throw new CloudflareConflictError(
        'dns_record_conflict',
        `A ${args.type} record for ${args.name} already points somewhere else; refusing to overwrite it.`,
      );
    }

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

  /** Delete records by name and type. With `expectedContent`, only records
   *  pointing there are deleted, so a caller can never remove a record that
   *  routes the hostname to someone else. */
  async deleteDnsRecord(zoneId: string, name: string, type: string, expectedContent?: string): Promise<void> {
    const list = await this.fetch(
      `/zones/${zoneId}/dns_records?type=${type}&name=${encodeURIComponent(name)}`,
    );
    if (!list.ok) throw await error('deleteDnsRecord:list', list);
    const records = ((await list.json()) as { result: Array<{ id: string; content?: string }> }).result
      .filter((r) => expectedContent === undefined || normalizeDnsContent(r.content) === normalizeDnsContent(expectedContent));
    for (const r of records) {
      const res = await this.fetch(`/zones/${zoneId}/dns_records/${r.id}`, { method: 'DELETE' });
      if (!res.ok) throw await error('deleteDnsRecord:delete', res);
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

/** A hostname or DNS record that belongs to something else. Never retried
 *  or overwritten: the caller picks another hostname or reports a conflict. */
export class CloudflareConflictError extends Error {
  constructor(readonly code: 'domain_in_use' | 'dns_record_conflict', message: string) {
    super(message);
    this.name = 'CloudflareConflictError';
  }
}

function normalizeDnsContent(content: string | undefined): string {
  return (content ?? '').trim().toLowerCase().replace(/\.$/, '');
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
