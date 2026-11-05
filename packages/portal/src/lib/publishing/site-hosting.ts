// Sites served by a hosting service bound to this installation.
//
// A site in the `hosted` publishing mode is frozen and built by its
// organization's build engine like any other site, but the finished static
// artifact is handed to a separate hosting service instead of a Pages project
// in a connected Cloudflare account. The service owns everything about
// serving: where the files live, the site's platform address, custom
// hostnames and which publication is live. Core only drives publications and
// mirrors the hostnames on the site document.
//
// The service is reached through the `SITE_HOSTING` service binding (Workers
// RPC); the binding is the credential. Without it the mode does not exist:
// no site can be created in it and every entry point answers 404
// `site_hosting_unavailable`. Values crossing the binding are plain data,
// except the artifact, which is passed as an object whose `names()` and
// `read()` the service calls back.
//
// Every method answers with an envelope instead of throwing, because Workers
// RPC keeps only an error's message: `{ ok: true, value }` or
// `{ ok: false, error: { code, status, message, retryable } }`.

import { paths, type Site } from '@typeroll/shared';
import { randomUUID } from 'node:crypto';
import type { ReadWriteStore } from '../datastore';
import { getStore } from '../datastore';
import { ownerPath } from '../store/sharded-store';
import { ConnectionError } from './connections';
import type { DnsRequirement } from './domain-provider';

export const HOSTED_MODE = 'hosted' as const;
export const SITE_HOSTING_API = 'typeroll-site-hosting';
/** Bumped on any incompatible change of the methods or values below. */
export const SITE_HOSTING_VERSION = 1;

export const SITE_HOSTING_UNAVAILABLE = {
  code: 'site_hosting_unavailable',
  message: 'This publishing provider is not available.',
} as const;

/** A site as the hosting service knows it. `uid` is immutable: it survives a move to another organization. */
export interface HostingSiteRef { org: string; site: string; uid: string }

export interface HostingCustomDomain { hostname: string; status: string; ssl_status: string | null }

export interface HostingDomains {
  /** The address the service assigned, e.g. `bakery.<platform domain>`. */
  platform_host: string | null;
  /** The owner launched the site: its primary hostname may be indexed. */
  launched: boolean;
  /** The custom hostname the site is served on after launch; other hostnames redirect to it. */
  primary_host: string | null;
  custom: HostingCustomDomain[];
  /** The CNAME target customers point custom hostnames at. */
  dns_target: string;
}

export interface HostingDomainStatus {
  hostname: string;
  status: string;
  ssl_status: string | null;
  certificate_ready: boolean;
  /** The service serves the hostname with a valid certificate. */
  live: boolean;
  action: 'configure_dns' | 'wait' | 'ready' | 'blocked';
  requirements: DnsRequirement[];
  notes: string[];
  errors: string[];
}

export interface HostingActivation { publication_id: string; digest: string; deployed_at: string }

export interface HostingDeployment {
  live: HostingActivation | null;
  candidate: HostingActivation | null;
  /** Newest first, bounded. */
  history: Array<HostingActivation & { slot: 'live' | 'candidate'; action: 'publish' | 'activate' }>;
  /** Recorded publications that can be made live again, newest first. */
  uploads: Array<{ publication_id: string; digest: string; file_count: number; bytes: number; created_at: string }>;
}

export interface HostingPublishResult {
  publication_id: string;
  digest: string;
  /** Files the service had to store; 0 when every file was already stored. */
  uploaded_files: number;
  /** True when this exact publication was already live and nothing was sent. */
  unchanged: boolean;
}

/** A finished build artifact, by relative file name (no leading slash). The service calls back. */
export interface ArtifactFiles {
  names(): Promise<string[]>;
  read(name: string): Promise<Uint8Array>;
}

export type TrailingSlashPolicy = 'always' | 'never' | 'ignore';

export interface HostingError { code: string; status: number; message: string; retryable?: boolean; details?: Record<string, unknown> }
export type HostingResult<T> = { ok: true; value: T } | { ok: false; error: HostingError };

