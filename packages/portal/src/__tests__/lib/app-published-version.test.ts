// An app's API follows an installation version change at once, while published pages call the
// version they were built with until the next publication (autopilot.se, 2026-11-11). Core reports
// both, refuses a change that would make a form's endpoint undeclared, and names such a form when
// a publication meets one.

import crypto from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { MAIN_VERSION_ID, paths, type ExtensionManifest, type ExtensionScope } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { createExtension, installExtension, publishExtensionVersion, saveExtensionVersion, updateExtensionInstallation } from '../../lib/extensions/registry';
import { rotateInstallationCredential } from '../../lib/extensions/auth';
import { getStore } from '../../lib/datastore';

const DEV_ORG = 'developer', OWNER_ORG = 'customer', SITE = 'site-one', APP = 'se.vendor.events';
const SCRIPT_DIGEST = crypto.createHash('sha256').update('export function mount() {}').digest('hex');
const SCOPES: ExtensionScope[] = ['extension:config:read'];

function manifest(version: string, routes: Array<{ path: string; methods: string[] }>, overrides: Partial<ExtensionManifest> = {}): ExtensionManifest {
  return {
    schema_version: 3, id: APP, name: 'Events', version, runtime_compatibility: '>=0.38.0 <1.0.0', distribution: 'private',
    developer: { name: 'Vendor AB', support_url: 'https://vendor.example/support', privacy_url: 'https://vendor.example/privacy' },
    permissions: SCOPES.map(scope => ({ scope, reason: `Needs ${scope}.` })),
    api: { base_url: 'https://93.184.216.34/events', authentication: 'signed_installation', routes: routes as never },
    ...overrides,
  };
}

async function release(version: string, routes: Array<{ path: string; methods: string[] }>, overrides: Partial<ExtensionManifest> = {}) {
  await saveExtensionVersion({ developerOrgId: DEV_ORG, extensionId: APP, actorId: 'developer-user', manifest: manifest(version, routes, overrides) });
  await publishExtensionVersion({ developerOrgId: DEV_ORG, extensionId: APP, version, verifyAssets: async () => {} });
}

async function install() {
  await createExtension({ developerOrgId: DEV_ORG, actorId: 'developer-user', id: APP, name: 'Events',
    trustedOrigins: ['https://vendor.example', 'https://93.184.216.34'], allowedSiteIds: [`${OWNER_ORG}/${SITE}`] });
  await release('1.0.0', [{ path: '/leads', methods: ['POST'] }]);
  // A breaking release a site activates explicitly; it no longer declares the form endpoint.
  await release('2.0.0', [{ path: '/signup', methods: ['POST'] }], { activation_policy: 'explicit' });
  return installExtension({ developerOrgId: DEV_ORG, ownerOrgId: OWNER_ORG, siteId: SITE, actorId: 'customer-admin',
    extensionId: APP, version: '1.0.0', grantedScopes: SCOPES, config: {} });
}

