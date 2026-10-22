import { describe, expect, it, vi } from 'vitest';
import { ProviderError } from '../../lib/publishing/providers.mjs';
import { prepareRedirectHost, applyRedirectTraffic, redirectApprovalBlocker, verifyRedirectHost, redirectRuleSpec } from '../../lib/publishing/redirect-hosts';

vi.mock('../../lib/extensions/public-http', () => ({ parsePublicHttpsUrl: (value: string) => new URL(value), assertPublicDestination: async () => {} }));

const ACCOUNT = 'a'.repeat(32);
const ENTRYPOINT = '/zones/zone/rulesets/phases/http_request_dynamic_redirect/entrypoint';
interface State {
  zone?: { status: string; activated_on?: string } | null;
  records?: Array<Record<string, unknown>>;
  ruleset?: { id: string; rules: any[] } | null;
  ssl?: Array<{ certificate_status: string }> | 'denied';
  rulesDenied?: 'read' | 'write';
}
/** Synthetic Cloudflare API for one zone, `moveria.se`. Writes are recorded, never sent. */
function cloudflare(state: State) {
  const writes: Array<[string, any]> = [];
  const provider = vi.fn(async (route: string, options: { method?: string; body?: any; missing?: boolean } = {}) => {
    if (options.method) {
      if (route.includes('/rulesets') && state.rulesDenied) throw new ProviderError('Cloudflare', 403, [10000]);
      writes.push([`${options.method} ${route}`, options.body]);
      return { id: 'created' };
    }
    if (route.startsWith('/zones?')) {
      const name = new URL(`https://api.invalid${route}`).searchParams.get('name');
      return name === 'moveria.se' && state.zone ? [{ id: 'zone', name, status: state.zone.status, activated_on: state.zone.activated_on, account: { id: ACCOUNT } }] : [];
    }
    if (route === '/zones/zone/ssl/verification') { if (state.ssl === 'denied') throw new ProviderError('Cloudflare', 403, [10000]); return state.ssl ?? []; }
    if (route.startsWith('/zones/zone/dns_records?')) return state.records ?? [];
    if (route === ENTRYPOINT) { if (state.rulesDenied === 'read') throw new ProviderError('Cloudflare', 403, [10000]); return state.ruleset ?? null; }
    throw new Error(`unexpected route ${route}`);
  });
  return { provider, writes };
}
const kinsta = [{ id: 'www-a', type: 'A', name: 'www.moveria.se', content: '203.0.113.7', proxied: false, ttl: 3600 }];
const input = { host: 'www.moveria.se', target: 'moveria.se', dnsMode: 'automatic' as const, dnsAccountId: ACCOUNT };

