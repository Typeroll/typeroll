// An in-memory hosting service implementing the SITE_HOSTING contract, for
// offline tests of the `hosted` mode. It keeps only what Core can observe:
// hostnames and their state, what is live, and the files of each recorded
// publication (read through the ArtifactFiles callbacks, as the real service
// reads them over RPC).
import type { ArtifactFiles, HostingDomains, HostingDomainStatus, HostingResult, HostingSiteRef, SiteHostingMethods } from '../../lib/publishing/site-hosting';

interface SiteState {
  domains: HostingDomains;
  live: { publication_id: string; digest: string; deployed_at: string } | null;
  history: Array<{ publication_id: string; digest: string; deployed_at: string; slot: 'live'; action: 'publish' | 'activate' }>;
  uploads: Map<string, { files: Record<string, Uint8Array>; created_at: string }>;
}

const ok = <T>(value: T): HostingResult<T> => ({ ok: true, value });
const refuse = (code: string, status: number, message: string): HostingResult<never> => ({ ok: false, error: { code, status, message } });

export class FakeSiteHosting implements SiteHostingMethods {
  readonly sites = new Map<string, SiteState>();
  /** Hostnames the "provider" verified; others stay pending. */
  readonly active = new Set<string>();
  readonly calls: string[] = [];
  readonly owners = new Map<string, string>();

  constructor(readonly platformDomain = 'example-sites.test', readonly dnsTarget = 'customers.example-sites.test') {}

  private state(site: HostingSiteRef): SiteState {
    let state = this.sites.get(site.uid);
    if (!state) this.sites.set(site.uid, state = { domains: { platform_host: null, launched: false, primary_host: null, custom: [], dns_target: this.dnsTarget }, live: null, history: [], uploads: new Map() });
    return state;
  }

  private status(hostname: string): HostingDomainStatus {
    const live = this.active.has(hostname);
    return { hostname, status: live ? 'active' : 'pending', ssl_status: live ? 'active' : 'pending_validation', certificate_ready: live, live,
      action: live ? 'ready' : 'configure_dns', requirements: live ? [] : [{ phase: 'traffic', type: 'CNAME', name: hostname, content: this.dnsTarget, status: 'required' }], notes: [], errors: [] };
  }

  /** The files a hostname serves now, or null (what a visitor would get). */
  served(hostname: string): Record<string, Uint8Array> | null {
    const uid = this.owners.get(hostname);
    const state = uid ? this.sites.get(uid) : undefined;
    return state?.live ? state.uploads.get(state.live.publication_id)?.files ?? null : null;
  }

  activateHostname(hostname: string) { this.active.add(hostname); }

  async describe() { return { api: 'typeroll-site-hosting' as const, version: 1 }; }

  async assignPlatformHost(site: HostingSiteRef, preferred: string) {
    this.calls.push('assignPlatformHost');
    const state = this.state(site);
    if (!state.domains.platform_host) {
      const label = preferred.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'site';
      const host = this.owners.has(`${label}.${this.platformDomain}`) ? `${label}-${site.uid.slice(0, 6)}.${this.platformDomain}` : `${label}.${this.platformDomain}`;
      state.domains.platform_host = host;
      this.owners.set(host, site.uid);
    }
    return ok(state.domains.platform_host!);
  }

  async domains(site: HostingSiteRef) { this.calls.push('domains'); return ok(structuredClone(this.state(site).domains)); }

  async addCustomDomain(site: HostingSiteRef, hostname: string) {
    this.calls.push('addCustomDomain');
    const owner = this.owners.get(hostname);
    if (owner && owner !== site.uid) return refuse('hosted_hostname_taken', 409, 'Another site already uses this hostname.');
    const state = this.state(site);
    this.owners.set(hostname, site.uid);
    if (!state.domains.custom.some(domain => domain.hostname === hostname)) state.domains.custom.push({ hostname, status: 'pending', ssl_status: null });
    return ok(this.status(hostname));
  }

