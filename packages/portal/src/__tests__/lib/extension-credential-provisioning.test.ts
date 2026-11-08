import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paths, validateExtensionManifest, type ExtensionManifest } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { createExtension, installExtension, publishExtensionVersion, saveExtensionVersion } from '../../lib/extensions/registry';
import { authenticateInstallationCredential, extensionJwks } from '../../lib/extensions/auth';
import { provisionInstallationCredential } from '../../lib/extensions/credential-provisioning';

const DEV_ORG = 'developer';
const OWNER_ORG = 'customer';
const SITE = 'site-one';
const PROVIDER = 'https://93.184.216.34';

function manifest(auth: ExtensionManifest['auth'] | null = { provisioning_url: `${PROVIDER}/installations/provision` }): ExtensionManifest {
  return {
    schema_version: 3,
    id: 'se.vendor.agency',
    name: 'Agency',
    version: '1.0.0',
    runtime_compatibility: '>=0.38.0 <1.0.0',
    distribution: 'private',
    developer: { name: 'Vendor AB', support_url: 'https://vendor.example/support', privacy_url: 'https://vendor.example/privacy' },
    permissions: [{ scope: 'content:read', reason: 'Lists pages.' }],
    api: { base_url: `${PROVIDER}/v1`, authentication: 'none', routes: [] },
    ...(auth ? { auth } : {}),
  };
}

async function register(auth?: ExtensionManifest['auth'] | null) {
  const created = await createExtension({
    developerOrgId: DEV_ORG, actorId: 'developer-user', id: 'se.vendor.agency', name: 'Agency',
    trustedOrigins: [PROVIDER], allowedSiteIds: [`${OWNER_ORG}/${SITE}`],
  });
  await saveExtensionVersion({ developerOrgId: DEV_ORG, extensionId: created.extension.id, actorId: 'developer-user', manifest: manifest(auth) });
  await publishExtensionVersion({ developerOrgId: DEV_ORG, extensionId: created.extension.id, version: '1.0.0', verifyAssets: async () => {} });
}

const install = () => installExtension({
  developerOrgId: DEV_ORG, ownerOrgId: OWNER_ORG, siteId: SITE, actorId: 'customer-admin',
  extensionId: 'se.vendor.agency', version: '1.0.0', grantedScopes: ['content:read'],
});

/** A provider that verifies what it receives the way a real one must, and keeps the credential. */
function provider(answer: (body: Record<string, any>) => Response = () => Response.json({ bound: true })) {
  const received: Array<Record<string, any>> = [];
  const fetchImpl = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    received.push(body);
    return answer(body);
  });
  return { received, fetchImpl };
}

