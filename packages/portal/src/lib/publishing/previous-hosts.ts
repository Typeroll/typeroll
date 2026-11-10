import { createHash } from 'node:crypto';
import { paths } from '@typeroll/shared';
import { ConnectionError } from './connections';
import { ProviderError } from './providers.mjs';
import { hostingDns } from './hosting-dns';
import { cloudflareClient } from './cloudflare-oauth';
import { findZone, trafficFingerprint } from './domain-provider';
import { assertTrafficNotOwnedByOtherOrganization } from './cloudflare-account-claims';
import { redirectRuleSpec, verifyRedirectHost, redirectAccessStep, REDIRECT_PHASE, type RedirectPreparation, type RedirectRuleSpec } from './redirect-hosts';
import { journaledDomainProvider, recordDomainCutover } from './domain-cutover-journal';
import { publicationHostname, getSiteDomains, siteDomainConfigPath, type DomainConfiguration } from './domain-config';
import { createSafeFetch } from '../net/safe-fetch';
import { getStore } from '../datastore';

// A previous website address (the temporary sites.<domain> host, an older apex) answers 301 to the
// new website host through a Single Redirect rule in the previous host's zone. Several sites usually
// share one hosting zone, and a zone's redirect entrypoint has a plan quota (Free: 10 rules), so the
// rules are keyed by target: one Typeroll rule per new website host lists every previous host of that
// site (`http.host in {...}`). Older releases wrote one `typeroll_previous_<hash(host)>` rule per host;
// such a rule keeps working, is extended in place, and is merged into one rule when its site has more.
//
// Bulk Redirects would cost no zone rule per site, but they need account-level permissions (Account
// Filter Lists and Bulk URL Redirects) that Typeroll does not request. A redirect that does not fit
// is reported (redirect_rule_quota, redirect_permission_missing) before approval and after go-live;
// the old address stays protected by noindex and repair_previous_host_redirects retries it.

type Provider = (route: string, options?: { method?: string; body?: unknown; missing?: boolean }) => Promise<any>;
export type PreviousHostIssueCode = 'redirect_rule_quota' | 'redirect_permission_missing' | 'redirect_rule_conflict' | 'redirect_rule_rejected' | 'previous_host_redirect_unavailable';
/** Why a previous address has no 301 yet, and what makes it possible. */
export interface PreviousHostIssue { code: PreviousHostIssueCode; message: string; remedy: string }
export type PreviousHost = { host: string; target_host: string; mode: 'redirect' | 'noindex'; status: 'pending' | 'verified' | 'warning'; message: string; checked_at?: string;
  issue?: PreviousHostIssue | null; next_action?: 'repair_previous_host_redirects' | null };
export type PreviousHostPreparation = { host: string; target_host: string; redirect: RedirectPreparation | null; message: string; issue?: PreviousHostIssue | null };
const fetchPrevious = createSafeFetch({ label: 'Previous website address', maxRedirects: 0, timeoutMs: 10_000, maxBytes: 64 * 1024 });

const PREVIOUS_RULE_PREFIX = 'typeroll_previous_';
const hash16 = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);
/** Cloudflare's Single Redirect rules per zone entrypoint, by plan. */
export const SINGLE_REDIRECT_RULE_LIMITS: Record<string, number> = { free: 10, pro: 25, business: 50, enterprise: 300 };
/** The one rule for every previous host that moves to `target`. */
export const previousRuleRef = (target: string) => `${PREVIOUS_RULE_PREFIX}t_${hash16(target)}`;
/** The per-host rule ref written before rules were keyed by target. */
export const legacyPreviousRuleRef = (host: string) => `${PREVIOUS_RULE_PREFIX}${hash16(host)}`;
export const previousRuleExpression = (hosts: string[]) => `http.host in {${[...new Set(hosts)].sort().map(host => `"${host}"`).join(' ')}}`;
const targetExpression = (target: string) => redirectRuleSpec(target, target, null).target_url_expression;
const normalize = (expression: unknown) => typeof expression === 'string' ? expression.replace(/\s+/g, ' ').trim().replace(/^\((.*)\)$/, '$1').trim() : '';