async function call(mod: Promise<Record<string, unknown>>, method: string, path: string, params: Record<string, string>, headers: Record<string, string>, body?: unknown): Promise<Response> {
  const handler = (await mod)[method] as APIRoute;
  return handler({
    request: new Request(`https://portal.example${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    params, cookies: { get: () => undefined }, locals: {},
  } as never) as Promise<Response>;
}

beforeEach(async () => {
  makeTmpFixtures();
  await resetDatastore();
  process.env.INTEGRATIONS_SECRET_KEY = 'integration-secret-key-longer-than-thirty-two-characters';
  process.env.PORTAL_PUBLIC_URL = 'https://admin.customer.example';
  delete process.env.EXTENSION_SIGNING_PRIVATE_JWK;
  await getStore().setDoc(paths.site(OWNER_ORG, SITE), { name: SITE, hosting_adapter: 'cloudflare', created_at: new Date().toISOString() });
  await getStore().setDoc(paths.version(OWNER_ORG, SITE, MAIN_VERSION_ID), { name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false });
});

describe('GET /extensions/self', () => {
  it('reports the version live pages call beside the one the app API runs, and null before a publication', async () => {
    const installation = await install();
    const { credential } = await rotateInstallationCredential({ ownerOrgId: OWNER_ORG, siteId: SITE, installationId: installation.id, actorId: 'admin' });
    const headers = { Authorization: `Bearer ${credential}`, 'X-Typeroll-Organization-Id': OWNER_ORG, 'X-Typeroll-Installation-Id': installation.id };
    const self = async () => (await call(import('../../pages/api/v1/sites/[siteId]/extensions/self'), 'GET', `/api/v1/sites/${SITE}/extensions/self`, { siteId: SITE }, headers)).json();
    expect(await self()).toMatchObject({ installation_id: installation.id, version: '1.0.0', published_version: null });
    const target = `${paths.site(OWNER_ORG, SITE)}/publishing_targets/main`;
    await getStore().setDoc(target, { job_id: null, lease_id: null, lease_until: 0, last_publication: { publication_id: 'p1', extension_versions: { [installation.id]: '1.0.0' } } });
    await updateExtensionInstallation({ ownerOrgId: OWNER_ORG, siteId: SITE, installationId: installation.id, actorId: 'admin', version: '2.0.0' });
    // The app API follows the change at once; visitors keep the published version until the next publication.
    expect(await self()).toMatchObject({ version: '2.0.0', published_version: '1.0.0' });
    // A publication that predates recorded versions is unknown, not a version.
    await getStore().updateDoc(target, { last_publication: { publication_id: 'p0' } });
    expect((await self()).published_version).toBeNull();
  });
});

describe('installation version changes and app form endpoints', () => {
  async function withForm() {
    const installation = await install();
    await getStore().setDoc(`${paths.forms(OWNER_ORG, SITE)}/booking`, { name: 'Booking', steps: [], target: { installation_id: installation.id, path: '/leads' } });
    await getStore().setDoc(`${paths.forms(OWNER_ORG, SITE)}/plain`, { name: 'Plain', steps: [] });
    return installation;
  }

  it('refuses a version that does not declare a form endpoint, naming the forms, unless confirmed', async () => {
    const installation = await withForm();
    const change = { ownerOrgId: OWNER_ORG, siteId: SITE, installationId: installation.id, actorId: 'admin', version: '2.0.0' };
    await expect(updateExtensionInstallation(change)).rejects.toMatchObject({ status: 409, code: 'form_targets_undeclared',
      message: expect.stringContaining('booking (/leads)'),
      details: { requires_confirmation: true, version: '2.0.0', affected_forms: [{ form_id: 'booking', name: 'Booking', path: '/leads' }] } });
    expect(await getStore().getDoc(paths.extensionInstallation(OWNER_ORG, SITE, installation.id))).toMatchObject({ version: '1.0.0' });
    // Configuration changes on the current version are not checked.
    await updateExtensionInstallation({ ...change, version: undefined, config: {} });
    expect(await updateExtensionInstallation({ ...change, confirmFormTargets: true })).toMatchObject({ version: '2.0.0' });
  });

  it('returns the refusal from the REST route and accepts confirm_form_targets', async () => {
    const installation = await withForm();
    const { createApiKey } = await import('../../lib/api-keys');
    const token = (await createApiKey({ orgId: OWNER_ORG, siteId: SITE, name: 'site', createdBy: 'admin@example.com' })).token;
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const patch = (body: unknown) => call(import('../../pages/api/v1/sites/[siteId]/extensions/[installationId]'), 'PATCH',
      `/api/v1/sites/${SITE}/extensions/${installation.id}`, { siteId: SITE, installationId: installation.id }, headers, body);
    const refused = await patch({ version: '2.0.0' });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'form_targets_undeclared', requires_confirmation: true, affected_forms: [{ form_id: 'booking', path: '/leads' }] });
    const accepted = await patch({ version: '2.0.0', confirm_form_targets: true });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ installation: { version: '2.0.0' }, redeploy_required: true });
    // Saving a form with an endpoint the active version does not declare stays a plain 400.
    const bind = await call(import('../../pages/api/v1/sites/[siteId]/forms/[formId]'), 'PATCH', `/api/v1/sites/${SITE}/forms/plain`,
      { siteId: SITE, formId: 'plain' }, headers, { target: { installation_id: installation.id, path: '/leads' } });
    expect(bind.status).toBe(400);
    expect(await bind.json()).toMatchObject({ error: expect.stringContaining('declared endpoint') });
  });

  it('fails the publication runtime with the form, installation, path and active version', async () => {
    const installation = await withForm();
    await updateExtensionInstallation({ ownerOrgId: OWNER_ORG, siteId: SITE, installationId: installation.id, actorId: 'admin', version: '2.0.0', confirmFormTargets: true });
    const { publicationRuntime } = await import('../../lib/publishing/runtime-projection');
    const error = await publicationRuntime(OWNER_ORG, SITE).catch(value => value);
    expect(error).toMatchObject({ status: 409, code: 'form_app_endpoint_unavailable' });
    for (const part of ['"Booking" (booking)', '/leads', installation.id, 'active version 2.0.0']) expect(error.message).toContain(part);
  });
});
