import { createHash } from 'node:crypto';
import { ConnectionError } from './connections';
import { ProviderError } from './providers.mjs';
import { findZone, inactiveZoneMessage, applyPreparedTraffic, trafficFingerprint, type DnsRequirement, type DomainPreparation, type ZoneSummary } from './domain-provider';
import { coveredByUniversalSsl } from './host-checks';
import { assertTrafficNotOwnedByOtherOrganization } from './cloudflare-account-claims';
import { hostingDns } from './hosting-dns';
import { assertPublicDestination, parsePublicHttpsUrl } from '../extensions/public-http';

// A redirect host never reaches Cloudflare Pages. Pages serves the same static
// files on every custom domain and its _redirects file cannot match a hostname,
// and customer sites must not use Functions. The zone's Single Redirect rule
// answers at Cloudflare's edge for a proxied record, with the zone's Universal
// SSL certificate. A rule has no effect while the record is DNS only.

type Provider = (route: string, options?: { method?: string; body?: unknown; missing?: boolean }) => Promise<any>;

/** Cloudflare's documented placeholder address for a proxied, redirect-only hostname. */
export const REDIRECT_PLACEHOLDER_ADDRESS = '192.0.2.1';
export const REDIRECT_PHASE = 'http_request_dynamic_redirect';

export interface RedirectRuleSpec {
  zone_name: string | null;
  phase: typeof REDIRECT_PHASE;
  ref: string;
  expression: string;
  target_url_expression: string;
  status_code: 301;
  preserve_query_string: true;
  /** configured: an equivalent enabled rule exists. unverifiable: the connection cannot read the zone's redirect rules. */
  status: 'configured' | 'required' | 'conflict' | 'unverifiable';
  /** Whether Typeroll can create the rule through the connection. False: the customer or their agent creates it. */
  managed: boolean;
}

export interface RedirectPreparation extends DomainPreparation {
  target_host: string;
  zone_name?: string;
  /** The zone's edge certificate. `expected`: unreadable, but the zone has been active longer than Cloudflare's 24 hour issuance window. */
  edge_certificate: 'active' | 'expected' | 'pending' | 'unknown';
  rule: RedirectRuleSpec;
  blocker?: { code: string; message: string } | null;
}

export function redirectRuleSpec(host: string, target: string, zoneName: string | null): RedirectRuleSpec {
  return { zone_name: zoneName, phase: REDIRECT_PHASE, ref: `typeroll_redirect_${createHash('sha256').update(host).digest('hex').slice(0, 16)}`,
    expression: `http.host eq "${host}"`, target_url_expression: `concat("https://${target}", http.request.uri.path)`,
    status_code: 301, preserve_query_string: true, status: 'required', managed: true };
}

function ruleBody(spec: RedirectRuleSpec) {
  return { ref: spec.ref, description: 'Typeroll website redirect', expression: spec.expression, action: 'redirect', enabled: true,
    action_parameters: { from_value: { target_url: { expression: spec.target_url_expression }, status_code: spec.status_code, preserve_query_string: spec.preserve_query_string } } };
}

const normalize = (expression: unknown) => typeof expression === 'string' ? expression.replace(/\s+/g, ' ').trim().replace(/^\((.*)\)$/, '$1').trim() : '';

/** A rule created by hand in the dashboard is accepted when it does exactly the same. */
function equivalent(rule: any, spec: RedirectRuleSpec) {
  const value = rule?.action_parameters?.from_value;
  return rule?.action === 'redirect' && rule.enabled !== false && normalize(rule.expression) === normalize(spec.expression) &&
    normalize(value?.target_url?.expression) === normalize(spec.target_url_expression) && value?.status_code === 301 && value?.preserve_query_string === true;
}

const denied = (error: unknown) => error instanceof ProviderError && (error.status === 401 || error.status === 403);