/** Hosts matched by a Typeroll previous-host expression, or null for any other expression. */
export function previousRuleHosts(expression: unknown): string[] | null {
  const text = normalize(expression);
  const single = /^http\.host eq "([^"\s]+)"$/.exec(text);
  if (single) return [single[1]];
  const set = /^http\.host in \{((?: ?"[^"\s]+")+) ?\}$/.exec(text);
  return set ? [...set[1].matchAll(/"([^"]+)"/g)].map(match => match[1]) : null;
}

/** An enabled 301 to `target` that keeps the path and query string. */
export function redirectsTo(rule: any, target: string) {
  const value = rule?.action_parameters?.from_value;
  return rule?.action === 'redirect' && rule.enabled !== false && normalize(value?.target_url?.expression) === normalize(targetExpression(target)) &&
    value?.status_code === 301 && value?.preserve_query_string === true;
}

/** A write body that only redirects listed previous hosts to `target`. */
export function isPreviousRuleFor(rule: any, host: string, target: string) {
  return typeof rule?.ref === 'string' && rule.ref.startsWith(PREVIOUS_RULE_PREFIX) && redirectsTo(rule, target) && !!previousRuleHosts(rule.expression)?.includes(host);
}

export function previousRuleBody(ref: string, hosts: string[], target: string) {
  return { ref, description: 'Typeroll previous website address', expression: previousRuleExpression(hosts), action: 'redirect', enabled: true,
    action_parameters: { from_value: { target_url: { expression: targetExpression(target) }, status_code: 301, preserve_query_string: true } } };
}

const denied = (error: unknown) => error instanceof ProviderError && (error.status === 401 || error.status === 403);

export interface PreviousRedirectState {
  /** configured: an enabled rule already sends the host to the target. unverifiable: the rules cannot be read. */
  status: 'configured' | 'required' | 'conflict' | 'unverifiable';
  ruleset: any | null;
  /** The Typeroll rule for this target that is extended; null when a new rule is needed. */
  primary: any | null;
  /** Other Typeroll rules for the same target (per-host rules from older releases). */
  merge: any[];
  /** Every previous host the target's rule must list. */
  hosts: string[];
  rule_count: number;
}

/** Read the zone's redirect rules for one previous host. Never writes. */
export async function readPreviousRedirect(provider: Provider, zoneId: string, host: string, target: string): Promise<PreviousRedirectState> {
  let ruleset: any;
  try { ruleset = await provider(`/zones/${zoneId}/rulesets/phases/${REDIRECT_PHASE}/entrypoint`, { missing: true }); }
  catch (error) { if (denied(error)) return { status: 'unverifiable', ruleset: null, primary: null, merge: [], hosts: [host], rule_count: 0 }; throw error; }
  const rules: any[] = Array.isArray(ruleset?.rules) ? ruleset.rules : [];
  const own = rules.filter(rule => typeof rule?.ref === 'string' && rule.ref.startsWith(PREVIOUS_RULE_PREFIX));
  const forTarget = own.filter(rule => redirectsTo(rule, target) && previousRuleHosts(rule.expression));
  const primary = forTarget.find(rule => rule.ref === previousRuleRef(target)) ?? forTarget[0] ?? null;
  const hosts = [...new Set([...forTarget.flatMap(rule => previousRuleHosts(rule.expression)!), host])].sort();
  const base = { ruleset, primary, merge: forTarget.filter(rule => rule !== primary), hosts, rule_count: rules.length };
  // Another Typeroll rule (a different target, disabled or edited) answering for this host would win or confuse; never override it.
  const conflicting = own.some(rule => !forTarget.includes(rule) && (rule.ref === legacyPreviousRuleRef(host) || rule.ref === previousRuleRef(target) || previousRuleHosts(rule.expression)?.includes(host)));
  if (conflicting) return { ...base, status: 'conflict' };
  const handMade = rules.some(rule => !own.includes(rule) && redirectsTo(rule, target) && normalize(rule.expression) === `http.host eq "${host}"`);
  const covered = handMade || forTarget.some(rule => previousRuleHosts(rule.expression)!.includes(host));
  return { ...base, status: covered ? 'configured' : 'required' };
}

/** Whether adding this host needs a new rule in a zone that has no room for it. */
export function quotaExceeded(state: PreviousRedirectState, plan?: string) {
  const limit = plan ? SINGLE_REDIRECT_RULE_LIMITS[plan] : undefined;
  return state.status === 'required' && !state.primary && !!limit && state.rule_count >= limit ? limit : null;
}

function quotaIssue(host: string, target: string, zone: string, count: number, limit: number | null, plan?: string): PreviousHostIssue {
  return { code: 'redirect_rule_quota',
    message: `${zone} has ${count}${limit ? ` of ${limit}` : ''} Single Redirect rules${plan ? ` (Cloudflare ${plan} plan)` : ''}, and the 301 from ${host} to ${target} needs a new one. Until it exists, ${host} answers with noindex instead of a redirect.`,
    remedy: quotaRemedy(host, target, zone) };
}

export const quotaRemedy = (host: string, target: string, zone: string) =>
  `Free a rule in Cloudflare → ${zone} → Rules → Redirect Rules, or upgrade the plan of ${zone}, then run repair_previous_host_redirects. Alternatively create a Bulk Redirect in Cloudflare → Bulk Redirects: source URL ${host}/, target URL https://${target}/, status 301 with preserve query string, subpath matching and preserve path suffix; Typeroll verifies the public 301.`;

export async function permissionIssue(org: string, group: string, host: string, zone: string | null): Promise<PreviousHostIssue> {
  const step = await redirectAccessStep(org, group);
  return { code: 'redirect_permission_missing',
    message: `The connected Cloudflare authorization cannot read or create redirect rules${zone ? ` in ${zone}` : ''}, so ${host} answers with noindex instead of a 301.`,
    remedy: `${step ?? 'Give the connection Zone → Single Redirect → Edit (OAuth scopes dynamic-redirect.read and dynamic-redirect.write).'} Then run repair_previous_host_redirects.` };
}

export const conflictIssue = (host: string, zone: string): PreviousHostIssue => ({ code: 'redirect_rule_conflict',
  message: `A Typeroll redirect rule in ${zone} already answers for ${host} with a different target or is disabled. Typeroll does not override it.`,
  remedy: `Review the rules named typeroll_previous_* in Cloudflare → ${zone} → Rules → Redirect Rules, delete the outdated one, then run repair_previous_host_redirects.` });

const unavailableIssue = (message: string): PreviousHostIssue => ({ code: 'previous_host_redirect_unavailable', message, remedy: `${message} Then run repair_previous_host_redirects.` });

/** Only recorded website origins, never arbitrary media hosts or provider deployment URLs. */
export function previousWebsiteHosts(config: DomainConfiguration, target: string, priorHost?: string): string[] {
  return [...new Set([priorHost, config.active?.website_host, ...config.media_aliases.map(alias => alias.website_host), ...(config.previous_hosts ?? []).map(item => item.host)])]
    .filter((host): host is string => !!host && host !== target && !host.endsWith('.pages.dev'))
    .map(host => publicationHostname(host)).sort();
}

/** Read-only preparation. Existing Pages certificates cover deep temporary subdomains too. */
export async function preparePreviousHosts(org: string, group: string, hosts: string[], target: string, pages: Provider, account: string, project: string): Promise<PreviousHostPreparation[]> {
  const result: PreviousHostPreparation[] = [];
  for (const host of hosts) {
    const fallback = (message: string, issue: PreviousHostIssue = unavailableIssue(message)) => result.push({ host, target_host: target, redirect: null, message, issue });
    let zoneName: string | null = null;
    try {
      const domain = await pages(`/accounts/${account}/pages/projects/${project}/domains/${encodeURIComponent(host)}`, { missing: true });
      if (domain?.status !== 'active') { fallback('The previous address has no active Pages certificate. Its publication must serve a verified noindex header.'); continue; }
      const access = await hostingDns(org, group, host);
      const zone = await findZone(access.provider, access.accountId, host);
      if (!zone || zone.status !== 'active') { fallback('Connect DNS access to the previous address to enable its automatic redirect.'); continue; }
      zoneName = zone.name;
      const records = (await access.provider(`/zones/${zone.id}/dns_records?name=${encodeURIComponent(host)}&per_page=100`)).filter((record: any) => ['A', 'AAAA', 'CNAME'].includes(record.type));
      await assertTrafficNotOwnedByOtherOrganization(org, access.accountId, records);
      if (!records.length || records.some((record: any) => !record.proxied || record.type !== 'CNAME' || String(record.content).toLowerCase().replace(/\.$/, '') !== `${project}.pages.dev`)) { fallback('The previous address must keep its existing proxied Pages DNS record for the redirect.'); continue; }
      // Separate ownership from optional www aliases; these rules belong to retirement and rollback.
      const current = await readPreviousRedirect(access.provider, zone.id, host, target);
      if (current.status === 'unverifiable') { const issue = await permissionIssue(org, group, host, zone.name); fallback(issue.message, issue); continue; }
      if (current.status === 'conflict') { const issue = conflictIssue(host, zone.name); fallback(issue.message, issue); continue; }
      const limit = quotaExceeded(current, zone.plan);
      // A full zone is reported before approval. The write is still attempted at the switch, in case a rule was freed meanwhile.
      const issue = limit ? quotaIssue(host, target, zone.name, current.rule_count, limit, zone.plan) : null;
      const rule: RedirectRuleSpec & { hosts: string[] } = { ...redirectRuleSpec(host, target, zone.name), ref: current.primary?.ref ?? previousRuleRef(target),
        expression: previousRuleExpression(current.hosts), status: current.status, hosts: current.hosts };
      result.push({ host, target_host: target, message: issue?.message ?? '', issue, redirect: {
        hostname: host, target_host: target, zone_id: zone.id, zone_name: zone.name,
        provider_status: 'redirect', certificate_ready: true, edge_certificate: 'active', requirements: [],
        has_existing_traffic: true, previous_records: records, dns_fingerprint: trafficFingerprint(records),
        action: 'approve_cutover', validation_blocker: null, rule,
      } });
    } catch (error) {
      if (denied(error)) { const issue = await permissionIssue(org, group, host, zoneName); fallback(issue.message, issue); }
      else if (error instanceof ConnectionError && error.code === 'domain_zone_required') fallback('The connected account cannot manage the previous address. A verified noindex header protects it; connect DNS access to the zone to finish.');
      else throw error;
    }
  }
  return result;
}

/**
 * Make one previous host redirect to `target` without ever leaving a listed host unredirected: extend
 * the target's rule (or create it), read it back, and only then delete merged older rules (`consolidate`).
 */
export async function ensurePreviousHostRule(provider: Provider, zoneId: string, host: string, target: string, options: { consolidate?: boolean } = {}): Promise<PreviousRedirectState> {
  const state = await readPreviousRedirect(provider, zoneId, host, target);
  if (state.status === 'unverifiable') throw new ProviderError('Cloudflare', 403, []);
  if (state.status === 'conflict') throw new ConnectionError(`A Typeroll redirect rule already answers for ${host} with a different target.`, 409, 'redirect_rule_conflict');
  if (state.status === 'configured' && (!options.consolidate || !state.merge.length)) return state;
  const ref = state.primary?.ref ?? previousRuleRef(target);
  const body = previousRuleBody(ref, state.hosts, target);
  if (state.primary) await provider(`/zones/${zoneId}/rulesets/${state.ruleset.id}/rules/${state.primary.id}`, { method: 'PATCH', body });
  else if (state.ruleset?.id) await provider(`/zones/${zoneId}/rulesets/${state.ruleset.id}/rules`, { method: 'POST', body });
  else await provider(`/zones/${zoneId}/rulesets`, { method: 'POST', body: { name: 'Typeroll redirects', kind: 'zone', phase: REDIRECT_PHASE, rules: [body] } });
  const after = await provider(`/zones/${zoneId}/rulesets/phases/${REDIRECT_PHASE}/entrypoint`, { missing: true });
  const saved = (Array.isArray(after?.rules) ? after.rules : []).find((rule: any) => rule.ref === ref);
  if (!saved || !redirectsTo(saved, target) || !state.hosts.every(item => previousRuleHosts(saved.expression)?.includes(item))) {
    throw new ConnectionError(`The redirect rule for ${target} could not be confirmed after writing it. Retry; older rules were kept.`, 409, 'previous_host_redirect_unconfirmed');
  }
  if (options.consolidate) {
    for (const rule of state.merge) await provider(`/zones/${zoneId}/rulesets/${after.id}/rules/${rule.id}`, { method: 'DELETE' });
  }
  return { ...state, status: 'configured', primary: saved, merge: options.consolidate ? [] : state.merge };
}

/** A specific, user-facing reason for a failed redirect write; null when the error must be retried by the job instead. */
export async function previousRedirectIssue(error: unknown, context: { org: string; group: string; host: string; target: string; zone: string | null; prepared?: PreviousHostIssue | null }): Promise<PreviousHostIssue | null> {
  const zone = context.zone ?? 'the zone';
  if (denied(error)) return permissionIssue(context.org, context.group, context.host, context.zone);
  if (error instanceof ConnectionError && error.code === 'redirect_rule_conflict') return conflictIssue(context.host, zone);
  // A deterministic refusal (Cloudflare answers 400 when the entrypoint is full). Rate limits and 5xx are retried.
  if (!(error instanceof ProviderError) || ![400, 409].includes(error.status)) return null;
  if (context.prepared?.code === 'redirect_rule_quota') return context.prepared;
  return { code: 'redirect_rule_rejected',
    message: `Cloudflare refused the redirect rule from ${context.host} to ${context.target} in ${zone} (HTTP ${error.status}${error.codes.length ? `, code ${error.codes.join(', ')}` : ''}). A full Single Redirect rule quota is the usual cause. Until it exists, ${context.host} answers with noindex instead of a redirect.`,
    remedy: quotaRemedy(context.host, context.target, zone) };
}

/** Never report retirement as safe based on configuration alone. Inspect the public response. */
export async function checkPreviousHost(host: string, target: string, publication: string, fetchImpl: typeof fetch = fetchPrevious): Promise<PreviousHost> {
  const redirect = await verifyRedirectHost(host, target, publication, fetchImpl);
  if (redirect.ok) return { host, target_host: target, mode: 'redirect', status: 'verified', message: '301 redirect preserves the path and query string.', checked_at: new Date().toISOString() };
  const response = await fetchImpl(`https://${host}/`, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  const robots = response.headers.get('x-robots-tag') ?? '';
  if (response.status === 200 && /\bnoindex\b/i.test(robots) && /\bnofollow\b/i.test(robots) && response.headers.get('x-typeroll-publication') === publication) {
    return { host, target_host: target, mode: 'noindex', status: 'warning', message: 'The old address is blocked from indexing. Its 301 redirect still needs attention to DNS, Single Redirect configuration or permissions.', checked_at: new Date().toISOString() };
  }
  throw new ConnectionError(`The previous address ${host} is neither redirected to ${target} nor protected by the current publication's noindex header. Check its DNS, redirect rules and cache.`, 409, 'previous_host_unprotected');
}

/** A noindex fallback with its reason. A recorded issue offers the repair action. */
function withIssue(checked: PreviousHost, issue: PreviousHostIssue | null | undefined, preparedMessage?: string): PreviousHost {
  if (checked.mode === 'redirect') return { ...checked, issue: null, next_action: null };
  return { ...checked, message: issue?.message || preparedMessage || checked.message, issue: issue ?? null, next_action: issue || checked.status === 'warning' ? 'repair_previous_host_redirects' : null };
}

/**
 * Apply only approved, journaled rules; never replace the old DNS or detach media-serving domains.
 * A refused redirect write never stops the switch: the old address keeps its verified noindex
 * fallback and the result records why, with repair_previous_host_redirects as the retry.
 */
export async function retirePreviousHosts(org: string, site: string, group: string, publication: string, hosts: string[], target: string,
  approved: PreviousHostPreparation[] = [], apply = false, fetchImpl?: typeof fetch,
  maintenanceJobPath?: string): Promise<PreviousHost[]> {
  const result: PreviousHost[] = [];
  for (const host of hosts) {
    const preparedHost = approved.find(item => item.host === host && item.target_host === target);
    const preparation = preparedHost?.redirect;
    let issue = preparedHost?.issue ?? null;
    if (apply && preparation?.zone_id) {
      const access = await hostingDns(org, group, host);
      const records = (await access.provider(`/zones/${preparation.zone_id}/dns_records?name=${encodeURIComponent(host)}&per_page=100`)).filter((record: any) => ['A', 'AAAA', 'CNAME'].includes(record.type));
      if (trafficFingerprint(records) !== preparation.dns_fingerprint) throw new ConnectionError('The previous address DNS changed after approval. Review it before enabling its redirect.', 409, 'dns_revision_conflict');
      const writer = maintenanceJobPath
        ? retirementRuleProvider(access.provider, maintenanceJobPath, publication, preparation)
        : journaledDomainProvider(access.provider, org, site, publication, host);
      try {
        // Merging older per-host rules deletes them, which a cutover rollback could not restore; only after go-live.
        await ensurePreviousHostRule(writer, preparation.zone_id, host, target, { consolidate: !!maintenanceJobPath });
        issue = null;
      } catch (error) {
        // Transport errors and uncertain writes resume through the existing job retry.
        const found = await previousRedirectIssue(error, { org, group, host, target, zone: preparation.zone_name ?? null, prepared: preparedHost?.issue });
        if (!found) throw error;
        issue = found;
        console.warn(JSON.stringify({ event: 'previous_host_redirect_failed', org_id: org, site_id: site, publication_id: publication, host, target_host: target, code: found.code }));
      }
      if (!maintenanceJobPath) await recordDomainCutover(org, site, publication, host);
    }
    result.push(withIssue(await checkPreviousHost(host, target, publication, fetchImpl), issue, preparedHost?.message));
  }
  return result;
}

/** Normal publishing and the repair action may finish retirement after an already approved switch.
 * Only rules that redirect this previous host to this publication's website host may be written, and
 * only older Typeroll rules for the same target may be deleted once the merged rule is confirmed.
 * DNS and other rules are never changed. Actual traffic switches use the full rollback journal above.
 */
export function retirementRuleProvider(provider: Provider, jobPath: string, publication: string, prepared: Pick<RedirectPreparation, 'zone_id' | 'hostname' | 'target_host' | 'dns_fingerprint'>): Provider {
  const base = `/zones/${prepared.zone_id}/rulesets`;
  return async (route, options) => {
    if (!options?.method) return provider(route, options);
    const body = options.body as any, rule = body?.rules?.length === 1 ? body.rules[0] : body;
    const write = (options.method === 'POST' && (route === base || new RegExp(`^${base}/[a-zA-Z0-9_-]+/rules$`).test(route))) ||
      (options.method === 'PATCH' && new RegExp(`^${base}/[a-zA-Z0-9_-]+/rules/[a-zA-Z0-9_-]+$`).test(route));
    let allowed = write && isPreviousRuleFor(rule, prepared.hostname, prepared.target_host);
    if (options.method === 'DELETE' && new RegExp(`^${base}/[a-zA-Z0-9_-]+/rules/[a-zA-Z0-9_-]+$`).test(route)) {
      const ruleset = await provider(`${base}/phases/${REDIRECT_PHASE}/entrypoint`, { missing: true });
      const existing = (Array.isArray(ruleset?.rules) ? ruleset.rules : []).find((item: any) => item.id === route.split('/').pop());
      allowed = !!existing && typeof existing.ref === 'string' && existing.ref.startsWith(PREVIOUS_RULE_PREFIX) && redirectsTo(existing, prepared.target_host);
    }
    if (!allowed) throw new ConnectionError('The previous address write is outside this publication.', 409, 'previous_host_write_mismatch');
    const operation = options.method === 'DELETE' ? { method: 'DELETE', route } : { method: options.method, rule };
    const key = `${jobPath}/previous_host_writes/${options.method === 'POST' ? rule.ref : `${rule?.ref ?? 'delete'}_${hash16(JSON.stringify(operation))}`}`;
    const intent = { publication_id: publication, hostname: prepared.hostname, target_host: prepared.target_host,
      zone_id: prepared.zone_id, dns_fingerprint: prepared.dns_fingerprint, ...operation, state: 'prepared' };
    const store = getStore();
    await store.createDocIfMissing(key, intent);
    const result = await provider(route, options);
    await store.updateDoc(key, { ...intent, state: 'submitted' });
    return result;
  };
}

/** Reads expose unprotected legacy aliases too; a saved alias is not evidence of protection. */
export function previousHostSummary(config: DomainConfiguration): PreviousHost[] {
  const target = config.published?.hosts.website_host ?? config.active?.website_host;
  if (!target) return [];
  return previousWebsiteHosts(config, target).map(host => config.previous_hosts?.find(item => item.host === host && item.target_host === target) ?? {
    host, target_host: target, mode: 'noindex', status: 'pending',
    message: 'Protection has not been verified. Publish with the updated build engine; an accessible previous Pages address is redirected after the current website passes verification.',
  });
}

/** Refresh observations for Publishing without starting builds or changing DNS/rules. A recorded issue stays until the 301 is seen. */
export async function readPreviousHosts(config: DomainConfiguration, fetchImpl?: typeof fetch): Promise<PreviousHost[]> {
  const hosts = previousHostSummary(config);
  if (!config.published?.publication_id) return hosts;
  return Promise.all(hosts.map(async host => {
    try { return withIssue(await checkPreviousHost(host.host, host.target_host, config.published!.publication_id, fetchImpl), host.issue); }
    catch (error) {
      return { ...host, status: 'pending' as const, checked_at: new Date().toISOString(),
        message: error instanceof Error ? error.message : 'The previous address could not be checked. Retry the status check.' };
    }
  }));
}

/**
 * Re-create missing previous-host redirects of a live site without a build or a DNS change. Idempotent:
 * an existing rule is reused, so a second run writes nothing. Hosts that still cannot redirect keep
 * their noindex fallback and report a specific issue. The implicit www redirect is checked and
 * created the same way (`implicit_redirects`); `repaired` and `remaining` list previous hosts only.
 */
export async function repairPreviousHostRedirects(org: string, site: string, fetchImpl?: typeof fetch) {
  const store = getStore();
  const config = await getSiteDomains(org, site);
  const targetDoc = await store.getDoc<any>(`${paths.site(org, site)}/publishing_targets/main`);
  const publication = targetDoc?.last_publication;
  if (config.state !== 'live' || !config.published?.publication_id || publication?.publication_id !== config.published.publication_id || !publication.website_host) {
    throw new ConnectionError('Previous addresses are repaired after the site is live at its new address. Check the domain guide.', 409, 'previous_host_repair_unavailable');
  }
  if (targetDoc.job_id || (targetDoc.lease_until ?? 0) > Date.now()) throw new ConnectionError('A publication is running. Repair the previous addresses after it finishes.', 409, 'publication_in_progress');
  if (config.dns_mode !== 'automatic') {
    throw new ConnectionError('With external DNS, create each previous address 301 at your DNS provider; check verifies it.', 409, 'previous_host_repair_external');
  }
  const target = publication.website_host as string, group = publication.hosting_group_id ?? 'default';
  const hosts = previousHostSummary(config).map(item => item.host)
    .filter(host => !(publication.redirect_hosts ?? []).includes(host) && host !== config.active?.media_host);
  const pages = await cloudflareClient(org, fetch, undefined, group);
  const preparations = await preparePreviousHosts(org, group, hosts, target, pages, publication.account_id, publication.project);
  const jobPath = `${paths.site(org, site)}/previous_host_repairs/${publication.publication_id}`;
  const previous_hosts: PreviousHost[] = [];
  for (const host of hosts) {
    try { previous_hosts.push(...await retirePreviousHosts(org, site, group, publication.publication_id, [host], target, preparations, true, fetchImpl, jobPath)); }
    catch (error) {
      if (!(error instanceof ConnectionError) || !['previous_host_unprotected', 'dns_revision_conflict'].includes(error.code ?? '')) throw error;
      previous_hosts.push({ host, target_host: target, mode: 'noindex', status: 'pending', message: error.message, checked_at: new Date().toISOString(),
        issue: preparations.find(item => item.host === host)?.issue ?? null, next_action: 'repair_previous_host_redirects' });
    }
  }
  // The www counterpart of the website host is repaired the same way: only its redirect rule, never DNS.
  const { maintainImplicitRedirects } = await import('./www-redirect');
  const implicit_redirects = config.active?.website_host === target ? await maintainImplicitRedirects({ org, site, group, publicationId: publication.publication_id, target,
    dnsMode: 'automatic', project: publication.project, config, hosts: { ...(config.published.hosts ?? config.desired), website_host: target }, jobPath, fetchImpl,
    exclude: [...new Set([...hosts, ...previousHostSummary(config).map(item => item.host)])] }) : config.implicit_redirects ?? [];
  const saved = await store.compareAndUpdateDoc<DomainConfiguration>(siteDomainConfigPath(org, site),
    current => current.revision === config.revision && current.published?.publication_id === config.published!.publication_id, { previous_hosts, implicit_redirects });
  if (!saved) throw new ConnectionError('Domain settings changed during the repair. Check again; repeating the repair is safe.', 409, 'domain_revision_conflict');
  return { action: 'repair_previous_host_redirects', previous_hosts, implicit_redirects,
    repaired: previous_hosts.filter(item => item.mode === 'redirect').map(item => item.host),
    remaining: previous_hosts.filter(item => item.mode !== 'redirect').map(item => ({ host: item.host, issue: item.issue ?? null, message: item.message })) };
}