/** The RPC surface of the hosting service's `SiteHosting` entrypoint. */
export interface SiteHostingMethods {
  describe(): Promise<{ api: typeof SITE_HOSTING_API; version: number }>;
  /** Assign the site's platform address once; the preferred label (e.g. its slug) when free. */
  assignPlatformHost(site: HostingSiteRef, preferred: string): Promise<HostingResult<string>>;
  domains(site: HostingSiteRef): Promise<HostingResult<HostingDomains>>;
  addCustomDomain(site: HostingSiteRef, hostname: string): Promise<HostingResult<HostingDomainStatus>>;
  /** Read the hostname's current verification and certificate state (only when a caller asks). */
  refreshCustomDomain(site: HostingSiteRef, hostname: string): Promise<HostingResult<HostingDomainStatus>>;
  removeCustomDomain(site: HostingSiteRef, hostname: string): Promise<HostingResult<{ removed: boolean }>>;
  /** `primary_host` must be a live custom hostname of the site, or null to serve on the platform address. */
  setLaunch(site: HostingSiteRef, input: { launched: boolean; primary_host?: string | null }): Promise<HostingResult<HostingDomains>>;
  deployment(site: HostingSiteRef): Promise<HostingResult<HostingDeployment>>;
  /** Make a finished artifact the live publication. Idempotent per publication id. */
  publish(input: { site: HostingSiteRef; publication_id: string; trailing_slash?: TrailingSlashPolicy; files: ArtifactFiles }): Promise<HostingResult<HostingPublishResult>>;
  /** Make a recorded publication live again (rollback, restore). Pass `files` while the artifact is still stored. */
  activate(input: { site: HostingSiteRef; publication_id: string; files?: ArtifactFiles }): Promise<HostingResult<HostingPublishResult>>;
  /** Remove every hostname and stored publication of the site. Idempotent. */
  retireSite(site: HostingSiteRef): Promise<HostingResult<{ retired: true }>>;
}

export const SITE_HOSTING_METHOD_NAMES = ['describe', 'assignPlatformHost', 'domains', 'addCustomDomain', 'refreshCustomDomain', 'removeCustomDomain',
  'setLaunch', 'deployment', 'publish', 'activate', 'retireSite'] as const satisfies ReadonlyArray<keyof SiteHostingMethods>;

let binding: (() => SiteHostingMethods | null | undefined) | null = null;

/** Registered by the Worker entry: the `SITE_HOSTING` binding, when this deployment has one. */
export function setSiteHostingRuntime(factory: (() => SiteHostingMethods | null | undefined) | null): void {
  binding = factory;
}

export function siteHostingAvailable(): boolean {
  return !!binding?.();
}

export function isHostedSite(site: Pick<Site, 'publishing_mode'> | null | undefined): boolean {
  return site?.publishing_mode === HOSTED_MODE;
}

export function assertSiteHostingAvailable(): void {
  if (!siteHostingAvailable()) throw new ConnectionError(SITE_HOSTING_UNAVAILABLE.message, 404, SITE_HOSTING_UNAVAILABLE.code);
}

/** True for a failure worth retrying from a checkpoint: the service said so, or the binding itself failed. */
export function isTemporaryHostingFailure(error: unknown): boolean {
  return error instanceof ConnectionError && error.details?.retryable === true;
}

const UID = /^[a-z0-9][a-z0-9-]{7,47}$/;

/**
 * The site's immutable uid. The sharded store assigns it on first use; other
 * stores (a single SQLite file, tests) get the same ownership document.
 */
export async function hostingSiteRef(orgId: string, siteId: string, store: ReadWriteStore = getStore()): Promise<HostingSiteRef> {
  const sharded = store as ReadWriteStore & { siteUid?: (org: string, site: string) => Promise<string> };
  let uid: string | undefined;
  if (typeof sharded.siteUid === 'function') uid = await sharded.siteUid(orgId, siteId);
  else {
    const path = ownerPath(orgId, siteId);
    await store.createDocIfMissing(path, { uid: randomUUID(), org: orgId, site: siteId });
    uid = (await store.getDoc<{ uid: string }>(path))?.uid;
  }
  if (!uid || !UID.test(uid)) throw new Error('Invalid site uid');
  return { org: orgId, site: siteId, uid };
}

