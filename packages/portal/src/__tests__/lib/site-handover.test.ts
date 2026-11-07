/**
 * The site handover setting (SiteSettings.handover) through the real routes:
 * the v1 settings PATCH and the portal's settings PATCH replace the whole
 * object and null removes it; it is validated (start_page must be a page of
 * the site); it needs design rights (an administrator or builder, not an
 * editor); and an app installation writes it only with the `site:handover`
 * scope, which reads the settings and writes that key alone. Offline.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { APIRoute } from 'astro';
import { EXTENSION_SCOPE_REGISTRY, MAIN_VERSION_ID, paths, type ExtensionManifest, type ExtensionScope, type MemberRole } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { vstore } from '../../lib/version-store';
import { extensionGrantedScope, extensionScopeForApiRequest } from '../../lib/api-auth';
import { createExtension, installExtension, publishExtensionVersion, saveExtensionVersion } from '../../lib/extensions/registry';
import { rotateInstallationCredential } from '../../lib/extensions/auth';

const ORG = 'default', SITE = 'client-site';
const cookies = { get: () => undefined, set: () => {}, delete: () => {} } as never;
type Route = Record<string, APIRoute>;
const settingsV1 = () => import('../../pages/api/v1/sites/[siteId]/settings') as unknown as Promise<Route>;
const settingsSession = () => import('../../pages/api/sites/[siteId]/settings') as unknown as Promise<Route>;

const HANDOVER = { lock_structure: true, start_page: 'home', checklist: [{ id: 'photos', label: 'Replace the sample photos', href: `/app/sites/${SITE}/media` }, { id: 'domain', label: 'Connect the domain', done: true }] };

async function seed(org = ORG, role?: MemberRole) {
  const store = getStore();
  await store.setDoc(paths.org(org), { name: 'Agency', slug: org, plan: 'free', created_at: '', roles_enforced: true });
  if (role) await store.setDoc(`${paths.members(org)}/dev-user`, { email: 'dev@typeroll.local', role, firebase_uid: 'dev-user', joined_at: '2026-01-01T00:00:00Z' });
  await store.setDoc(paths.site(org, SITE), { name: 'Client', hosting_adapter: 'cloudflare', created_at: '' });
  await store.setDoc(paths.version(org, SITE, MAIN_VERSION_ID), { name: 'Main', kind: 'main', created_at: '', robots_blocked: false });
  await store.setDoc(paths.settings(org, SITE, MAIN_VERSION_ID), { site_name: 'Client', fonts: { heading: 'Inter', body: 'Inter' } });
  await store.setDoc(paths.page(org, SITE, 'home', MAIN_VERSION_ID), { title: 'Home', slug: '', status: 'published', content_mode: 'blocks', blocks: [] });
}

async function v1(method: string, headers: Record<string, string>, body?: unknown) {
  const route = await settingsV1();
  return route[method]!({ request: new Request(`https://portal.example/api/v1/sites/${SITE}/settings`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), params: { siteId: SITE }, cookies, locals: {} } as never) as Promise<Response>;
}
async function session(body: unknown) {
  const route = await settingsSession();
  return route.PATCH!({ request: new Request(`http://localhost/api/sites/${SITE}/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) }), params: { siteId: SITE }, cookies, locals: {} } as never) as Promise<Response>;
}
const stored = async (org = ORG) => (await vstore.settings(org, SITE, MAIN_VERSION_ID))?.handover;

beforeEach(async () => {
  makeTmpFixtures();
  await resetDatastore();
  process.env.INTEGRATIONS_SECRET_KEY = 'integration-secret-key-longer-than-thirty-two-characters';
  process.env.PORTAL_PUBLIC_URL = 'https://admin.customer.example';
  process.env.FORMS_HMAC_SECRET = 'forms-secret-key-longer-than-thirty-two-characters';
});

describe('handover in the v1 settings PATCH', () => {
  async function key() {
    const { createApiKey } = await import('../../lib/api-keys');
    return { authorization: `Bearer ${(await createApiKey({ orgId: ORG, siteId: SITE, name: 'k', createdBy: 'a@example.com' })).token}` };
  }

  it('replaces the whole object, and null removes it', async () => {
    await seed();
    const auth = await key();
    const first = await v1('PATCH', auth, { handover: HANDOVER });
    expect(first.status).toBe(200);
    expect(((await first.json()) as { updated_fields: string[] }).updated_fields).toEqual(['handover']);
    expect(await stored()).toEqual(HANDOVER);
    // Not a merge: the second object is all that is left.
    expect((await v1('PATCH', auth, { handover: { checklist: [{ id: 'launch', label: 'Launch' }] } })).status).toBe(200);
    expect(await stored()).toEqual({ checklist: [{ id: 'launch', label: 'Launch' }] });
    expect((await v1('PATCH', auth, { handover: null })).status).toBe(200);
    expect(await stored()).toBeUndefined();
    expect(((await (await v1('GET', auth)).json()) as { settings: Record<string, unknown> }).settings).not.toHaveProperty('handover');
  });

  it('validates the object and the start page', async () => {
    await seed();
    const auth = await key();
    const bad = await v1('PATCH', auth, { handover: { lock: true, checklist: [{ id: 'a', label: '' }] } });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { details: { errors: string[] } }).details.errors).toEqual(['handover.lock is not allowed', 'handover.checklist[0].label must be text up to 200 characters']);
    const missing = await v1('PATCH', auth, { handover: { start_page: 'nope' } });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toContain('"nope" is not a page of this site');
    expect(await stored()).toBeUndefined();
  });
});

describe('handover in the portal settings PATCH', () => {
  it('lets a builder replace it and refuses an editor', async () => {
    await seed(ORG, 'builder');
    const saved = await session({ handover: HANDOVER });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ saved: true, handover: HANDOVER });
    expect((await session({ handover: { lock_structure: false } })).status).toBe(200);
    expect(await stored()).toEqual({ lock_structure: false });
    expect((await session({ handover: null })).status).toBe(200);
    expect(await stored()).toBeUndefined();
    expect((await session({ handover: { start_page: 'gone' } })).status).toBe(400);
    expect((await session({ handover: {}, site_name: 'x' })).status).toBe(400);

    await getStore().updateDoc(`${paths.members(ORG)}/dev-user`, { role: 'editor' });
    const refused = await session({ handover: HANDOVER });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { code: string }).code).toBe('design_permission_required');
    expect(await stored()).toBeUndefined();
  });
});

describe('the site:handover scope', () => {
  const OWNER = 'customer';
  function manifest(id: string, scopes: ExtensionScope[]): ExtensionManifest {
    return {
      schema_version: 3, id, name: id, version: '1.0.0', runtime_compatibility: '>=0.38.0 <1.0.0', distribution: 'private',
      developer: { name: 'Agency AB', support_url: 'https://agency.example/support', privacy_url: 'https://agency.example/privacy' },
      permissions: scopes.map(scope => ({ scope, reason: `Needs ${scope}.` })),
      api: { base_url: 'https://93.184.216.34/typeroll', authentication: 'signed_installation', routes: [{ path: '/hooks', methods: ['POST'] }] },
    };
  }
  async function credential(scopes: ExtensionScope[], id = 'se.agency.handover') {
    const created = await createExtension({ developerOrgId: 'agency-dev', actorId: 'dev', id, name: id, trustedOrigins: ['https://agency.example', 'https://93.184.216.34'], allowedSiteIds: [`${OWNER}/${SITE}`] });
    await saveExtensionVersion({ developerOrgId: 'agency-dev', extensionId: created.extension.id, actorId: 'dev', manifest: manifest(id, scopes) });
    await publishExtensionVersion({ developerOrgId: 'agency-dev', extensionId: created.extension.id, version: '1.0.0', verifyAssets: async () => {} });
    const installation = await installExtension({ developerOrgId: 'agency-dev', ownerOrgId: OWNER, siteId: SITE, actorId: 'admin', extensionId: created.extension.id, version: '1.0.0', grantedScopes: scopes, config: {} });
    const { credential: token } = await rotateInstallationCredential({ ownerOrgId: OWNER, siteId: SITE, installationId: installation.id, actorId: 'admin' });
    return { authorization: `Bearer ${token}`, 'x-typeroll-organization-id': OWNER, 'x-typeroll-installation-id': installation.id };
  }

  it('is registered as a sensitive scope and stands in for content scopes on /settings only', () => {
    expect(EXTENSION_SCOPE_REGISTRY['site:handover']).toMatchObject({ minimum_permission: 'admin', sensitive: true });
    expect(extensionScopeForApiRequest(`/api/v1/sites/${SITE}/settings`, 'PATCH')).toBe('content:write');
    expect(extensionGrantedScope(`/api/v1/sites/${SITE}/settings`, 'PATCH', ['site:handover'])).toBe('site:handover');
    expect(extensionGrantedScope(`/api/v1/sites/${SITE}/settings`, 'GET', ['site:handover'])).toBe('site:handover');
    expect(extensionGrantedScope(`/api/v1/sites/${SITE}/settings`, 'PATCH', ['content:write', 'site:handover'])).toBe('content:write');
    expect(extensionGrantedScope(`/api/v1/sites/${SITE}/pages`, 'GET', ['site:handover'])).toBeNull();
    expect(extensionGrantedScope(`/api/v1/sites/${SITE}/settings`, 'DELETE', ['site:handover'])).toBeNull();
  });

  it('reads the settings and writes only the handover key', async () => {
    await seed(OWNER);
    const headers = await credential(['site:handover']);
    expect((await v1('GET', headers)).status).toBe(200);
    expect((await v1('PATCH', headers, { handover: HANDOVER })).status).toBe(200);
    expect(await stored(OWNER)).toEqual(HANDOVER);
    for (const body of [{ site_name: 'Renamed' }, { handover: null, site_name: 'Renamed' }, { colors: { primary: '#000000' } }, {}]) {
      const refused = await v1('PATCH', headers, body);
      expect(refused.status, JSON.stringify(body)).toBe(403);
    }
    expect((await vstore.settings(OWNER, SITE, MAIN_VERSION_ID))?.site_name).toBe('Client');
    // Pages are out of its reach.
    const pages = await import('../../pages/api/v1/sites/[siteId]/pages/index') as unknown as Route;
    const res = await pages.GET!({ request: new Request(`https://portal.example/api/v1/sites/${SITE}/pages`, { headers }), params: { siteId: SITE }, cookies, locals: {} } as never) as Response;
    expect(res.status).toBe(403);
  });

  it('is needed for handover: content:write alone is refused', async () => {
    await seed(OWNER);
    const headers = await credential(['content:read', 'content:write'], 'se.agency.content');
    const refused = await v1('PATCH', headers, { handover: HANDOVER });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toContain('site:handover');
    expect(await stored(OWNER)).toBeUndefined();
  });
});