async function readRule(provider: Provider, zoneId: string, spec: RedirectRuleSpec) {
  let ruleset: any;
  try { ruleset = await provider(`/zones/${zoneId}/rulesets/phases/${REDIRECT_PHASE}/entrypoint`, { missing: true }); }
  catch (error) { if (denied(error)) return { status: 'unverifiable' as const, ruleset: null }; throw error; }
  const rules: any[] = Array.isArray(ruleset?.rules) ? ruleset.rules : [];
  const own = rules.find(rule => rule.ref === spec.ref);
  if (own) return { status: equivalent(own, spec) ? 'configured' as const : 'conflict' as const, ruleset };
  return { status: rules.some(rule => equivalent(rule, spec)) ? 'configured' as const : 'required' as const, ruleset };
}

export function manualRuleMessage(spec: RedirectRuleSpec, host: string, target: string) {
  return `Create a Single Redirect rule in Cloudflare → ${spec.zone_name ?? 'the domain'} → Rules → Redirect Rules: custom filter expression ${spec.expression}, dynamic URL ${spec.target_url_expression}, status 301, preserve query string. It sends https://${host}/path?query to https://${target}/path?query. The connected authorization cannot create redirect rules (Cloudflare permission Zone → Single Redirect → Edit).`;
}

/** Create the redirect rule unless an equivalent rule exists. Never edits or removes another rule. */
export async function ensureRedirectRule(provider: Provider, zoneId: string, spec: RedirectRuleSpec, host: string, target: string): Promise<RedirectRuleSpec> {
  const current = await readRule(provider, zoneId, spec);
  if (current.status === 'configured') return { ...spec, status: 'configured' };
  if (current.status === 'conflict') throw new ConnectionError(`The redirect rule ${spec.ref} in ${spec.zone_name ?? 'the zone'} differs from the saved redirect to ${target}. Review or remove it in Cloudflare → Rules → Redirect Rules, then prepare again.`, 409, 'redirect_rule_conflict');
  try {
    if (!current.ruleset) {
      await provider(`/zones/${zoneId}/rulesets`, { method: 'POST', body: { name: 'Typeroll redirects', kind: 'zone', phase: REDIRECT_PHASE, rules: [ruleBody(spec)] } });
    } else {
      await provider(`/zones/${zoneId}/rulesets/${current.ruleset.id}/rules`, { method: 'POST', body: ruleBody(spec) });
    }
  } catch (error) {
    if (denied(error)) return { ...spec, status: current.status, managed: false };
    throw error;
  }
  return { ...spec, status: 'configured' };
}

/** Universal SSL readiness. Reading it needs SSL permission; otherwise use Cloudflare's documented issuance window. */
async function edgeCertificate(provider: Provider, zone: ZoneSummary): Promise<RedirectPreparation['edge_certificate']> {
  try {
    const packs = await provider(`/zones/${zone.id}/ssl/verification`);
    if (Array.isArray(packs) && packs.some((pack: any) => pack?.certificate_status === 'active')) return 'active';
    if (Array.isArray(packs) && packs.length) return 'pending';
  } catch (error) { if (!denied(error)) throw error; }
  const activated = zone.activated_on ? Date.parse(zone.activated_on) : NaN;
  return Number.isFinite(activated) && Date.now() - activated > 24 * 3_600_000 ? 'expected' : 'unknown';
}

const certificateReady = (state: RedirectPreparation['edge_certificate']) => state === 'active' || state === 'expected';

/**
 * Prepare one host that answers 301 to the website host. The rule is created only while the
 * host has no proxied traffic, when it cannot change what visitors see; the record waits for approval.
 */