describe('www redirect host preparation', () => {
  it('creates the zone redirect rule while www is DNS only and leaves the Kinsta record for approval', async () => {
    const { provider, writes } = cloudflare({ zone: { status: 'active' }, records: kinsta, ruleset: null, ssl: [{ certificate_status: 'active' }] });
    const result = await prepareRedirectHost(provider, input);
    expect(writes).toEqual([['POST /zones/zone/rulesets', { name: 'Typeroll redirects', kind: 'zone', phase: 'http_request_dynamic_redirect', rules: [{
      ref: redirectRuleSpec('www.moveria.se', 'moveria.se', null).ref, description: 'Typeroll website redirect', expression: 'http.host eq "www.moveria.se"', action: 'redirect', enabled: true,
      action_parameters: { from_value: { target_url: { expression: 'concat("https://moveria.se", http.request.uri.path)' }, status_code: 301, preserve_query_string: true } } }] }]]);
    expect(result).toMatchObject({ action: 'approve_cutover', certificate_ready: true, edge_certificate: 'active', has_existing_traffic: true, zone_id: 'zone', zone_name: 'moveria.se',
      rule: { status: 'configured', managed: true }, blocker: null, previous_records: [expect.objectContaining({ content: '203.0.113.7', proxied: false })],
      requirements: [{ phase: 'traffic', type: 'A', name: 'www.moveria.se', content: '192.0.2.1', proxied: true, status: 'required' }] });
    expect(redirectApprovalBlocker(result)).toBeNull();
  });

  it('accepts an equivalent rule created in the dashboard without adding another', async () => {
    const manual = { id: 'manual', ref: 'customer', action: 'redirect', expression: '(http.host eq "www.moveria.se")',
      action_parameters: { from_value: { target_url: { expression: 'concat("https://moveria.se", http.request.uri.path)' }, status_code: 301, preserve_query_string: true } } };
    const { provider, writes } = cloudflare({ zone: { status: 'active' }, records: kinsta, ruleset: { id: 'rs', rules: [manual] }, ssl: [{ certificate_status: 'active' }] });
    expect((await prepareRedirectHost(provider, input)).rule.status).toBe('configured');
    expect(writes).toEqual([]);
  });

  it('adds the rule to an existing redirect rule set and never edits other rules', async () => {
    const other = { id: 'other', ref: 'campaign', action: 'redirect', expression: 'http.request.uri.path eq "/kampanj"', action_parameters: { from_value: { target_url: { value: 'https://moveria.se/' }, status_code: 302 } } };
    const { provider, writes } = cloudflare({ zone: { status: 'active' }, records: kinsta, ruleset: { id: 'rs', rules: [other] }, ssl: [{ certificate_status: 'active' }] });
    await prepareRedirectHost(provider, input);
    expect(writes.map(([route]) => route)).toEqual(['POST /zones/zone/rulesets/rs/rules']);
  });

  it('reports a changed Typeroll rule as a conflict without writing', async () => {
    const spec = redirectRuleSpec('www.moveria.se', 'moveria.se', 'moveria.se');
    const changed = { ref: spec.ref, action: 'redirect', expression: spec.expression, action_parameters: { from_value: { target_url: { expression: 'concat("https://old.example", http.request.uri.path)' }, status_code: 301, preserve_query_string: true } } };
    const { provider, writes } = cloudflare({ zone: { status: 'active' }, records: kinsta, ruleset: { id: 'rs', rules: [changed] }, ssl: [{ certificate_status: 'active' }] });
    const result = await prepareRedirectHost(provider, input);
    expect(result).toMatchObject({ rule: { status: 'conflict' }, blocker: { code: 'redirect_rule_conflict' } });
    expect(redirectApprovalBlocker(result)?.code).toBe('redirect_rule_conflict');
    expect(writes).toEqual([]);
  });

  it('returns the manual Single Redirect rule when the connection cannot create redirect rules', async () => {
    const { provider, writes } = cloudflare({ zone: { status: 'active' }, records: kinsta, ruleset: null, ssl: [{ certificate_status: 'active' }], rulesDenied: 'write' });
    const result = await prepareRedirectHost(provider, input);
    expect(result.rule).toMatchObject({ status: 'required', managed: false });
    expect(result.blocker).toMatchObject({ code: 'redirect_rule_required', message: expect.stringContaining('Rules → Redirect Rules') });
    expect(redirectApprovalBlocker(result)?.code).toBe('redirect_rule_required');
    expect(writes).toEqual([]);
  });

  it('does not add a rule in front of traffic that is already proxied before approval', async () => {
    const { provider, writes } = cloudflare({ zone: { status: 'active' }, records: [{ ...kinsta[0], proxied: true }], ruleset: null, ssl: [{ certificate_status: 'active' }] });
    const result = await prepareRedirectHost(provider, input);
    expect(writes).toEqual([]);
    expect(result).toMatchObject({ action: 'approve_cutover', rule: { status: 'required', managed: true } });
  });

  it('configures a brand new redirect host directly', async () => {
    const { provider, writes } = cloudflare({ zone: { status: 'active' }, records: [], ruleset: null, ssl: [{ certificate_status: 'active' }] });
    const result = await prepareRedirectHost(provider, { ...input, orgId: 'org' });
    expect(writes.map(([route, body]) => [route, body?.type, body?.content, body?.proxied])).toEqual([
      ['POST /zones/zone/rulesets', undefined, undefined, undefined], ['POST /zones/zone/dns_records', 'A', '192.0.2.1', true]]);
    expect(result.action).toBe('verify');
  });

  it('infers the Universal SSL certificate from Cloudflare\'s documented issuance window when SSL status is unreadable', async () => {
    const old = cloudflare({ zone: { status: 'active', activated_on: new Date(Date.now() - 48 * 3_600_000).toISOString() }, records: kinsta, ruleset: null, ssl: 'denied' });
    expect(await prepareRedirectHost(old.provider, input)).toMatchObject({ edge_certificate: 'expected', certificate_ready: true });
    const recent = cloudflare({ zone: { status: 'active', activated_on: new Date().toISOString() }, records: kinsta, ruleset: null, ssl: 'denied' });
    const pending = await prepareRedirectHost(recent.provider, input);
    expect(pending).toMatchObject({ edge_certificate: 'unknown', certificate_ready: false });
    expect(redirectApprovalBlocker(pending)).toMatchObject({ code: 'redirect_certificate_pending', message: expect.stringContaining('24 hours') });
  });

  it('reports a pending zone before reading records or rules', async () => {
    const { provider, writes } = cloudflare({ zone: { status: 'pending' } });
    const result = await prepareRedirectHost(provider, input);
    expect(result.blocker).toMatchObject({ code: 'zone_not_active' });
    expect(provider.mock.calls.every(([route]) => route.startsWith('/zones?'))).toBe(true);
    expect(writes).toEqual([]);
  });

  it('returns requirements without provider access for external DNS', async () => {
    const result = await prepareRedirectHost(null, { ...input, dnsMode: 'external' });
    expect(result).toMatchObject({ action: 'approve_cutover', rule: { expression: 'http.host eq "www.moveria.se"', status_code: 301, preserve_query_string: true, managed: false } });
    expect(redirectApprovalBlocker(result)).toBeNull();
  });
});

