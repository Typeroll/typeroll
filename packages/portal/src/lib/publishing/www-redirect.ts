import { createHash } from 'node:crypto';
import { domainToASCII } from 'node:url';
import { getStore } from '../datastore';
import { ConnectionError } from './connections';
import { hostingDns } from './hosting-dns';
import { findZone, trafficFingerprint, type ZoneSummary } from './domain-provider';
import { assertTrafficNotOwnedByOtherOrganization } from './cloudflare-account-claims';
import { REDIRECT_PHASE, REDIRECT_PLACEHOLDER_ADDRESS, redirectRuleSpec, verifyRedirectHost } from './redirect-hosts';
import {
  conflictIssue, ensurePreviousHostRule, isPreviousRuleFor, permissionIssue, previousRedirectIssue, previousRuleBody, previousRuleHosts,
  previousRuleRef, previousWebsiteHosts, quotaExceeded, quotaRemedy, readPreviousRedirect, redirectsTo, retirementRuleProvider,
  type PreviousHostIssueCode,
} from './previous-hosts';
import type { DomainConfiguration, PublicationHosts } from './domain-config';
import type { HostChecks } from './host-checks';

// The www counterpart of a website host (example.com for www.example.com, and the other way round)
// answers 301 to the website host by default. It is derived from the website host, never stored as
// input, so every site gets it without a settings change; `www_redirect: false` opts out.
//
// It uses the same Single Redirect rule as previous website addresses: one Typeroll rule per website
// host in the zone (`typeroll_previous_t_…`, `http.host in {…}`), so it usually costs no extra rule.
// It is checked once per publication of the live site and by repair_previous_host_redirects, never
// in the background. Typeroll writes only that rule, never DNS, and only while the counterpart is
// proxied to this site's own Pages project or to Cloudflare's redirect placeholder address. A
// counterpart that serves anything else is reported, not taken over. A problem is always a warning:
// it never fails or delays a publication.

type Provider = (route: string, options?: { method?: string; body?: unknown; missing?: boolean }) => Promise<any>;

export type ImplicitRedirectIssueCode = PreviousHostIssueCode | 'www_redirect_host_in_use' | 'www_redirect_record_missing' |
  'www_redirect_zone_unavailable' | 'www_redirect_external_dns' | 'www_redirect_unavailable' | 'www_redirect_release_failed';

export interface ImplicitRedirectIssue { code: ImplicitRedirectIssueCode; message: string; remedy: string }

/** One implicit redirect host. `source: "default"` distinguishes it from explicit `redirect_hosts`. */
export interface ImplicitRedirect {
  host: string;
  target_host: string;
  source: 'default';
  /** planned: not checked yet. verified: the public 301 was seen. pending: the rule exists, the 301 was not seen yet. warning: see issue. */
  status: 'planned' | 'verified' | 'pending' | 'warning';
  message: string;
  issue: ImplicitRedirectIssue | null;
  next_action: 'repair_previous_host_redirects' | null;
  /** Typeroll listed the host in its redirect rule; an opt-out removes it again. */
  managed_rule?: { zone_id: string; zone_name: string } | null;
  checked_at?: string;
  publication_id?: string;
}

function ascii(host: string) {
  return domainToASCII(String(host).trim().replace(/\.$/, '')).toLowerCase();
}

/**
 * The www counterpart of a website host, or null. With the zone known, only the zone apex and
 * www.<zone> pair (this also covers multi-label suffixes such as example.co.uk). Without it, only a
 * two-label apex and www plus a two-label apex: never another subdomain such as shop.example.com.
 */
export function wwwCounterpart(host: string | null | undefined, zoneName?: string | null): string | null {
  if (!host) return null;
  const name = ascii(host);
  if (!name || !/^[a-z0-9.-]+$/.test(name) || name.split('.').some(label => !label)) return null;
  if (zoneName) {
    const zone = ascii(zoneName);
    if (!zone) return null;
    if (name === zone) return `www.${zone}`;
    if (name === `www.${zone}`) return zone;
    return null;
  }
  const labels = name.split('.');
  if (labels.length === 2 && labels[0] !== 'www') return `www.${name}`;
  if (labels.length === 3 && labels[0] === 'www') return labels.slice(1).join('.');
  return null;
}