type Unwrapped = { [K in Exclude<keyof SiteHostingMethods, 'describe'>]: (...args: Parameters<SiteHostingMethods[K]>) =>
  Promise<Awaited<ReturnType<SiteHostingMethods[K]>> extends HostingResult<infer T> ? T : never> };

/**
 * The bound service with envelopes unwrapped: a refusal becomes a
 * ConnectionError with the service's code and status; a failure of the
 * binding itself is a retryable 503.
 */
export function siteHosting(): Unwrapped {
  const service = binding?.();
  if (!service) throw new ConnectionError(SITE_HOSTING_UNAVAILABLE.message, 404, SITE_HOSTING_UNAVAILABLE.code);
  const call = (name: keyof Unwrapped) => async (...args: unknown[]) => {
    let result: HostingResult<unknown>;
    try { result = await (service[name] as (...input: unknown[]) => Promise<HostingResult<unknown>>)(...args); }
    catch (error) {
      console.error(JSON.stringify({ event: 'site_hosting_unreachable', method: name, error: error instanceof Error ? error.message.slice(0, 300) : 'unknown' }));
      throw new ConnectionError('The hosting service did not answer. Retry in a moment.', 503, 'site_hosting_unreachable', { retryable: true });
    }
    if (result?.ok === true) return result.value;
    const failure = result?.ok === false ? result.error : { code: 'site_hosting_invalid_response', status: 502, message: 'The hosting service answered unexpectedly.' };
    throw new ConnectionError(failure.message, failure.status, failure.code, { ...(failure.details ?? {}), retryable: failure.retryable === true });
  };
  return Object.fromEntries(SITE_HOSTING_METHOD_NAMES.filter(name => name !== 'describe').map(name => [name, call(name)])) as unknown as Unwrapped;
}

/** An artifact held in memory (`completedBuild().files`) as the callback object the service reads. */
export function artifactFiles(files: Record<string, Uint8Array>): ArtifactFiles {
  return {
    names: async () => Object.keys(files),
    read: async name => {
      const bytes = files[name];
      if (!bytes) throw new Error(`${name} is not part of this artifact`);
      return bytes;
    },
  };
}

/**
 * The canonical host a publication is built for: the primary custom hostname,
 * else the custom hostname the site declared (domain-first, as for other
 * sites: the canonical is right before DNS moves), else the platform address.
 * Visitors are kept away from an unlaunched site by the service's noindex.
 */
export function hostedWebsiteHost(state: HostingDomains | null, site: Pick<Site, 'domain'> | null): string | null {
  if (!state) return null;
  if (state.primary_host && state.custom.some(domain => domain.hostname === state.primary_host)) return state.primary_host;
  if (site?.domain && state.custom.some(domain => domain.hostname === site.domain)) return site.domain;
  return state.platform_host;
}

/** The host that answers without a redirect: the launched primary, else the platform address. */
export function hostedServingHost(state: HostingDomains | null): string | null {
  if (!state) return null;
  if (state.launched && state.primary_host && state.custom.some(domain => domain.hostname === state.primary_host)) return state.primary_host;
  return state.platform_host;
}

/** The site's platform address, assigned once and mirrored on the site document. */
export async function ensureHostedPlatformHost(orgId: string, siteId: string, preferred: string): Promise<string> {
  const store = getStore();
  const host = await siteHosting().assignPlatformHost(await hostingSiteRef(orgId, siteId, store), preferred);
  const path = paths.site(orgId, siteId);
  const site = await store.getDoc<Site>(path);
  if (site && site.hosting_config?.fallback_subdomain !== host) {
    await store.updateDoc(path, { hosting_config: { ...(site.hosting_config ?? {}), fallback_subdomain: host } });
  }
  return host;
}

/** The service's hostname state of a site. */
export async function hostedDomains(orgId: string, siteId: string): Promise<HostingDomains> {
  return siteHosting().domains(await hostingSiteRef(orgId, siteId));
}

/**
 * Take a hosted site off the service: every hostname and stored publication.
 * For the operator's site retirement; idempotent, so an interrupted
 * retirement can run again.
 */
export async function retireHostedSite(orgId: string, siteId: string): Promise<{ retired: true }> {
  return siteHosting().retireSite(await hostingSiteRef(orgId, siteId));
}