function verifyAssertion(token: string) {
  const [header, payload, signature] = token.split('.');
  const { kid } = JSON.parse(Buffer.from(header!, 'base64url').toString());
  const jwk = extensionJwks().keys.find((key) => key.kid === kid)!;
  const valid = crypto.verify('sha256', Buffer.from(`${header}.${payload}`), { key: crypto.createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(signature!, 'base64url'));
  expect(valid).toBe(true);
  return JSON.parse(Buffer.from(payload!, 'base64url').toString());
}

const authenticate = (credential: string) => authenticateInstallationCredential({ ownerOrgId: OWNER_ORG, siteId: SITE, installationId: installed.id, credential });
let installed: { id: string };

describe('Extension credential provisioning', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
    process.env.INTEGRATIONS_SECRET_KEY = 'integration-secret-key-longer-than-thirty-two-characters';
    process.env.PORTAL_PUBLIC_URL = 'https://admin.customer.example';
    delete process.env.EXTENSION_SIGNING_PRIVATE_JWK;
  });
  afterEach(() => vi.unstubAllGlobals());

  it('connects the provider when the Extension is installed, with a credential bound to a signed assertion', async () => {
    await register();
    const { received, fetchImpl } = provider();
    vi.stubGlobal('fetch', fetchImpl);
    const installation = await install();
    installed = installation;
    expect(installation.credential_provisioning).toMatchObject({ status: 'connected', credential_prefix: expect.any(String) });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(`${PROVIDER}/installations/provision`);
    const [body] = received;
    expect(body).toMatchObject({ protocol_version: 1, issuer: 'https://admin.customer.example', extension_id: 'se.vendor.agency', version: '1.0.0', org_id: OWNER_ORG, site_id: SITE, installation_id: installation.id, scopes: ['content:read'] });
    const claims = verifyAssertion(body!.assertion);
    expect(claims).toMatchObject({ iss: 'https://admin.customer.example', aud: 'se.vendor.agency', token_use: 'credential_provisioning', installation_id: installation.id, org_id: OWNER_ORG, site_id: SITE, version: '1.0.0', developer_org_id: DEV_ORG });
    expect(claims.credential_sha256).toBe(crypto.createHash('sha256').update(body!.credential).digest('hex'));
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(60);
    await expect(authenticate(body!.credential)).resolves.toMatchObject({ scopes: ['content:read'] });
  });

  it('keeps the installation but revokes the credential when the provider refuses, and reports why', async () => {
    await register();
    const { received, fetchImpl } = provider(() => Response.json({ error: 'Unknown issuer' }, { status: 403 }));
    vi.stubGlobal('fetch', fetchImpl);
    const installation = await install();
    installed = installation;
    expect(installation.credential_provisioning).toEqual({ status: 'failed', error: 'The Extension provider did not accept the connection: Unknown issuer' });
    await expect(authenticate(received[0]!.credential)).rejects.toMatchObject({ status: 401 });
    const { getStore } = await import('../../lib/datastore');
    const audit = await getStore().listDocs<{ action: string }>(paths.extensionAudit(OWNER_ORG, SITE));
    expect(audit.map((event) => event.action)).toContain('extension.credential_provisioning_failed');
  });

  it('reconnects with a new credential; the old one keeps a grace period only after the provider confirms', async () => {
    await register();
    const first = provider();
    vi.stubGlobal('fetch', first.fetchImpl);
    installed = await install();
    const old = first.received[0]!.credential;

    const refused = provider(() => new Response('nope', { status: 500 }));
    await expect(provisionInstallationCredential({ ownerOrgId: OWNER_ORG, siteId: SITE, installationId: installed.id, actorId: 'api:key', fetchImpl: refused.fetchImpl as typeof fetch }))
      .rejects.toMatchObject({ status: 502 });
    await expect(authenticate(old)).resolves.toBeTruthy();
    await expect(authenticate(refused.received[0]!.credential)).rejects.toMatchObject({ status: 401 });

    const second = provider();
    const result = await provisionInstallationCredential({ ownerOrgId: OWNER_ORG, siteId: SITE, installationId: installed.id, actorId: 'api:key', fetchImpl: second.fetchImpl as typeof fetch, graceSeconds: 0 });
    expect(result.credential_prefix).toBe(second.received[0]!.credential.split('_')[1]);
    await expect(authenticate(second.received[0]!.credential)).resolves.toBeTruthy();
    await expect(authenticate(old)).rejects.toMatchObject({ status: 401 });
  });

  it('does not follow a redirect from the provider', async () => {
    await register();
    vi.stubGlobal('fetch', provider().fetchImpl);
    installed = await install();
    const redirect = provider(() => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example/' } }));
    await expect(provisionInstallationCredential({ ownerOrgId: OWNER_ORG, siteId: SITE, installationId: installed.id, actorId: 'api:key', fetchImpl: redirect.fetchImpl as typeof fetch }))
      .rejects.toThrow('redirects are not allowed');
  });

  it('installs as before, without contacting anyone, when the manifest declares no provisioning endpoint', async () => {
    await register(null);
    const network = vi.fn();
    vi.stubGlobal('fetch', network);
    const installation = await install();
    expect(installation.credential_provisioning).toBeUndefined();
    expect(network).not.toHaveBeenCalled();
    await expect(provisionInstallationCredential({ ownerOrgId: OWNER_ORG, siteId: SITE, installationId: installation.id, actorId: 'api:key' }))
      .rejects.toMatchObject({ status: 409 });
  });

  it('validates the endpoint and requires its origin to be registered', async () => {
    expect(validateExtensionManifest(manifest({ provisioning_url: 'http://vendor.example/provision' })).errors.join('\n')).toMatch(/auth\.provisioning_url/);
    const created = await createExtension({ developerOrgId: DEV_ORG, actorId: 'developer-user', id: 'se.vendor.agency', name: 'Agency', trustedOrigins: [PROVIDER] });
    await expect(saveExtensionVersion({ developerOrgId: DEV_ORG, extensionId: created.extension.id, actorId: 'developer-user', manifest: manifest({ provisioning_url: 'https://other.example/provision' }) }))
      .rejects.toThrow('unregistered execution origins: https://other.example');
  });
});