/** Hosts whose apex/www pair can only be told apart by the zone (example.co.uk, www.example.co.uk, shop.example.com). */
function counterpartNeedsZone(host: string) {
  const labels = ascii(host).split('.');
  return (labels.length === 3 && labels[0] !== 'www') || (labels.length === 4 && labels[0] === 'www');
}

export function wwwRedirectEnabled(config: Pick<DomainConfiguration, 'www_redirect'>): boolean {
  return config.www_redirect !== false;
}

/**
 * Implicit redirect hosts for a website host: its www counterpart (or one recorded with the zone at
 * publication), minus explicit redirect hosts, the media host and hosts listed in `exclude`.
 */
export function implicitRedirectHosts(config: Pick<DomainConfiguration, 'www_redirect' | 'implicit_redirects'>, hosts: PublicationHosts | null | undefined, exclude: string[] = []): string[] {
  const target = hosts?.website_host;
  if (!target || !wwwRedirectEnabled(config)) return [];
  const recorded = (config.implicit_redirects ?? []).filter(item => item.target_host === target).map(item => item.host);
  return eligible([wwwCounterpart(target), ...recorded], hosts, exclude);
}

function eligible(candidates: Array<string | null>, hosts: PublicationHosts, exclude: string[]): string[] {
  const skip = new Set([hosts.website_host, hosts.media_host, ...(hosts.redirect_hosts ?? []), ...exclude].filter(Boolean));
  return [...new Set(candidates)].filter((host): host is string => !!host && !skip.has(host)).sort();
}

/**
 * Whether a publication that changes no content should still finish (without a rebuild) to check the
 * implicit redirect: never checked yet, not verified, or a rule to release after an opt-out.
 */
export function implicitRedirectsPending(config: Pick<DomainConfiguration, 'www_redirect' | 'implicit_redirects'>, hosts: PublicationHosts, exclude: string[] = []): boolean {
  const target = hosts.website_host;
  if (!target) return false;
  if (!wwwRedirectEnabled(config)) return (config.implicit_redirects ?? []).some(item => item.managed_rule);
  if (config.implicit_redirects == null) return true;
  return implicitRedirectHosts(config, hosts, exclude).some(host => !config.implicit_redirects!.some(item => item.host === host && item.target_host === target && item.status === 'verified'));
}

/** Previous website addresses get their own redirect and noindex handling; they are never implicit. */
function previousHostsOf(config: DomainConfiguration, target: string) {
  try { return previousWebsiteHosts(config, target); } catch { return []; }
}

/**
 * Read projection for the UI, API and MCP: `www_redirect`, `implicit_redirect_hosts` beside each
 * `redirect_hosts` in `desired` and `active` (omitted when empty), and `implicit_redirects` with the recorded status.
 * Responses only: clients that send `desired` back never store implicit hosts as explicit ones.
 */
export function withImplicitRedirects<T extends DomainConfiguration>(config: T) {
  const enabled = wwwRedirectEnabled(config);
  // Omitted when empty, like redirect_hosts, so existing responses keep their shape.
  const project = (hosts: PublicationHosts | null) => {
    if (!hosts) return hosts;
    const implicit = hosts.website_host ? implicitRedirectHosts(config, hosts, previousHostsOf(config, hosts.website_host)) : [];
    return implicit.length ? { ...hosts, implicit_redirect_hosts: implicit } : hosts;
  };
  // Status belongs to the host that serves traffic now; before go-live, to the saved future host.
  const live = config.active?.website_host ? config.active : null;
  const hosts = live ?? config.desired;
  const target = hosts.website_host;
  const recorded = config.implicit_redirects ?? [];
  const derived = target ? implicitRedirectHosts(config, hosts, previousHostsOf(config, target)) : [];
  const implicit_redirects: ImplicitRedirect[] = derived.map(host => recorded.find(item => item.host === host && item.target_host === target) ?? {
    host, target_host: target!, source: 'default', status: 'planned', issue: null, next_action: null,
    message: live
      ? `Typeroll makes https://${host} answer 301 to https://${target} on the next publication of the site, or now with repair_previous_host_redirects.${config.dns_mode === 'external' ? ' With external DNS, create the redirect at your DNS provider; Typeroll verifies it.' : ''}`
      : `After the site is live at ${target}, its next publication makes https://${host} answer 301 to it.`,
  });
  // After an opt-out, a rule Typeroll could not release yet stays visible until it is removed.
  const releasing = enabled ? [] : recorded.filter(item => item.managed_rule && item.issue?.code === 'www_redirect_release_failed');
  return { ...config, www_redirect: enabled, desired: project(config.desired)!, active: project(config.active),
    implicit_redirects: [...implicit_redirects, ...releasing] };
}

