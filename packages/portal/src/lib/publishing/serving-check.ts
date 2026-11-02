import { createHash } from 'node:crypto';
import { paths } from '@typeroll/shared';
import { getStore } from '../datastore';
import { notifyScheduledWrites, workPath, type ScheduledWork } from '../scheduling/index';
import { siteDomainConfigPath, type DomainConfiguration } from './domain-config';
import { observeRedirectHost, observeWebsiteHost, servingIssue, type ServingIssue, type ServingObservation } from './serving-host';
import { hostPointsAtProject, observePagesDomain, pagesDomainIssue, type PagesDomainIssue, type PagesDomainObservation } from './pages-domain-status';

/**
 * Live-serving verification after a website host goes live. A traffic switch
 * is verified once, but another provider can take the host back minutes later
 * (a previous host's Cloudflare for SaaS hostname outranks the customer's own
 * DNS). Follow-up checks run from the scheduled-work index, so no process
 * sleeps or keeps a timer. They only read public responses: they never change
 * DNS and never roll back.
 *
 * Each check also reads the Cloudflare Pages custom domain of the website
 * host (CH-07). Pages serves the host only while that domain is `active`; a
 * domain left `pending` or `deactivated` (for example while a previous host's
 * hostname blocked validation) is retried with Cloudflare's validation retry,
 * at most once per check and rate-limited, when the host already points at the
 * project. That retry is the only provider write.
 */

/** Minutes after going live. */
export const SERVING_CHECK_OFFSETS_MINUTES = [2, 10, 30] as const;
/** After the first series, live hosts are checked once a day. */
export const SERVING_CHECK_DAILY_MS = 24 * 3_600_000;
/** Reads refresh a standing alarm at most this often. */
const READ_REFRESH_MS = 60_000;
/** An explicit validation retry runs at most this often. */
const EXPLICIT_RETRY_MS = 60_000;
export const SERVING_ALARM_PHASE = 'served by another host';
export const PAGES_ALARM_PHASE = 'Pages custom domain not active';

export interface ServingCheck {
  status: 'pending' | 'serving' | 'other_host' | 'other_publication' | 'inconclusive';
  publication_id: string;
  website_host: string;
  job_id: string | null;
  live_at: string;
  checked_at: string | null;
  next_check_at: string | null;
  /** The latest observation per host. */
  hosts: ServingObservation[];
  /** What answered instead of the expected publication, while an alarm stands. */
  observed?: { host: string; publication: string | null; http_status: number | null; provider_hint: ServingObservation['provider_hint'] } | null;
  issue?: ServingIssue | null;
  /** The latest conclusive read of the website host's Cloudflare Pages custom domain. */
  pages_domain?: PagesDomainObservation | null;
  /** Stands while that domain is not active; an inconclusive read never sets or clears it. */
  pages_issue?: PagesDomainIssue | null;
}

export const servingAlarm = (check: ServingCheck | null | undefined): check is ServingCheck & { issue: ServingIssue } =>
  !!check?.issue && (check.status === 'other_host' || check.status === 'other_publication');

export const pagesDomainAlarm = (check: ServingCheck | null | undefined): check is ServingCheck & { pages_issue: PagesDomainIssue } => !!check?.pages_issue;

const nextDue = (liveAt: number, now: number) => SERVING_CHECK_OFFSETS_MINUTES.map(minutes => liveAt + minutes * 60_000).find(due => due > now) ?? null;
/** The next check: the first series, then daily for as long as the host is live. */
const nextScheduled = (liveAt: number, now: number) => nextDue(liveAt, now) ?? now + SERVING_CHECK_DAILY_MS;

/**
 * Called when a main publication made a website host live. Saves the pending
 * state and indexes the first follow-up check. A standing alarm is kept until a
 * check proves the host is served again.
 */
