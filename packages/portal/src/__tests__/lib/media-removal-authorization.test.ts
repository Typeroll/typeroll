// Who may delete media and remove published copies. Both are irreversible:
// deleting removes the original and every public copy, and removing published
// copies breaks the live site's images until the next publication. The
// published-copies route has the same authority as media/purge (an admin of
// the owning organization): a share recipient, an Extension installation and a
// site key minted outside the owning organization are refused. DELETE stays
// open to people and API keys with write access, but not to an Extension.

import { beforeEach, describe, expect, it } from 'vitest';
import { MAIN_VERSION_ID, paths, type ExtensionManifest, type ExtensionScope, type SiteShare } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';

const DEV_ORG = 'developer';
const OWNER_ORG = 'customer';
const RECIPIENT_ORG = 'recipient';
const SITE = 'site-one';

async function store() {
  return (await import('../../lib/datastore')).getStore();
}

async function seed() {
  const s = await store();
  await s.setDoc(paths.site(OWNER_ORG, SITE), { name: SITE, hosting_adapter: 'cloudflare', created_at: new Date().toISOString() });
  await s.setDoc(paths.version(OWNER_ORG, SITE, MAIN_VERSION_ID), { name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false });
  await s.setDoc(`${paths.media(OWNER_ORG, SITE)}/photo`, { id: 'photo', filename: 'photo.jpg', mime_type: 'image/jpeg', created_at: new Date().toISOString(),
    cdn_url: `https://portal.example/api/sites/${SITE}/media/photo/content` });
}

async function share(recipient: string, permission: 'read' | 'write' | 'admin') {
  const { writeShare } = await import('../../lib/shares');
  await writeShare({ id: `share-${recipient}`, site_id: SITE, owner_org_id: OWNER_ORG, shared_with_org_id: recipient, permission,
    created_at: Date.now(), created_by: 'owner@example.com' } satisfies SiteShare);
}