describe('www redirect cutover', () => {
  it('ensures the rule, then changes the one reviewed record to a proxied placeholder', async () => {
    const prepared = cloudflare({ zone: { status: 'active' }, records: kinsta, ruleset: null, ssl: [{ certificate_status: 'active' }] });
    const approved = await prepareRedirectHost(prepared.provider, input);
    const { provider, writes } = cloudflare({ zone: { status: 'active' }, records: kinsta, ruleset: { id: 'rs', rules: [{ ref: approved.rule.ref, action: 'redirect', expression: approved.rule.expression,
      action_parameters: { from_value: { target_url: { expression: approved.rule.target_url_expression }, status_code: 301, preserve_query_string: true } } }] } });
    await applyRedirectTraffic(provider, approved);
    expect(writes).toEqual([['PATCH /zones/zone/dns_records/www-a', { type: 'A', name: 'www.moveria.se', content: '192.0.2.1', proxied: true, ttl: 1, comment: 'Typeroll static publication' }]]);
  });

  it('stops before any DNS write when the reviewed records changed', async () => {
    const prepared = cloudflare({ zone: { status: 'active' }, records: kinsta, ruleset: { id: 'rs', rules: [] }, ssl: [{ certificate_status: 'active' }] });
    const approved = await prepareRedirectHost(prepared.provider, input);
    const { provider, writes } = cloudflare({ zone: { status: 'active' }, records: [{ ...kinsta[0], content: '203.0.113.8' }], ruleset: prepared.writes.length ? { id: 'rs', rules: [prepared.writes[0][1]] } : null });
    await expect(applyRedirectTraffic(provider, approved)).rejects.toMatchObject({ code: 'dns_revision_conflict' });
    expect(writes).toEqual([]);
  });
});

describe('public redirect verification', () => {
  const response = (status: number, location: string | null) => vi.fn(async () => new Response(null, { status, headers: location ? { location } : {} }));
  it('requires a permanent redirect that keeps the path and query', async () => {
    const path = '/.well-known/typeroll/publication.json?typeroll_redirect_check=abc';
    const ok = response(301, `https://moveria.se${path}`);
    expect(await verifyRedirectHost('www.moveria.se', 'moveria.se', 'abc', ok as any)).toMatchObject({ ok: true, status: 301 });
    expect(ok).toHaveBeenCalledWith(new URL(`https://www.moveria.se${path}`), expect.objectContaining({ redirect: 'manual' }));
    expect((await verifyRedirectHost('www.moveria.se', 'moveria.se', 'abc', response(302, `https://moveria.se${path}`) as any)).ok).toBe(false);
    expect((await verifyRedirectHost('www.moveria.se', 'moveria.se', 'abc', response(301, 'https://moveria.se/') as any)).ok).toBe(false);
    expect((await verifyRedirectHost('www.moveria.se', 'moveria.se', 'abc', vi.fn(async () => { throw new TypeError('fetch failed'); }) as any)).ok).toBe(false);
  });
});