export interface ImplicitCheckItem { code: ImplicitRedirectIssueCode; severity: 'warning'; host: string; message: string; remedy?: string }

/** Recorded problems as host_checks warnings. They never block preparing or switching a domain. */
export function implicitRedirectCheckItems(config: DomainConfiguration): ImplicitCheckItem[] {
  return withImplicitRedirects(config).implicit_redirects.flatMap(item => item.issue
    ? [{ code: item.issue.code, severity: 'warning' as const, host: item.host, message: item.issue.message, remedy: item.issue.remedy }] : []);
}

/** Host checks with the recorded warnings of the implicit www redirect. Warnings only: they never block a domain change. */
export function withImplicitRedirectChecks(checks: HostChecks, config: DomainConfiguration): HostChecks {
  const items = implicitRedirectCheckItems(config);
  return items.length ? { ...checks, warnings: [...checks.warnings, ...items] } : checks;
}

export interface ImplicitRedirectContext {
  org: string; site: string; group: string;
  publicationId: string;
  /** The live website host the counterpart redirects to. */
  target: string;
  dnsMode: 'automatic' | 'external';
  /** The site's Cloudflare Pages project: a counterpart proxied to it serves this same site. */
  project: string;
  /** Saved settings: opt-out and the last recorded result. */
  config: Pick<DomainConfiguration, 'www_redirect' | 'implicit_redirects'>;
  /** The published hosts: explicit redirect hosts and the media host are never implicit. */
  hosts: PublicationHosts;
  /** Previous website addresses, handled by their own redirect. */
  exclude: string[];
  /** Where rule writes are journaled before they are submitted. */
  jobPath: string;
  fetchImpl?: typeof fetch;
}

const now = () => new Date().toISOString();
const repairable = new Set<ImplicitRedirectIssueCode>(['redirect_rule_quota', 'redirect_permission_missing', 'redirect_rule_rejected', 'www_redirect_unavailable', 'www_redirect_release_failed']);

function result(ctx: ImplicitRedirectContext, host: string, fields: Partial<ImplicitRedirect> & Pick<ImplicitRedirect, 'status' | 'message'>): ImplicitRedirect {
  return { host, target_host: ctx.target, source: 'default', issue: null, next_action: null, managed_rule: null, checked_at: now(), publication_id: ctx.publicationId, ...fields };
}

function warning(ctx: ImplicitRedirectContext, host: string, issue: ImplicitRedirectIssue, managed: ImplicitRedirect['managed_rule'] = null): ImplicitRedirect {
  return result(ctx, host, { status: 'warning', message: issue.message, issue, managed_rule: managed,
    next_action: repairable.has(issue.code) ? 'repair_previous_host_redirects' : null });
}

const answered = (observed: { status: number | null; location: string | null }) =>
  observed.status ? `HTTP ${observed.status}${observed.location ? ` (Location: ${observed.location})` : ''}` : 'no response';

const ruleInstructions = (host: string, target: string, zone: string) => {
  const spec = redirectRuleSpec(host, target, zone);
  return `a Single Redirect rule in Cloudflare → ${zone} → Rules → Redirect Rules with expression ${spec.expression}, dynamic URL ${spec.target_url_expression}, status 301 and preserve query string`;
};

/** What a counterpart's records say about who it serves. Only this site's Pages project and the redirect placeholder are ours. */
export function counterpartUse(records: Array<{ type: string; content: string; proxied?: boolean }>, project: string): 'missing' | 'same_site' | 'redirect_only' | 'other' {
  if (!records.length) return 'missing';
  if (!records.every(record => record.proxied === true)) return 'other';
  const value = (record: { content: string }) => String(record.content).toLowerCase().replace(/\.$/, '');
  if (records.every(record => record.type === 'CNAME' && value(record) === `${project.toLowerCase()}.pages.dev`)) return 'same_site';
  if (records.every(record => (record.type === 'A' && value(record) === REDIRECT_PLACEHOLDER_ADDRESS) || (record.type === 'AAAA' && value(record) === '100::'))) return 'redirect_only';
  return 'other';
}