async function key(orgId: string, siteId: string | null, createdByOrgId?: string) {
  const { createApiKey } = await import('../../lib/api-keys');
  const { token } = await createApiKey({ orgId, siteId, name: 'key', createdBy: 'someone@example.com', ...(createdByOrgId ? { createdByOrgId } : {}) });
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

function manifest(id: string, scopes: ExtensionScope[]): ExtensionManifest {
  return {
    schema_version: 3, id, name: id, version: '1.0.0', runtime_compatibility: '>=0.38.0 <1.0.0', distribution: 'private',
    developer: { name: 'Vendor AB', support_url: 'https://vendor.example/support', privacy_url: 'https://vendor.example/privacy' },
    permissions: scopes.map((scope) => ({ scope, reason: `Needs ${scope}.` })),
    api: { base_url: 'https://93.184.216.34/typeroll', authentication: 'signed_installation', routes: [{ path: '/leads', methods: ['POST'] }] },
  };
}

/** An installed Extension holding media:read and media:write on the site, and its credential headers. */
async function extensionCredential() {
  const { createExtension, installExtension, publishExtensionVersion, saveExtensionVersion } = await import('../../lib/extensions/registry');
  const { rotateInstallationCredential } = await import('../../lib/extensions/auth');
  const scopes: ExtensionScope[] = ['media:read', 'media:write'];
  const id = 'se.vendor.media-app';
  const created = await createExtension({ developerOrgId: DEV_ORG, actorId: 'developer-user', id, name: id,
    trustedOrigins: ['https://vendor.example', 'https://93.184.216.34'], allowedSiteIds: [`${OWNER_ORG}/${SITE}`] });
  await saveExtensionVersion({ developerOrgId: DEV_ORG, extensionId: created.extension.id, actorId: 'developer-user', manifest: manifest(id, scopes) });
  await publishExtensionVersion({ developerOrgId: DEV_ORG, extensionId: created.extension.id, version: '1.0.0', verifyAssets: async () => {} });
  const installation = await installExtension({ developerOrgId: DEV_ORG, ownerOrgId: OWNER_ORG, siteId: SITE, actorId: 'customer-admin',
    extensionId: created.extension.id, version: '1.0.0', grantedScopes: scopes, config: {} });
  const { credential } = await rotateInstallationCredential({ ownerOrgId: OWNER_ORG, siteId: SITE, installationId: installation.id, actorId: 'admin' });
  return { Authorization: `Bearer ${credential}`, 'X-Typeroll-Organization-Id': OWNER_ORG, 'X-Typeroll-Installation-Id': installation.id, 'Content-Type': 'application/json' };
}

async function call(mod: Promise<Record<string, unknown>>, method: string, path: string, params: Record<string, string>, headers: Record<string, string>, body?: unknown): Promise<Response> {
  const handler = (await mod)[method] as APIRoute;
  return handler({
    request: new Request(`https://portal.example${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    params, cookies: { get: () => undefined }, locals: {},
  } as never) as Promise<Response>;
}

const publishedCopies = () => import('../../pages/api/v1/sites/[siteId]/media/published-copies');
const mediaItem = () => import('../../pages/api/v1/sites/[siteId]/media/[mediaId]');
// Asks about an id that was never there, without a scan: nothing can be removed, whoever calls.
const probe = { media_ids: ['never-there'], scan_publications: false, dry_run: true };

beforeEach(async () => {
  makeTmpFixtures();
  await resetDatastore();
  process.env.INTEGRATIONS_SECRET_KEY = 'integration-secret-key-longer-than-thirty-two-characters';
  process.env.PORTAL_PUBLIC_URL = 'https://admin.customer.example';
  process.env.FORMS_HMAC_SECRET = 'forms-secret-key-longer-than-thirty-two-characters';
  delete process.env.EXTENSION_SIGNING_PRIVATE_JWK;
  delete process.env.EXTENSION_SIGNING_PREVIOUS_PUBLIC_JWKS;
  await seed();
});

describe('POST /v1/sites/{siteId}/media/published-copies', () => {
  const post = (headers: Record<string, string>) => call(publishedCopies(), 'POST', `/api/v1/sites/${SITE}/media/published-copies`, { siteId: SITE }, headers, probe);

  it('runs for a site key and an organization key of the owning organization', async () => {
    for (const headers of [await key(OWNER_ORG, SITE), await key(OWNER_ORG, null)]) {
      const response = await post(headers);
      expect(response.status).toBe(207);
      expect(await response.json()).toMatchObject({ complete: false, incomplete_reasons: ['media_not_found'] });
    }
  });

  it('refuses a share recipient, however privileged the share', async () => {
    await share(RECIPIENT_ORG, 'admin');
    const response = await post(await key(RECIPIENT_ORG, null));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'admin_required' });
  });

  it('refuses a site key minted outside the owning organization', async () => {
    const response = await post(await key(OWNER_ORG, SITE, RECIPIENT_ORG));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'admin_required' });
  });

  it('refuses an Extension installation credential with media:write', async () => {
    const response = await post(await extensionCredential());
    expect(response.status).toBe(403);
  });
});

describe('DELETE /v1/sites/{siteId}/media/{mediaId}', () => {
  const del = (headers: Record<string, string>) => call(mediaItem(), 'DELETE', `/api/v1/sites/${SITE}/media/photo`, { siteId: SITE, mediaId: 'photo' }, headers);

  it('refuses an Extension installation credential, even with media:write', async () => {
    const headers = await extensionCredential();
    // The same credential may still change media metadata.
    const patched = await call(mediaItem(), 'PATCH', `/api/v1/sites/${SITE}/media/photo`, { siteId: SITE, mediaId: 'photo' }, headers, { alt_text: 'A photo' });
    expect(patched.status).toBe(200);
    const response = await del(headers);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'extension_media_delete_refused' });
    expect(await (await store()).getDoc(`${paths.media(OWNER_ORG, SITE)}/photo`)).not.toBeNull();
    expect(await (await store()).getDoc(`${paths.site(OWNER_ORG, SITE)}/media_removals/photo`)).toBeNull();
  });

  it('refuses a read-only share recipient', async () => {
    await share(RECIPIENT_ORG, 'read');
    const response = await del(await key(RECIPIENT_ORG, null));
    expect(response.status).toBe(403);
    expect(await (await store()).getDoc(`${paths.media(OWNER_ORG, SITE)}/photo`)).not.toBeNull();
  });
});

describe('POST /api/sites/{siteId}/media/published-copies (portal session)', () => {
  // Runs as the development session (organization `default`), which reaches the site through a share.
  it('refuses a share recipient, however privileged the share', async () => {
    await share('default', 'admin');
    const { POST } = await import('../../pages/api/sites/[siteId]/media/published-copies');
    const response = await POST({ request: new Request(`http://localhost/api/sites/${SITE}/media/published-copies`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(probe) }),
    params: { siteId: SITE }, cookies: { get: () => undefined }, locals: {} } as never) as Response;
    expect(response.status).toBe(403);
  });
});
