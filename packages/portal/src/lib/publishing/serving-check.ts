import { createHash } from 'node:crypto';
import { paths } from '@typeroll/shared';
import { getStore } from '../datastore';
import { notifyScheduledWrites, workPath, type ScheduledWork } from '../scheduling/index';
import { siteDomainConfigPath, type DomainConfiguration } from './domain-config';
import { observeRedirectHost, observeWebsiteHost, servingIssue, type ServingIssue, type ServingObservation } from './serving-host';

/**
 * Live-serving verification after a website host goes live. A traffic switch
 * is verified once, but another provider can take the host back minutes later
 * (a previous host's Cloudflare for SaaS hostname outranks the customer's own
 * DNS). Follow-up checks run from the scheduled-work index, so no process
 * sleeps or keeps a timer. They only read public responses: they never change
 * DNS and never roll back.
 */

/** Minutes after going live. */
export const SERVING_CHECK_OFFSETS_MINUTES = [2, 10, 30] as const;
/** Reads refresh a standing alarm at most this often. */
const READ_REFRESH_MS = 60_000;
export const SERVING_ALARM_PHASE = 'served by another host';

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
}

export const servingAlarm = (check: ServingCheck | null | undefined): check is ServingCheck & { issue: ServingIssue } =>
  !!check?.issue && (check.status === 'other_host' || check.status === 'other_publication');

const nextDue = (liveAt: number, now: number) => SERVING_CHECK_OFFSETS_MINUTES.map(minutes => liveAt + minutes * 60_000).find(due => due > now) ?? null;

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
  const alarm = servingAlarm(previous) && previous.website_host === input.website_host ? previous : null;
  const check: ServingCheck = {
    ...(alarm ?? { status: 'pending', checked_at: null, hosts: [], observed: null, issue: null }),
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
export async function recordServingCheck(org: string, site: string, opts: { fetchImpl?: typeof fetch; now?: number; nextCheckAt?: number | null } = {}): Promise<ServingCheck | null> {
  const store = getStore(), source = siteDomainConfigPath(org, site);
  const config = await store.getDoc<DomainConfiguration>(source);
  const current = config?.serving_check;
  if (!config || !current || config.state !== 'live' || !config.published?.publication_id || !config.published.hosts.website_host ||
      config.published.hosts.website_host !== current.website_host) return null;
  const now = opts.now ?? Date.now();
  const result = await checkLiveServing(config, opts.fetchImpl);
  const checkedAt = new Date(now).toISOString();
  const nextCheckAt = opts.nextCheckAt === undefined ? current.next_check_at : opts.nextCheckAt === null ? null : new Date(opts.nextCheckAt).toISOString();
  const base = { ...current, publication_id: config.published.publication_id, job_id: config.published.job_id ?? current.job_id, hosts: result.hosts, next_check_at: nextCheckAt };
  const check: ServingCheck = result.status === 'inconclusive'
    ? { ...base, ...(servingAlarm(current) ? {} : { status: 'inconclusive', checked_at: checkedAt }) }
    : { ...base, status: result.status, checked_at: checkedAt, issue: result.issue,
      observed: result.failing ? { host: result.failing.host, publication: result.failing.publication, http_status: result.failing.http_status, provider_hint: result.failing.provider_hint } : null };
  // A newer publication or domain change owns the configuration now; it schedules its own checks.
  const saved = await store.compareAndUpdateDoc<DomainConfiguration>(source, value => value.revision === config.revision &&
    value.published?.publication_id === config.published!.publication_id && value.state === 'live', { serving_check: check });
  if (!saved) return null;
  if (result.status !== 'inconclusive') await recordJobServing(org, site, check);
  if (check.issue && servingAlarm(check)) console.warn(JSON.stringify({ event: 'domain_serving_alarm', org_id: org, site_id: site, code: check.issue.code, host: check.issue.host, provider: check.observed?.provider_hint?.provider ?? null }));
  return check;
}

/** The job must not read as a healthy `live` while another host answers. */
async function recordJobServing(org: string, site: string, check: ServingCheck) {
  if (!check.job_id) return;
  const alarm = servingAlarm(check);
  const summary = { status: check.status, checked_at: check.checked_at, observed: check.observed ?? null, issue: check.issue ?? null };
  await getStore().compareAndUpdateDoc<any>(paths.deploy(org, site, check.job_id),
    job => job.status === 'succeeded' && [SERVING_ALARM_PHASE, 'live'].includes(job.phase),
    alarm ? { serving_check: summary, phase: SERVING_ALARM_PHASE, verification_message: check.issue!.message }
      : { serving_check: summary, phase: 'live', verification_message: null });
}

/** Scheduled-work entry point. Returns the next due time, or null when the series is finished. */
export async function runScheduledServingCheck(source: string, payload: { live_at?: number }, now = Date.now()): Promise<number | null> {
  const [, org, , site] = source.split('/');
  if (source !== siteDomainConfigPath(org, site) || typeof payload.live_at !== 'number') return null;
  const next = nextDue(payload.live_at, now);
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
  if (!servingAlarm(check) || Date.now() - Date.parse(check.checked_at ?? '') < READ_REFRESH_MS) return config;
  try {
    const refreshed = await recordServingCheck(org, site, { fetchImpl });
    return refreshed ? { ...config, serving_check: refreshed } : config;
  } catch {
    return config;
  }
}