  async refreshCustomDomain(site: HostingSiteRef, hostname: string) {
    this.calls.push('refreshCustomDomain');
    const domain = this.state(site).domains.custom.find(item => item.hostname === hostname);
    if (!domain) return refuse('hosted_domain_not_found', 404, 'This site has no such custom hostname.');
    const status = this.status(hostname);
    Object.assign(domain, { status: status.status, ssl_status: status.ssl_status });
    return ok(status);
  }

  async removeCustomDomain(site: HostingSiteRef, hostname: string) {
    this.calls.push('removeCustomDomain');
    const state = this.state(site);
    const before = state.domains.custom.length;
    state.domains.custom = state.domains.custom.filter(item => item.hostname !== hostname);
    if (state.domains.primary_host === hostname) state.domains.primary_host = null;
    if (this.owners.get(hostname) === site.uid) this.owners.delete(hostname);
    this.active.delete(hostname);
    return ok({ removed: state.domains.custom.length !== before });
  }

  async setLaunch(site: HostingSiteRef, input: { launched: boolean; primary_host?: string | null }) {
    this.calls.push('setLaunch');
    const state = this.state(site);
    const primary = input.primary_host === undefined ? state.domains.primary_host : input.primary_host;
    if (primary) {
      const domain = state.domains.custom.find(item => item.hostname === primary);
      if (!domain) return refuse('hosted_domain_not_found', 422, 'The primary hostname must be a custom hostname of this site.');
      if (!this.active.has(primary)) return refuse('hosted_domain_not_live', 409, 'Check the custom hostname until it is live before making it primary.');
    }
    state.domains = { ...state.domains, launched: input.launched, primary_host: primary ?? null };
    return ok(structuredClone(state.domains));
  }

  async deployment(site: HostingSiteRef) {
    this.calls.push('deployment');
    const state = this.state(site);
    return ok({ live: state.live, candidate: null, history: [...state.history],
      uploads: [...state.uploads.entries()].map(([publication_id, upload]) => ({ publication_id, digest: `d-${publication_id}`, file_count: Object.keys(upload.files).length, bytes: 0, created_at: upload.created_at }))
        .sort((a, b) => b.created_at.localeCompare(a.created_at)) });
  }

  private go(site: HostingSiteRef, publication_id: string, action: 'publish' | 'activate') {
    const state = this.state(site);
    const activation = { publication_id, digest: `d-${publication_id}`, deployed_at: new Date().toISOString() };
    state.live = activation;
    state.history.unshift({ ...activation, slot: 'live', action });
  }

  async publish(input: { site: HostingSiteRef; publication_id: string; files: ArtifactFiles }) {
    this.calls.push('publish');
    const state = this.state(input.site);
    if (state.live?.publication_id === input.publication_id) return ok({ publication_id: input.publication_id, digest: state.live.digest, uploaded_files: 0, unchanged: true });
    const files: Record<string, Uint8Array> = {};
    for (const name of await input.files.names()) files[name] = await input.files.read(name);
    if (!state.uploads.has(input.publication_id)) state.uploads.set(input.publication_id, { files, created_at: new Date(Date.now() + state.uploads.size).toISOString() });
    this.go(input.site, input.publication_id, 'publish');
    return ok({ publication_id: input.publication_id, digest: `d-${input.publication_id}`, uploaded_files: Object.keys(files).length, unchanged: false });
  }

  async activate(input: { site: HostingSiteRef; publication_id: string }) {
    this.calls.push('activate');
    if (!this.state(input.site).uploads.has(input.publication_id)) return refuse('hosted_upload_not_found', 404, 'This publication has no recorded upload.');
    this.go(input.site, input.publication_id, 'activate');
    return ok({ publication_id: input.publication_id, digest: `d-${input.publication_id}`, uploaded_files: 0, unchanged: false });
  }

  async retireSite(site: HostingSiteRef) {
    this.calls.push('retireSite');
    for (const [hostname, owner] of [...this.owners]) if (owner === site.uid) { this.owners.delete(hostname); this.active.delete(hostname); }
    this.sites.delete(site.uid);
    return ok({ retired: true as const });
  }
}