export async function prepareRedirectHost(dns: Provider | null, input: { host: string; target: string; dnsMode: 'automatic' | 'external'; dnsAccountId?: string; configureTraffic?: boolean; orgId?: string }): Promise<RedirectPreparation> {
  const traffic: DnsRequirement = { phase: 'traffic', type: 'A', name: input.host, content: REDIRECT_PLACEHOLDER_ADDRESS, proxied: true, status: 'required' };
  const result: RedirectPreparation = { hostname: input.host, target_host: input.target, provider_status: 'redirect', certificate_ready: false,
    requirements: [traffic], dns_fingerprint: null, action: 'configure_dns', validation_blocker: null, edge_certificate: 'unknown',
    rule: { ...redirectRuleSpec(input.host, input.target, null), managed: false }, blocker: null };
  if (input.dnsMode === 'external' || !dns || !input.dnsAccountId) {
    // External agents apply both the record and the rule; Typeroll verifies the 301 after the switch.
    result.action = 'approve_cutover';
    return result;
  }
  const zone = await findZone(dns, input.dnsAccountId, input.host);
  if (!zone || zone.status !== 'active') {
    result.blocker = zone ? { code: 'zone_not_active', message: inactiveZoneMessage(zone) }
      : { code: 'redirect_zone_required', message: `${input.host} must be in an active Cloudflare zone in a connected account so its redirect can run at Cloudflare's edge.` };
    return result;
  }
  result.zone_id = zone.id; result.zone_name = zone.name;
  result.rule = redirectRuleSpec(input.host, input.target, zone.name);
  if (!coveredByUniversalSsl(input.host, zone.name)) {
    result.blocker = { code: 'redirect_host_certificate_unavailable', message: `${input.host} is more than one level below ${zone.name}; Universal SSL does not cover it.` };
    return result;
  }
  result.edge_certificate = await edgeCertificate(dns, zone);
  result.certificate_ready = certificateReady(result.edge_certificate);
  const records = (await dns(`/zones/${zone.id}/dns_records?name=${encodeURIComponent(input.host)}&per_page=100`)).filter((record: any) => ['A', 'AAAA', 'CNAME'].includes(record.type));
  if (input.orgId) await assertTrafficNotOwnedByOtherOrganization(input.orgId, input.dnsAccountId, records);
  result.has_existing_traffic = records.length > 0;
  result.previous_records = records.map(({ id, type, name, content, proxied, ttl }: any) => ({ id, type, name, content, proxied, ttl }));
  result.dns_fingerprint = trafficFingerprint(records);
  const proxied = records.length > 0 && records.every((record: any) => record.proxied === true);
  const current = await readRule(dns, zone.id, result.rule);
  result.rule = { ...result.rule, status: current.status };
  if (proxied || current.status === 'conflict') {
    // Already proxied: a new rule would change what visitors see, so it waits for approval.
    if (proxied && current.status === 'configured') { traffic.status = 'configured'; result.action = 'verify'; }
    else result.action = result.certificate_ready ? 'approve_cutover' : 'complete_validation';
  } else {
    if (current.status !== 'configured') result.rule = await ensureRedirectRule(dns, zone.id, result.rule, input.host, input.target);
    if (!records.length && input.configureTraffic !== false && result.rule.status === 'configured') {
      // A brand new hostname has no old destination to interrupt.
      await dns(`/zones/${zone.id}/dns_records`, { method: 'POST', body: { type: traffic.type, name: traffic.name, content: traffic.content, proxied: true, ttl: 1, comment: 'Typeroll website redirect' } });
      traffic.status = 'configured'; result.action = 'verify';
    } else result.action = result.certificate_ready ? 'approve_cutover' : 'complete_validation';
  }
  if (result.rule.status === 'conflict') result.blocker = { code: 'redirect_rule_conflict', message: `A redirect rule named ${result.rule.ref} in ${zone.name} differs from the saved redirect. Review it in Cloudflare → Rules → Redirect Rules.` };
  // `unverifiable`: the connection can neither read nor create rules. The manual rule is shown and the public 301 is checked after the switch.
  else if (!result.rule.managed && result.rule.status === 'required') result.blocker = { code: 'redirect_rule_required', message: manualRuleMessage(result.rule, input.host, input.target) };
  return result;
}