export async function scheduleServingChecks(org: string, site: string, input: { publication_id: string; website_host: string; job_id: string | null }, now = Date.now()): Promise<void> {
  const store = getStore(), source = siteDomainConfigPath(org, site);
  const due = nextDue(now, now)!;
  const config = await store.getDoc<DomainConfiguration>(source);
  const previous = config?.serving_check;
  const alarm = (servingAlarm(previous) || pagesDomainAlarm(previous)) && previous.website_host === input.website_host ? previous : null;
  const check: ServingCheck = {
    ...(alarm ?? { status: 'pending', checked_at: null, hosts: [], observed: null, issue: null, pages_domain: null, pages_issue: null }),
    publication_id: input.publication_id, website_host: input.website_host, job_id: input.job_id,
    live_at: new Date(now).toISOString(), next_check_at: new Date(due).toISOString(),
  };
  await store.updateDoc(source, { serving_check: check });
  const payload = { publication_id: input.publication_id, website_host: input.website_host, live_at: now };
  const work: ScheduledWork = {
    kind: 'domain_serving_check', source, due_at: due, payload,
    generation: createHash('sha256').update(JSON.stringify({ kind: 'domain_serving_check', source, due, payload })).digest('hex'),
    lease_until: 0, lease_owner: null,
  };
  const path = workPath(source, 'domain_serving_check');
  await store.setDoc(path, work as unknown as Record<string, unknown>);
  await notifyScheduledWrites([{ path, data: work }]);
}

/** Observe the live website host and its redirect hosts against the current publication. */
export async function checkLiveServing(config: DomainConfiguration, fetchImpl?: typeof fetch): Promise<{ status: Exclude<ServingCheck['status'], 'pending'>; hosts: ServingObservation[]; issue: ServingIssue | null; failing: ServingObservation | null }> {
  const expected = config.published!.publication_id;
  const website = config.published!.hosts.website_host!;
  const redirects = config.active?.website_host === website ? config.active.redirect_hosts ?? [] : [];
  const hosts = await Promise.all([
    observeWebsiteHost(website, expected, fetchImpl),
    ...redirects.map(host => observeRedirectHost(host, website, expected, fetchImpl)),
  ]);
  const failing = hosts.find(host => host.status === 'other_host') ?? hosts.find(host => host.status === 'other_publication') ?? null;
  if (failing) return { status: failing.status as 'other_host' | 'other_publication', hosts, failing, issue: servingIssue(failing, expected) };
  return { status: hosts.some(host => host.status === 'inconclusive') ? 'inconclusive' : 'serving', hosts, failing: null, issue: null };
}

/**
 * Run one check and save it on the domain configuration and the job that made
 * the host live. An inconclusive result (transport error, edge error, challenge)
 * never raises an alarm and never clears one.
 */
