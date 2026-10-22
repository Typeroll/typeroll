// Redirect hosts (www → apex) with and without the Dynamic URL Redirects
// scopes (dynamic-redirect.read / dynamic-redirect.write) on the connection
// that holds the zone. Cloudflare is a synthetic double.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { connectionPath, sealCredentials } from '../../lib/publishing/connections';
import { prepareRedirectHost } from '../../lib/publishing/redirect-hosts';
import { ProviderError } from '../../lib/publishing/providers.mjs';

const ORG = 'moveria';
const ACCOUNT = 'a'.repeat(32);
const BASE = 'account-settings.read page.read page.write workers-r2.read workers-r2.write offline_access zone.read dns.read dns.write zone-transform-rules.read zone-transform-rules.write';
const ENABLE_ALL = 'account-settings.write account-analytics.read dynamic-redirect.read dynamic-redirect.write';

beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore();
  vi.stubEnv('INTEGRATIONS_SECRET_KEY', 'synthetic-encryption-key-for-tests-only-32chars');
  vi.stubEnv('PORTAL_PUBLIC_URL', 'http://localhost');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function oauthConnection(scope: string) {
  await getStore().setDoc(connectionPath(ORG, 'cloudflare'), {
    status: 'connected', revision: 'rev', auth_method: 'oauth', cloudflare: { account_id: ACCOUNT, account_name: 'Moveria AB', bucket: '', endpoint: '' },
    encrypted_credentials: sealCredentials(ORG, 'cloudflare', { oauth: { access_token: 'synthetic', refresh_token: 'synthetic', expires_at: Date.now() + 3_600_000, scope } }),
  });
}

/** Zone moveria.se with www still at the old host. Rule writes succeed only with the scopes. */
function zone(canWrite: boolean) {
  const writes: string[] = [];
  const provider = vi.fn(async (route: string, options: { method?: string } = {}) => {
    if (options.method) {
      if (route.includes('/rulesets') && !canWrite) throw new ProviderError('Cloudflare', 403, [10000]);
      writes.push(`${options.method} ${route}`);
      return { id: 'created' };
    }
    if (route.startsWith('/zones?')) return [{ id: 'zone', name: 'moveria.se', status: 'active', account: { id: ACCOUNT } }];
    if (route === '/zones/zone/ssl/verification') return [{ certificate_status: 'active' }];
    if (route.startsWith('/zones/zone/dns_records?')) return [{ id: 'www', type: 'A', name: 'www.moveria.se', content: '203.0.113.7', proxied: false, ttl: 3600 }];
    if (route.endsWith('/entrypoint')) return null;
    throw new Error(`unexpected ${route}`);
  });
  return { provider, writes };
}
const input = { host: 'www.moveria.se', target: 'moveria.se', dnsMode: 'automatic' as const, dnsAccountId: ACCOUNT, orgId: ORG, dnsGroupId: 'default' };

describe('redirect rules and Dynamic URL Redirects', () => {
  it('creates the Single Redirect rule automatically when the connection has the scopes', async () => {
    vi.stubEnv('TYPEROLL_PUBLISH_CLOUDFLARE_OPTIONAL_SCOPES', ENABLE_ALL);
    await oauthConnection(`${BASE} dynamic-redirect.read dynamic-redirect.write`);
    const { provider, writes } = zone(true);
    const result = await prepareRedirectHost(provider, input);
    expect(writes).toEqual(['POST /zones/zone/rulesets']);
    expect(result).toMatchObject({ rule: { status: 'configured', managed: true }, blocker: null });
  });

  it('falls back to redirect_rule_required without them and names the one permission update', async () => {
    vi.stubEnv('TYPEROLL_PUBLISH_CLOUDFLARE_OPTIONAL_SCOPES', ENABLE_ALL);
    await oauthConnection(BASE);
    const result = await prepareRedirectHost(zone(false).provider, input);
    expect(result.rule).toMatchObject({ status: 'required', managed: false });
    expect(result.blocker).toMatchObject({ code: 'redirect_rule_required' });
    expect(result.blocker!.message).toContain('Rules → Redirect Rules');
    expect(result.blocker!.message).toContain('Approve update');
    expect(result.blocker!.message).toContain('dynamic-redirect.write');
  });

  it('keeps today’s manual rule on a deployment that does not request the scopes', async () => {
    await oauthConnection(BASE);
    const result = await prepareRedirectHost(zone(false).provider, input);
    expect(result.blocker).toMatchObject({ code: 'redirect_rule_required' });
    expect(result.blocker!.message).not.toContain('Approve update');
  });
});
