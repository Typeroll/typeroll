// Permanent site deletion by an organization owner (lib/site-deletion.ts and
// /api/v1/sites/{siteId}/deletion). Deleting is irreversible, so these pin
// who may do it, what stops it, that a confirmation is of one exact
// inventory of one site, that it removes leaf first and can be resumed, and
// that it leaves a record.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIRoute } from 'astro';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { Site, SiteShare } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';

const ORG = 'orgone';
const SITE = 'old-site';
const OTHER = 'other-site';
const RECIPIENT = 'recipient';
const ARCHIVED = { status: 'archived' as const, archived_at: '2026-11-01T00:00:00Z', archived_by: 'owner' };
const route = () => import('../../pages/api/v1/sites/[siteId]/deletion');

async function store() { return (await import('../../lib/datastore')).getStore(); }

async function seed(site: Partial<Site> = { lifecycle: ARCHIVED }) {
  const s = await store();
  await s.setDoc(paths.org(ORG), { name: 'Org one' });
  await s.setDoc(paths.org(RECIPIENT), { name: 'Recipient' });
  await s.setDoc(`${paths.members(ORG)}/owner`, { role: 'owner', email: 'owner@example.test' });
  await s.setDoc(`${paths.members(ORG)}/admin`, { role: 'admin', email: 'admin@example.test' });
  await s.setDoc(`${paths.members(ORG)}/editor`, { role: 'editor', email: 'editor@example.test' });
  await s.setDoc(`${paths.members(RECIPIENT)}/outsider`, { role: 'owner', email: 'outsider@example.test' });
  for (const id of [SITE, OTHER]) {
    await s.setDoc(paths.site(ORG, id), { name: id, created_at: '2026-01-01T00:00:00Z', hosting_adapter: 'cloudflare', ...(id === SITE ? site : {}) });
    await s.setDoc(paths.version(ORG, id, MAIN_VERSION_ID), { name: 'Main', kind: 'main', created_at: '2026-01-01' });
    await s.setDoc(paths.page(ORG, id, 'home'), { title: 'Home', slug: '' });
  }
  await s.setDoc(`${paths.revisions(ORG, SITE, 'home')}/r1`, { at: 1 });
  await s.setDoc(`${paths.revisions(ORG, SITE, 'home')}/r2`, { at: 2 });
  await s.setDoc(paths.partial(ORG, SITE, 'header'), { name: 'Header' });
  await s.setDoc(paths.version(ORG, SITE, 'redesign'), { name: 'Redesign', kind: 'branch', created_at: '2026-02-01' });
  await s.setDoc(paths.page(ORG, SITE, 'about', 'redesign'), { title: 'About' });
  await s.setDoc(paths.extensionInstallation(ORG, SITE, 'inst-1'), { extension_id: 'acme-app', owner_org_id: ORG, site_id: SITE });
  await s.setDoc(paths.extensionCredential(ORG, SITE, 'inst-1', 'cred-1'), { hash: 'x' });
  await s.setDoc(paths.extensionLaunchGrant(ORG, SITE, 'inst-1', 'grant-1'), { at: 1 });
  await s.setDoc(`${paths.submissions(ORG, SITE)}/sub-1`, { form: 'contact' });
}

async function tokens() {
  const { createApiKey, createPersonalConnection } = await import('../../lib/api-keys');
  return {
    owner: (await createPersonalConnection('owner', 'Owner agent')).token,
    ownerReadOnly: (await createPersonalConnection('owner', 'Read only', 'api_token', { read_only: true })).token,
    admin: (await createPersonalConnection('admin', 'Admin agent')).token,
    editor: (await createPersonalConnection('editor', 'Editor agent')).token,
    outsider: (await createPersonalConnection('outsider', 'Recipient agent')).token,
    orgKey: (await createApiKey({ orgId: ORG, siteId: null, name: 'org', createdBy: 'owner@example.test' })).token,
    siteKey: (await createApiKey({ orgId: ORG, siteId: SITE, name: 'site', createdBy: 'owner@example.test', createdByOrgId: ORG })).token,
  };
}