/** Another (non-Typeroll) enabled rule that sends the host somewhere else. Typeroll never overrides it. */
function foreignRedirect(ruleset: any, host: string, target: string) {
  const rules: any[] = Array.isArray(ruleset?.rules) ? ruleset.rules : [];
  return rules.find(rule => rule?.enabled !== false && rule?.action === 'redirect' && !String(rule?.ref ?? '').startsWith('typeroll_previous_') &&
    previousRuleHosts(rule.expression)?.includes(host) && !redirectsTo(rule, target)) ?? null;
}

async function checkCounterpart(ctx: ImplicitRedirectContext, host: string, previous: ImplicitRedirect | undefined): Promise<ImplicitRedirect> {
  const target = ctx.target, check = ctx.publicationId.slice(0, 16);
  const managed = previous?.managed_rule ?? null;
  const verified = () => result(ctx, host, { status: 'verified', managed_rule: managed, message: `https://${host} answers 301 to https://${target} with the same path and query.` });
  // One public check per publication. An existing redirect of any kind is accepted as it is.
  const observed = await verifyRedirectHost(host, target, check, ctx.fetchImpl);
  if (observed.ok) return verified();
  if (ctx.dnsMode === 'external') {
    return warning(ctx, host, { code: 'www_redirect_external_dns',
      message: `https://${host} does not redirect to https://${target} yet; it answered ${answered(observed)}. With external DNS, Typeroll does not change ${host}.`,
      remedy: `At your DNS provider, make https://${host} answer 301 to https://${target} with the same path and query. In Cloudflare: a proxied record for ${host} (for example A ${REDIRECT_PLACEHOLDER_ADDRESS}) and ${ruleInstructions(host, target, 'the zone')}. If ${host} is used for something else, save www_redirect: false. Typeroll verifies the 301 on the next publication.` }, managed);
  }
  let access: Awaited<ReturnType<typeof hostingDns>>;
  try { access = await hostingDns(ctx.org, ctx.group, host); }
  catch (error) {
    if (!(error instanceof ConnectionError) || error.code !== 'domain_zone_required') throw error;
    return warning(ctx, host, { code: 'www_redirect_zone_unavailable', message: `${host} is not in an active Cloudflare zone that Typeroll can manage, so it cannot redirect to ${target}. ${error.message}`,
      remedy: `Connect DNS access to the zone of ${host}, or make https://${host} answer 301 to https://${target} at your DNS provider. Then publish again or run repair_previous_host_redirects.` }, managed);
  }
  const zone: ZoneSummary | null = await findZone(access.provider, access.accountId, host);
  const pair = (name: string, zoneName: string) => name === zoneName || name === `www.${zoneName}`;
  if (!zone || zone.status !== 'active' || !pair(host, zone.name) || !pair(target, zone.name)) {
    return warning(ctx, host, { code: 'www_redirect_zone_unavailable', message: `${host} and ${target} are not the apex and www host of one active Cloudflare zone that Typeroll can manage, so ${host} does not redirect automatically.`,
      remedy: `Make https://${host} answer 301 to https://${target} at your DNS provider, or save www_redirect: false if ${host} is used for something else.` }, managed);
  }
  const records = (await access.provider(`/zones/${zone.id}/dns_records?name=${encodeURIComponent(host)}&per_page=100`)).filter((record: any) => ['A', 'AAAA', 'CNAME'].includes(record.type));
  const inUse = (detail: string): ImplicitRedirectIssue => ({ code: 'www_redirect_host_in_use',
    message: `${host} serves something other than this site (${detail}), so Typeroll does not redirect it to ${target}. It answered ${answered(observed)}.`,
    remedy: `If ${host} should redirect to ${target}, add it to the site's redirect hosts: Typeroll prepares its record and rule and switches it with your approval. If it is used for something else, save www_redirect: false to stop this warning.` });
  try { await assertTrafficNotOwnedByOtherOrganization(ctx.org, access.accountId, records); }
  catch (error) { if (error instanceof ConnectionError) return warning(ctx, host, inUse('it belongs to another organization'), managed); throw error; }
  const use = counterpartUse(records, ctx.project);
  if (use === 'missing') {
    return warning(ctx, host, { code: 'www_redirect_record_missing', message: `${host} has no DNS record in ${zone.name}, so visitors who type it reach nothing. Typeroll does not create DNS records on its own.`,
      remedy: `Add ${host} to the site's redirect hosts (Typeroll creates the record and rule after your approval), or create a proxied record in Cloudflare → ${zone.name} → DNS: type A, name ${host}, content ${REDIRECT_PLACEHOLDER_ADDRESS}, proxied. Then publish again or run repair_previous_host_redirects; Typeroll adds the 301 rule.` }, managed);
  }
  if (use === 'other') {
    const detail = records.map((record: any) => `${record.type} ${record.content}${record.proxied ? ', proxied' : ', DNS only'}`).join('; ');
    return warning(ctx, host, inUse(detail), managed);
  }
  const state = await readPreviousRedirect(access.provider, zone.id, host, target);
  const unredirected = `Until it exists, ${host} serves the site directly instead of redirecting to ${target}.`;
  if (state.status === 'unverifiable') {
    const issue = await permissionIssue(ctx.org, ctx.group, host, zone.name);
    return warning(ctx, host, { ...issue, message: `The connected Cloudflare authorization cannot read or create redirect rules in ${zone.name}. ${unredirected}` }, managed);
  }
  const foreign = foreignRedirect(state.ruleset, host, target);
  if (state.status === 'conflict' || foreign) {
    return warning(ctx, host, { code: 'redirect_rule_conflict', message: `${foreign ? `The redirect rule ${foreign.ref ?? foreign.description ?? foreign.id}` : 'A Typeroll redirect rule'} in ${zone.name} already sends ${host} somewhere else. Typeroll does not override it.`,
      remedy: `${conflictIssue(host, zone.name).remedy} Or save www_redirect: false if ${host} should keep its current target.` }, managed);
  }
  let rule = managed;
  if (state.status === 'required') {
    const limit = quotaExceeded(state, zone.plan);
    if (limit) {
      return warning(ctx, host, { code: 'redirect_rule_quota', remedy: quotaRemedy(host, target, zone.name),
        message: `${zone.name} has ${state.rule_count} of ${limit} Single Redirect rules (Cloudflare ${zone.plan} plan), and the 301 from ${host} to ${target} needs a new one. ${unredirected}` }, managed);
    }
    try {
      const writer = retirementRuleProvider(access.provider, ctx.jobPath, ctx.publicationId, { zone_id: zone.id, hostname: host, target_host: target, dns_fingerprint: trafficFingerprint(records) });
      await ensurePreviousHostRule(writer, zone.id, host, target);
      rule = { zone_id: zone.id, zone_name: zone.name };
    } catch (error) {
      const issue = await previousRedirectIssue(error, { org: ctx.org, group: ctx.group, host, target, zone: zone.name });
      if (!issue) throw error;
      return warning(ctx, host, { ...issue, message: issue.code === 'redirect_permission_missing' ? `The connected Cloudflare authorization cannot create redirect rules in ${zone.name}. ${unredirected}`
        : `Cloudflare refused the redirect rule from ${host} to ${target} in ${zone.name}. A full Single Redirect rule quota is the usual cause. ${unredirected}` }, managed);
    }
  }
  const after = await verifyRedirectHost(host, target, check, ctx.fetchImpl);
  if (after.ok) return result(ctx, host, { status: 'verified', managed_rule: rule, message: `https://${host} answers 301 to https://${target} with the same path and query.` });
  return result(ctx, host, { status: 'pending', managed_rule: rule, next_action: 'repair_previous_host_redirects',
    message: `The redirect rule for ${host} is in ${zone.name} (${previousRuleRef(target)}), but https://${host} answered ${answered(after)} instead of 301. Cloudflare usually applies a rule within a minute; the next publication or repair_previous_host_redirects checks again.` });
}