/** Prepare every redirect host of a publication with the DNS access that can see its zone. */
export async function prepareRedirectHosts(orgId: string, groupId: string, input: { hosts: string[]; target: string; dnsMode: 'automatic' | 'external'; configureTraffic?: boolean }): Promise<RedirectPreparation[]> {
  const result: RedirectPreparation[] = [];
  for (const host of input.hosts) {
    if (input.dnsMode === 'external') { result.push(await prepareRedirectHost(null, { host, target: input.target, dnsMode: 'external' })); continue; }
    let dns: Awaited<ReturnType<typeof hostingDns>>;
    try { dns = await hostingDns(orgId, groupId, host); }
    catch (error) {
      if (!(error instanceof ConnectionError) || error.code !== 'domain_zone_required') throw error;
      const preparation = await prepareRedirectHost(null, { host, target: input.target, dnsMode: 'external' });
      result.push({ ...preparation, action: 'configure_dns', blocker: { code: error.details?.zone ? 'zone_not_active' : 'redirect_zone_required', message: error.message } });
      continue;
    }
    result.push(await prepareRedirectHost(dns.provider, { host, target: input.target, dnsMode: 'automatic', dnsAccountId: dns.accountId, configureTraffic: input.configureTraffic, orgId }));
  }
  return result;
}

/** Why a redirect host cannot be switched yet, or null. External hosts are verified after the switch instead. */
export function redirectApprovalBlocker(preparation: RedirectPreparation): { code: string; message: string } | null {
  if (preparation.blocker) return preparation.blocker;
  if (!preparation.zone_id) return null;
  if (preparation.has_existing_traffic && preparation.action !== 'verify' && !preparation.certificate_ready) {
    return { code: 'redirect_certificate_pending', message: `Cloudflare has not confirmed the Universal SSL certificate for ${preparation.zone_name}. It is issued 15 minutes to 24 hours after the zone becomes active (SSL/TLS → Edge Certificates shows Active). Keep the current ${preparation.hostname} records until then.` };
  }
  return null;
}

/** Make sure the approved rule exists before any record changes. An unreadable rule set is verified by the public 301 afterward. */
export async function ensureApprovedRedirectRule(provider: Provider, approved: RedirectPreparation): Promise<void> {
  if (!approved.zone_id) return;
  const rule = await ensureRedirectRule(provider, approved.zone_id, approved.rule, approved.hostname, approved.target_host);
  if (rule.status !== 'configured' && rule.status !== 'unverifiable') throw new ConnectionError(manualRuleMessage(rule, approved.hostname, approved.target_host), 409, 'redirect_rule_required');
}

/** Apply an approved redirect host: rule first, then the reviewed record change. */
export async function applyRedirectTraffic(provider: Provider, approved: RedirectPreparation): Promise<void> {
  if (!approved.zone_id) return;
  await ensureApprovedRedirectRule(provider, approved);
  const records = (await provider(`/zones/${approved.zone_id}/dns_records?name=${encodeURIComponent(approved.hostname)}&per_page=100`)).filter((record: any) => ['A', 'AAAA', 'CNAME'].includes(record.type));
  if (records.length && records.every((record: any) => record.proxied === true) && trafficFingerprint(records) === approved.dns_fingerprint) return;
  await applyPreparedTraffic(provider, approved);
}

/** The redirect works when the public host answers 301 with the same path and query on the website host. */
export async function verifyRedirectHost(host: string, target: string, check: string, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; status: number | null; location: string | null }> {
  const path = `/.well-known/typeroll/publication.json?typeroll_redirect_check=${encodeURIComponent(check)}`;
  try {
    const url = parsePublicHttpsUrl(`https://${host}${path}`); await assertPublicDestination(url);
    const response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000), headers: { 'Cache-Control': 'no-cache' } });
    const location = response.headers.get('location');
    return { ok: response.status === 301 && location === `https://${target}${path}`, status: response.status, location };
  } catch { return { ok: false, status: null, location: null }; }
}