async function call(method: 'GET' | 'POST', token: string, body?: unknown, opts: { org?: string; site?: string } = {}) {
  const handler = (await route())[method] as APIRoute;
  const site = opts.site ?? SITE;
  const request = new Request(`https://portal.test/api/v1/sites/${site}/deletion`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'Typeroll-Organization': opts.org ?? ORG,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await handler({ request, params: { siteId: site }, cookies: { get: () => undefined } as never, locals: {} as never } as never) as Response;
  return { status: response.status, json: await response.json() as any, headers: response.headers };
}

async function inventory(token: string) {
  const res = await call('GET', token);
  expect(res.status).toBe(200);
  return res.json;
}

async function confirm(token: string) {
  const inv = await inventory(token);
  return call('POST', token, inv.confirm.body);
}

async function remaining(site = SITE): Promise<string[]> {
  return (await store()).listTree!(paths.site(ORG, site));
}

beforeEach(async () => {
  makeTmpFixtures();
  await resetDatastore();
});
afterEach(async () => {
  vi.restoreAllMocks();
  const { setSiteHostingRuntime } = await import('../../lib/publishing/site-hosting');
  setSiteHostingRuntime(null);
});

describe('who may delete a site', () => {
  it('lets only an owner\'s personal connection read the inventory or delete', async () => {
    await seed();
    const t = await tokens();
    for (const token of [t.admin, t.editor, t.orgKey, t.siteKey]) {
      for (const method of ['GET', 'POST'] as const) {
        const res = await call(method, token, method === 'POST' ? { confirm_site_id: SITE, confirm_digest: 'sha256:x' } : undefined);
        expect(res.status, `${method} with a non-owner credential`).toBe(403);
        expect(res.json.code).toBe('owner_authority_required');
      }
    }
    expect((await call('GET', t.owner)).status).toBe(200);
    expect((await (await store()).getDoc(paths.site(ORG, SITE)))).not.toBeNull();
  });

  it('refuses an owner of another organization the site is shared with', async () => {
    await seed();
    const { writeShare } = await import('../../lib/shares');
    await writeShare({ id: 'share-1', site_id: SITE, owner_org_id: ORG, shared_with_org_id: RECIPIENT, permission: 'admin', created_at: 1, created_by: 'owner@example.test' } satisfies SiteShare);
    const t = await tokens();
    const res = await call('GET', t.outsider);
    expect(res.status).toBe(403);
    expect(res.json.code).toBe('owner_authority_required');
  });

  it('lets a read-only owner token read the inventory but not delete', async () => {
    await seed();
    const t = await tokens();
    const inv = await inventory(t.ownerReadOnly);
    const res = await call('POST', t.ownerReadOnly, inv.confirm.body);
    expect(res.status).toBe(403);
    expect(await (await store()).getDoc(paths.site(ORG, SITE))).not.toBeNull();
  });

  it('never accepts an Extension installation or a share as owner authority', async () => {
    const { requireApiOwnerAuthority } = await import('../../lib/api-auth');
    const base = { orgId: ORG, tokenOrgId: ORG, siteId: SITE, site: { id: SITE }, request: new Request('https://portal.test/'), personalUserId: 'owner' } as never;
    await seed();
    expect((await requireApiOwnerAuthority(base, 'delete this site')).ok).toBe(true);
    expect((await requireApiOwnerAuthority({ ...(base as object), extensionIdentity: { installationId: 'i', scopes: [] } } as never, 'delete this site')).ok).toBe(false);
    expect((await requireApiOwnerAuthority({ ...(base as object), tokenOrgId: RECIPIENT } as never, 'delete this site')).ok).toBe(false);
  });
});

describe('the inventory', () => {
  it('counts every document per collection and per version, writes nothing, and says what to send', async () => {
    await seed();
    const t = await tokens();
    const before = await remaining();
    const inv = await inventory(t.owner);
    expect(await remaining()).toEqual(before);
    expect(inv).toMatchObject({ site: SITE, organization_id: ORG, status: 'ready', blockers: [] });
    expect(inv.documents.versions.main).toEqual({ total: 5, collections: { pages: 1, 'pages/*/revisions': 2, partials: 1 } });
    expect(inv.documents.versions.redesign).toEqual({ total: 2, collections: { pages: 1 } });
    expect(inv.documents.collections).toMatchObject({
      extension_installations: 1, 'extension_installations/*/credentials': 1, 'extension_installations/*/launch_grants': 1, submissions: 1, api_keys: 1,
    });
    expect(inv.documents.total).toBe(before.length + 1);
    expect(inv.api_keys_to_revoke).toHaveLength(1);
    expect(inv.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(inv.confirm).toEqual({ method: 'POST', path: `/api/v1/sites/${SITE}/deletion`, body: { confirm_site_id: SITE, confirm_digest: inv.digest } });
    expect(inv.untouched).toContainEqual(expect.objectContaining({ kind: 'extension_data', name: 'acme-app' }));
    expect(inv.message).toContain('Nothing has been deleted');
    // The same state reads as the same digest.
    expect((await inventory(t.owner)).digest).toBe(inv.digest);
  });

  it('lists the customer\'s own Git repository, Pages project and DNS as untouched once the site has published', async () => {
    await seed({ lifecycle: ARCHIVED, git_repository: 'acme-site', domain: 'old.example.com', domain_status: 'pending' });
    await (await store()).setDoc(paths.deploy(ORG, SITE, 'd1'), { status: 'success' });
    const t = await tokens();
    const inv = await inventory(t.owner);
    expect(inv.untouched.map((item: { kind: string }) => item.kind)).toEqual(expect.arrayContaining(['git_repository', 'pages_project', 'build_engine', 'dns_records']));
    expect(inv.untouched.find((item: { kind: string }) => item.kind === 'git_repository').name).toBe('acme-site');
    expect(inv.untouched.find((item: { kind: string }) => item.kind === 'pages_project').message).toContain('keeps serving the last publication');
  });

  it('reports every blocker and offers no confirmation while any remains', async () => {
    await seed({ domain: 'www.example.com', domain_status: 'live' });
    const s = await store();
    await s.setDoc(`${paths.media(ORG, SITE)}/m1`, { filename: 'a.png' });
    const { writeShare } = await import('../../lib/shares');
    await writeShare({ id: 'share-1', site_id: SITE, owner_org_id: ORG, shared_with_org_id: RECIPIENT, permission: 'read', created_at: 1, created_by: 'owner@example.test' } satisfies SiteShare);
    const t = await tokens();
    const inv = await inventory(t.owner);
    expect(inv.status).toBe('blocked');
    expect(inv.blockers.map((b: { code: string }) => b.code).sort()).toEqual(['domain_serving', 'media_present', 'not_archived', 'shared_with_other_orgs']);
    expect(inv.confirm).toBeUndefined();

    const res = await call('POST', t.owner, { confirm_site_id: SITE, confirm_digest: inv.digest });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('site_deletion_blocked');
    expect(res.json.details.blockers).toHaveLength(4);
    expect(await s.getDoc(paths.page(ORG, SITE, 'home'))).not.toBeNull();
    const audit = await s.getDoc<{ status: string; refusal: { blockers: string[] } }>(paths.siteDeletion(ORG, res.json.details.audit_id));
    expect(audit).toMatchObject({ status: 'refused', site_id: SITE, actor: { user_id: 'owner' } });
    expect(audit!.refusal.blockers).toContain('media_present');
  });

  it('does not count the site\'s generated address as a served domain', async () => {
    const { generatedCloudflareNames } = await import('../../lib/publishing/cloudflare-account-claims');
    await seed({ lifecycle: ARCHIVED, domain: `${generatedCloudflareNames(ORG, SITE).site_label}.sites.example.com`, domain_status: 'live' });
    const t = await tokens();
    const inv = await inventory(t.owner);
    expect(inv.blockers).toEqual([]);
    expect(inv.untouched.map((item: { kind: string }) => item.kind)).not.toContain('dns_records');
  });

  it('blocks a hosted site when the hosting service cannot be reached', async () => {
    await seed({ lifecycle: ARCHIVED, publishing_mode: 'hosted' });
    const t = await tokens();
    expect((await inventory(t.owner)).blockers.map((b: { code: string }) => b.code)).toEqual(['hosting_service_unavailable']);
  });
});

describe('confirming', () => {
  it('refuses a confirmation naming another site', async () => {
    await seed();
    const t = await tokens();
    const inv = await inventory(t.owner);
    const res = await call('POST', t.owner, { confirm_site_id: OTHER, confirm_digest: inv.digest });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe('confirm_site_id_mismatch');
    expect(res.json.error).toContain('Nothing was deleted');
    const audit = await (await store()).getDoc(paths.siteDeletion(ORG, res.json.details.audit_id));
    expect(audit).toMatchObject({ status: 'unconfirmed', refusal: { code: 'confirm_site_id_mismatch' } });
  });

  it('refuses another site\'s digest and a missing one', async () => {
    await seed();
    await (await store()).updateDoc(paths.site(ORG, OTHER), { lifecycle: ARCHIVED });
    const t = await tokens();
    const otherInventory = (await call('GET', t.owner, undefined, { site: OTHER })).json;
    const wrong = await call('POST', t.owner, { confirm_site_id: SITE, confirm_digest: otherInventory.digest });
    expect(wrong.status).toBe(409);
    expect(wrong.json.code).toBe('site_deletion_digest_stale');
    const missing = await call('POST', t.owner, { confirm_site_id: SITE });
    expect(missing.status).toBe(409);
    expect(missing.json.code).toBe('confirm_digest_required');
    expect(await remaining()).not.toEqual([]);
  });

  it('refuses a stale digest after the site changed', async () => {
    await seed();
    const t = await tokens();
    const inv = await inventory(t.owner);
    await (await store()).setDoc(`${paths.submissions(ORG, SITE)}/sub-2`, { form: 'contact' });
    const res = await call('POST', t.owner, inv.confirm.body);
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('site_deletion_digest_stale');
    expect(res.json.details.current_digest).toBeUndefined();
    expect(await (await store()).getDoc(`${paths.submissions(ORG, SITE)}/sub-1`)).not.toBeNull();
  });
});

describe('deleting', () => {
  it('revokes the site\'s keys first, deletes leaf first and leaves only an audit record', async () => {
    await seed();
    const s = await store();
    // A revoked share whose recipient-side index entry was left behind.
    await s.setDoc(paths.share(ORG, SITE, 'old-share'), { id: 'old-share', site_id: SITE, owner_org_id: ORG, shared_with_org_id: RECIPIENT, permission: 'read', created_at: 1, created_by: 'x', revoked_at: 2 });
    await s.setDoc(paths.sharesWithOrgEntry(RECIPIENT, 'old-share'), { id: 'old-share', site_id: SITE, owner_org_id: ORG, shared_with_org_id: RECIPIENT });
    const t = await tokens();
    const inv = await inventory(t.owner);
    const [sitePrefix] = inv.api_keys_to_revoke;

    const order: string[] = [];
    const deleteTree = s.deleteTree.bind(s);
    const deleteDoc = s.deleteDoc.bind(s);
    vi.spyOn(s, 'deleteTree').mockImplementation(async (p: string) => { order.push(p); return deleteTree(p); });
    vi.spyOn(s, 'deleteDoc').mockImplementation(async (p: string) => { order.push(p); return deleteDoc(p); });
    const revoke = await import('../../lib/api-keys');
    const revokeSpy = vi.spyOn(revoke, 'revokeApiKey');

    const res = await call('POST', t.owner, { ...inv.confirm.body, reason: 'Staging copy, no longer needed' });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ status: 'deleted', site: SITE, organization_id: ORG, revoked_api_keys: [sitePrefix], deleted_documents: inv.documents.total });
    expect(res.json.message).toContain('permanently deleted');
    expect(res.headers.get('Typeroll-Site-Id')).toBe(SITE);

    // Keys were revoked before the first document went.
    expect(revokeSpy.mock.invocationCallOrder[0]).toBeLessThan((s.deleteTree as unknown as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[0]!);
    expect((await s.getDoc<{ revoked_at?: string }>(paths.apiKeyLookupEntry(sitePrefix)))?.revoked_at).toBeTruthy();
    expect((await call('GET', t.siteKey)).status).toBe(401);

    const site = paths.site(ORG, SITE);
    const index = (p: string) => order.indexOf(p);
    expect(index(paths.sharesWithOrgEntry(RECIPIENT, 'old-share'))).toBeLessThan(index(paths.version(ORG, SITE, 'redesign')));
    expect(index(paths.version(ORG, SITE, 'redesign'))).toBeLessThan(index(paths.version(ORG, SITE, MAIN_VERSION_ID)));
    expect(index(paths.version(ORG, SITE, MAIN_VERSION_ID))).toBeLessThan(index(paths.extensionCredential(ORG, SITE, 'inst-1', 'cred-1')));
    expect(index(paths.extensionLaunchGrant(ORG, SITE, 'inst-1', 'grant-1'))).toBeLessThan(index(paths.extensionInstallation(ORG, SITE, 'inst-1')));
    expect(index(paths.extensionInstallation(ORG, SITE, 'inst-1'))).toBeLessThan(index(site));
    expect(order[order.length - 1]).toBe(site);

    expect(await s.getDoc(site)).toBeNull();
    expect(await remaining()).toEqual([]);
    expect(await s.getDoc(paths.sharesWithOrgEntry(RECIPIENT, 'old-share'))).toBeNull();
    // The neighbouring site is untouched.
    expect(await s.getDoc(paths.page(ORG, OTHER, 'home'))).not.toBeNull();

    const audit = await s.getDoc(paths.siteDeletion(ORG, res.json.audit_id));
    expect(audit).toMatchObject({
      status: 'succeeded', site_id: SITE, org_id: ORG, digest: inv.digest, reason: 'Staging copy, no longer needed',
      actor: { user_id: 'owner' }, revoked_api_keys: [sitePrefix], deleted_documents: inv.documents.total, runs: 1,
    });
  });

  it('continues an interrupted deletion with the same request and refuses to restore meanwhile', async () => {
    await seed();
    const t = await tokens();
    const inv = await inventory(t.owner);
    const { deleteSite } = await import('../../lib/site-deletion');
    const s = await store();
    const site = (await s.getDoc<Site>(paths.site(ORG, SITE)))!;

    // A run that stops after two steps.
    const partial = await deleteSite({ orgId: ORG, site, body: inv.confirm.body, actor: { user_id: 'owner', key_prefix: 'p' }, confirmPath: inv.confirm.path, operationBudget: 2 });
    expect(partial.status).toBe(202);
    expect(partial.body).toMatchObject({ status: 'in_progress', remaining_documents: expect.any(Number) });
    expect(await s.getDoc(paths.site(ORG, SITE))).not.toBeNull();

    // A run that fails outright half way.
    const deleteTree = s.deleteTree.bind(s);
    let calls = 0;
    vi.spyOn(s, 'deleteTree').mockImplementation(async (p: string) => { if (++calls === 2) throw new Error('store unavailable'); return deleteTree(p); });
    await expect(call('POST', t.owner, inv.confirm.body)).rejects.toThrow('store unavailable');
    vi.mocked(s.deleteTree).mockRestore();

    // The inventory shows where it stopped and the confirmed digest.
    const resumed = await inventory(t.owner);
    expect(resumed.status).toBe('in_progress');
    expect(resumed.digest).toBe(inv.digest);
    expect(resumed.documents.total).toBeLessThan(inv.documents.total);

    const { changeSiteLifecycle } = await import('../../lib/site-lifecycle');
    const restore = await changeSiteLifecycle({ ownerOrgId: ORG, site: (await s.getDoc<Site>(paths.site(ORG, SITE)))!, action: 'restore', actor: 'owner' });
    expect(restore.status).toBe(409);
    expect(restore.body.code).toBe('site_deletion_in_progress');

    const done = await call('POST', t.owner, inv.confirm.body);
    expect(done.status).toBe(200);
    expect(done.json.audit_id).toBe(partial.body.audit_id);
    expect(await s.getDoc(paths.site(ORG, SITE))).toBeNull();
    expect(await remaining()).toEqual([]);
    const audit = await s.getDoc(paths.siteDeletion(ORG, done.json.audit_id));
    expect(audit).toMatchObject({ status: 'succeeded', runs: 2, deleted_documents: inv.documents.total });

    // Once gone, the site is simply not found.
    expect((await call('POST', t.owner, inv.confirm.body)).status).toBe(404);
  });

  it('joins a deletion another request started instead of starting a second one', async () => {
    await seed();
    const t = await tokens();
    const inv = await inventory(t.owner);
    const { deleteSite } = await import('../../lib/site-deletion');
    const s = await store();
    // This request read the site before the other one recorded its start.
    const site = (await s.getDoc<Site>(paths.site(ORG, SITE)))!;
    await s.updateDoc(paths.site(ORG, SITE), { lifecycle: { ...ARCHIVED, deletion: { status: 'in_progress', started_at: 'x', started_by: 'owner', audit_id: 'other-run', digest: inv.digest } } });
    const res = await deleteSite({ orgId: ORG, site, body: inv.confirm.body, actor: { user_id: 'owner', key_prefix: 'p' }, confirmPath: inv.confirm.path, operationBudget: 1 });
    expect(res.body.audit_id).toBe('other-run');
  });

  it('takes a hosted site off the hosting service before deleting it', async () => {
    await seed({ lifecycle: ARCHIVED, publishing_mode: 'hosted', hosting_config: { fallback_subdomain: 'old.platform.test' } });
    const retireSite = vi.fn(async () => ({ ok: true as const, value: { retired: true as const } }));
    const { setSiteHostingRuntime } = await import('../../lib/publishing/site-hosting');
    setSiteHostingRuntime(() => ({ retireSite }) as never);
    const t = await tokens();
    const inv = await inventory(t.owner);
    expect(inv.also_removed).toEqual([expect.objectContaining({ kind: 'hosted_site', name: 'old.platform.test' })]);
    expect(inv.untouched.map((item: { kind: string }) => item.kind)).not.toContain('pages_project');
    // The service is briefly unreachable: nothing of the content goes, and the same request continues.
    retireSite.mockResolvedValueOnce({ ok: false, error: { code: 'busy', status: 503, message: 'Busy.', retryable: true } } as never);
    const refused = await call('POST', t.owner, inv.confirm.body);
    expect(refused.status).toBe(503);
    expect(refused.json.details.retryable).toBe(true);
    expect(await (await store()).getDoc(paths.page(ORG, SITE, 'home'))).not.toBeNull();

    const res = await call('POST', t.owner, inv.confirm.body);
    expect(res.status).toBe(200);
    expect(res.json.audit_id).toBe(refused.json.details.audit_id);
    expect(retireSite).toHaveBeenCalledWith(expect.objectContaining({ org: ORG, site: SITE }));
  });
});

describe('listTree', () => {
  async function exercise(s: import('../../lib/datastore').ReadWriteStore) {
    await s.setDoc('organizations/o/sites/s', { name: 's' });
    await s.setDoc('organizations/o/sites/s/versions/main', { kind: 'main' });
    await s.setDoc('organizations/o/sites/s/versions/main/pages/p', { title: 'p' });
    await s.setDoc('organizations/o/sites/s/media/m', { filename: 'm' });
    // Neighbours whose ids share the prefix must not leak in.
    await s.setDoc('organizations/o/sites/s-2', { name: 's-2' });
    await s.setDoc('organizations/o/sites/s-2/media/x', { filename: 'x' });
    await s.setDoc('organizations/o/sites/s0/media/y', { filename: 'y' });
    expect(await s.listTree!('organizations/o/sites/s')).toEqual([
      'organizations/o/sites/s/media/m',
      'organizations/o/sites/s/versions/main',
      'organizations/o/sites/s/versions/main/pages/p',
    ]);
    expect(await s.listTree!('organizations/o/sites/s', { limit: 1 })).toEqual(['organizations/o/sites/s/media/m']);
    expect(await s.listTree!('organizations/o/sites/s', { after: 'organizations/o/sites/s/media/m', limit: 1 })).toEqual(['organizations/o/sites/s/versions/main']);
  }

  it('lists exactly the documents beneath a root in the fixtures store', async () => {
    await exercise(await store());
  });

  it('lists exactly the documents beneath a root in the SQL and sharded stores', async () => {
    const { SqlDocumentEngine } = await import('../../lib/store/sql-engine');
    const { nodeSqliteDriver } = await import('../../lib/store/node-sqlite');
    const { SqlStore, localTransport } = await import('../../lib/store/sql-store');
    const { ShardedStore } = await import('../../lib/store/sharded-store');
    let n = 0;
    await exercise(new SqlStore(localTransport(new SqlDocumentEngine(nodeSqliteDriver(':memory:'))), () => `id${n++}`));
    const engines = new Map<string, InstanceType<typeof SqlDocumentEngine>>();
    const transport = (name: string) => {
      if (!engines.has(name)) engines.set(name, new SqlDocumentEngine(nodeSqliteDriver(':memory:')));
      return localTransport(engines.get(name)!);
    };
    await exercise(new ShardedStore({ transport }, () => `id${n++}`));
  });
});