/** After an opt-out, remove the host from the Typeroll rule it was added to. Never touches DNS or other rules. */
async function releaseCounterpart(ctx: ImplicitRedirectContext, item: ImplicitRedirect): Promise<ImplicitRedirect | null> {
  const zone = item.managed_rule!;
  const failed = (message: string) => ({ ...item, status: 'warning' as const, checked_at: now(), message, next_action: 'repair_previous_host_redirects' as const,
    issue: { code: 'www_redirect_release_failed' as const, message, remedy: `Remove ${item.host} from the rule ${previousRuleRef(item.target_host)} in Cloudflare → ${zone.zone_name} → Rules → Redirect Rules, or run repair_previous_host_redirects again.` } });
  if (ctx.exclude.includes(item.host)) return null;
  if (ctx.dnsMode === 'external') return failed(`www_redirect is off, but ${item.host} is still listed in Typeroll's redirect rule in ${zone.zone_name}, and Typeroll does not change rules with external DNS.`);
  try {
    const access = await hostingDns(ctx.org, ctx.group, item.host);
    const provider = access.provider;
    const ruleset = await provider(`/zones/${zone.zone_id}/rulesets/phases/${REDIRECT_PHASE}/entrypoint`, { missing: true });
    const rule = (Array.isArray(ruleset?.rules) ? ruleset.rules : []).find((candidate: any) => isPreviousRuleFor(candidate, item.host, item.target_host));
    if (!rule) return null;
    const hosts = previousRuleHosts(rule.expression)!.filter(host => host !== item.host);
    const route = `/zones/${zone.zone_id}/rulesets/${ruleset.id}/rules/${rule.id}`;
    const operation = hosts.length ? { method: 'PATCH', body: previousRuleBody(rule.ref, hosts, item.target_host) } : { method: 'DELETE' };
    const key = `${ctx.jobPath}/www_redirect_writes/${createHash('sha256').update(JSON.stringify({ route, operation })).digest('hex').slice(0, 16)}`;
    const intent = { publication_id: ctx.publicationId, hostname: item.host, target_host: item.target_host, zone_id: zone.zone_id, route, ...operation, state: 'prepared' };
    await getStore().createDocIfMissing(key, intent);
    await provider(route, operation);
    await getStore().updateDoc(key, { ...intent, state: 'submitted' });
    return null;
  } catch (error) {
    console.warn(JSON.stringify({ event: 'www_redirect_release_failed', org_id: ctx.org, site_id: ctx.site, host: item.host, code: error instanceof ConnectionError ? error.code : 'provider_error' }));
    return failed(`www_redirect is off, but Typeroll could not remove ${item.host} from its redirect rule in ${zone.zone_name} yet.`);
  }
}