export async function recordServingCheck(org: string, site: string, opts: { fetchImpl?: typeof fetch; now?: number; nextCheckAt?: number | null; retryValidation?: 'auto' | 'explicit' } = {}): Promise<ServingCheck | null> {
  const store = getStore(), source = siteDomainConfigPath(org, site);
  const config = await store.getDoc<DomainConfiguration>(source);
  const current = config?.serving_check;
  if (!config || !current || config.state !== 'live' || !config.published?.publication_id || !config.published.hosts.website_host ||
      config.published.hosts.website_host !== current.website_host) return null;
  const now = opts.now ?? Date.now();
  const [result, pages] = await Promise.all([
    checkLiveServing(config, opts.fetchImpl),
    observeLivePagesDomain(org, site, config, current.pages_domain ?? null, { now, force: opts.retryValidation === 'explicit' }),
  ]);
  const checkedAt = new Date(now).toISOString();
  const nextCheckAt = opts.nextCheckAt === undefined ? current.next_check_at : opts.nextCheckAt === null ? null : new Date(opts.nextCheckAt).toISOString();
  const base = { ...current, publication_id: config.published.publication_id, job_id: config.published.job_id ?? current.job_id, hosts: result.hosts, next_check_at: nextCheckAt };
  const served: ServingCheck = result.status === 'inconclusive'
    ? { ...base, ...(servingAlarm(current) ? {} : { status: 'inconclusive', checked_at: checkedAt }) }
    : { ...base, status: result.status, checked_at: checkedAt, issue: result.issue,
      observed: result.failing ? { host: result.failing.host, publication: result.failing.publication, http_status: result.failing.http_status, provider_hint: result.failing.provider_hint } : null };
  // An inconclusive Pages read (or none, without a known project) keeps the previous state, alarm included.
  const pagesConclusive = !!pages?.observation.status;
  const check: ServingCheck = pagesConclusive
    ? { ...served, pages_domain: pages!.observation, pages_issue: pagesDomainIssue(pages!.observation, pages!.project) } : served;
  // A newer publication or domain change owns the configuration now; it schedules its own checks.
  const saved = await store.compareAndUpdateDoc<DomainConfiguration>(source, value => value.revision === config.revision &&
    value.published?.publication_id === config.published!.publication_id && value.state === 'live', { serving_check: check });
  if (!saved) return null;
  if (result.status !== 'inconclusive' || pagesConclusive) await recordJobServing(org, site, check);
  if (check.issue && servingAlarm(check)) console.warn(JSON.stringify({ event: 'domain_serving_alarm', org_id: org, site_id: site, code: check.issue.code, host: check.issue.host, provider: check.observed?.provider_hint?.provider ?? null }));
  if (pagesDomainAlarm(check)) console.warn(JSON.stringify({ event: 'domain_serving_alarm', org_id: org, site_id: site, code: check.pages_issue.code, host: check.pages_issue.host, pages_status: check.pages_issue.status, retry: check.pages_domain?.retry ?? null }));
  return check;
}

/**
 * Read the Pages custom domain of the live website host from the project that
 * published it. Null when the project is unknown (nothing to read). Retries
 * validation for a pending or deactivated domain when the host's DNS already
 * points at the project, at most once per check and rate-limited.
 */
async function observeLivePagesDomain(org: string, site: string, config: DomainConfiguration, previous: PagesDomainObservation | null, opts: { now: number; force: boolean }): Promise<{ observation: PagesDomainObservation; project: string } | null> {
  const host = config.published!.hosts.website_host!;
  if (host.endsWith('.pages.dev')) return null;
  const target = (await getStore().getDoc<any>(`${paths.site(org, site)}/publishing_targets/main`))?.last_publication;
  if (!target?.account_id || !target.project || target.publication_id !== config.published!.publication_id) return null;
  const inconclusive = (error: unknown) => ({ project: target.project, observation: { host, status: null, validation_method: null, validation_status: null, error_message: null,
    checked_at: new Date(opts.now).toISOString(), retried_at: previous?.retried_at ?? null, retry: null, error: error instanceof Error ? error.message : 'The Pages custom domain could not be read.' } satisfies PagesDomainObservation });
  try {
    const group = target.hosting_group_id ?? 'default';
    const { cloudflareClient } = await import('./cloudflare-oauth');
    const provider = await cloudflareClient(org, fetch, undefined, group);
    const automatic = config.published!.dns_mode === 'automatic';
    // Only a rate-limited explicit retry may skip the automatic interval.
    const force = opts.force && !(previous?.retried_at && opts.now - Date.parse(previous.retried_at) < EXPLICIT_RETRY_MS);
    const observation = await observePagesDomain(provider, { accountId: target.account_id, project: target.project, host, now: opts.now,
      lastRetryAt: previous?.retried_at ?? null, force,
      dnsPointsAtProject: async () => {
        if (!automatic) return hostPointsAtProject({ host, project: target.project });
        const [{ hostingDns }, { findZone }] = await Promise.all([import('./hosting-dns'), import('./domain-provider')]);
        const dns = await hostingDns(org, group, host);
        const zone = await findZone(dns.provider, dns.accountId, host);
        return zone ? hostPointsAtProject({ host, project: target.project, zone: { provider: dns.provider, zoneId: zone.id } }) : null;
      } });
    return { project: target.project, observation };
  } catch (error) {
    return inconclusive(error);
  }
}