/**
 * Check, and with automatic DNS create, the implicit www redirect of a live website host. Returns the
 * entries to record as `implicit_redirects`. Never throws: every problem becomes a warning entry.
 */
export async function maintainImplicitRedirects(ctx: ImplicitRedirectContext): Promise<ImplicitRedirect[]> {
  const recorded = ctx.config.implicit_redirects ?? [];
  try {
    if (!wwwRedirectEnabled(ctx.config)) {
      const kept: ImplicitRedirect[] = [];
      for (const item of recorded.filter(entry => entry.managed_rule)) { const left = await releaseCounterpart(ctx, item); if (left) kept.push(left); }
      return kept;
    }
    const hosts = { ...ctx.hosts, website_host: ctx.target };
    let candidates = implicitRedirectHosts({ www_redirect: true, implicit_redirects: [] }, hosts, ctx.exclude);
    if (!candidates.length && ctx.dnsMode === 'automatic' && counterpartNeedsZone(ctx.target)) {
      // example.co.uk and www.example.co.uk: only the zone tells an apex from a subdomain.
      try {
        const access = await hostingDns(ctx.org, ctx.group, ctx.target);
        const zone = await findZone(access.provider, access.accountId, ctx.target);
        candidates = eligible([wwwCounterpart(ctx.target, zone?.name)], hosts, ctx.exclude);
      } catch { candidates = []; }
    }
    const entries: ImplicitRedirect[] = [];
    for (const host of candidates) {
      const previous = recorded.find(item => item.host === host && item.target_host === ctx.target);
      try { entries.push(await checkCounterpart(ctx, host, previous)); }
      catch (error) {
        console.warn(JSON.stringify({ event: 'www_redirect_check_failed', org_id: ctx.org, site_id: ctx.site, host, code: error instanceof ConnectionError ? error.code : 'provider_error' }));
        entries.push(warning(ctx, host, { code: 'www_redirect_unavailable', message: `Typeroll could not check or create the redirect from ${host} to ${ctx.target}: ${error instanceof Error ? error.message : 'the provider did not answer'}.`,
          remedy: 'Publish again or run repair_previous_host_redirects; both are safe to repeat.' }, previous?.managed_rule ?? null));
      }
    }
    return entries;
  } catch (error) {
    console.warn(JSON.stringify({ event: 'www_redirect_check_failed', org_id: ctx.org, site_id: ctx.site, code: error instanceof ConnectionError ? error.code : 'unexpected' }));
    return recorded;
  }
}