/** The job must not read as a healthy `live` while another host answers or Pages does not serve the host. */
async function recordJobServing(org: string, site: string, check: ServingCheck) {
  if (!check.job_id) return;
  const alarm = servingAlarm(check) ? { phase: SERVING_ALARM_PHASE, message: check.issue.message }
    : pagesDomainAlarm(check) ? { phase: PAGES_ALARM_PHASE, message: check.pages_issue.message } : null;
  const summary = { status: check.status, checked_at: check.checked_at, observed: check.observed ?? null, issue: check.issue ?? null,
    pages_domain: check.pages_domain ?? null, pages_issue: check.pages_issue ?? null };
  await getStore().compareAndUpdateDoc<any>(paths.deploy(org, site, check.job_id),
    job => job.status === 'succeeded' && [SERVING_ALARM_PHASE, PAGES_ALARM_PHASE, 'live'].includes(job.phase),
    alarm ? { serving_check: summary, phase: alarm.phase, verification_message: alarm.message }
      : { serving_check: summary, phase: 'live', verification_message: null });
}

/** Scheduled-work entry point. Returns the next due time, or null once the host is no longer live. */
export async function runScheduledServingCheck(source: string, payload: { live_at?: number }, now = Date.now()): Promise<number | null> {
  const [, org, , site] = source.split('/');
  if (source !== siteDomainConfigPath(org, site) || typeof payload.live_at !== 'number') return null;
  const next = nextScheduled(payload.live_at, now);
  const check = await recordServingCheck(org, site, { now, nextCheckAt: next });
  return check ? next : null;
}

/**
 * Reads refresh a standing alarm, so a fixed host clears without waiting for
 * another publication. Throttled, read-only towards the provider, and never
 * fatal for the read.
 */
export async function refreshServingAlarm(org: string, site: string, config: DomainConfiguration, fetchImpl?: typeof fetch): Promise<DomainConfiguration> {
  const check = config.serving_check;
  if (!check && config.state === 'live') return ensureServingChecks(org, site, config);
  const checkedAt = Math.max(Date.parse(check?.checked_at ?? '') || 0, Date.parse(check?.pages_domain?.checked_at ?? '') || 0);
  if (!(servingAlarm(check) || pagesDomainAlarm(check)) || Date.now() - checkedAt < READ_REFRESH_MS) return config;
  try {
    const refreshed = await recordServingCheck(org, site, { fetchImpl });
    return refreshed ? { ...config, serving_check: refreshed } : config;
  } catch {
    return config;
  }
}

/**
 * Sites that went live before follow-up checks existed get them on their next
 * read, so a Pages domain that is not active (or another host) is found and the
 * daily check covers them too. Never fatal for the read.
 */
async function ensureServingChecks(org: string, site: string, config: DomainConfiguration): Promise<DomainConfiguration> {
  const host = config.published?.hosts.website_host;
  if (!host || !config.published?.publication_id || config.active?.website_host !== host) return config;
  try {
    await scheduleServingChecks(org, site, { publication_id: config.published.publication_id, website_host: host, job_id: config.published.job_id ?? null });
    return (await getStore().getDoc<DomainConfiguration>(siteDomainConfigPath(org, site))) ?? config;
  } catch {
    return config;
  }
}

/**
 * Explicit, idempotent validation retry for the live website host
 * (`retry_validation`): one check now, with Cloudflare's validation retry when
 * the Pages domain is pending or deactivated and the host points at the
 * project. Repeated calls within a minute do not repeat the retry.
 */
export async function retryPagesValidation(org: string, site: string): Promise<ServingCheck | null> {
  const store = getStore(), source = siteDomainConfigPath(org, site);
  let config: DomainConfiguration | null = await store.getDoc<DomainConfiguration>(source);
  if (config?.state === 'live' && !config.serving_check) config = await ensureServingChecks(org, site, config);
  if (!config?.serving_check) return null;
  return recordServingCheck(org, site, { retryValidation: 'explicit' });
}
