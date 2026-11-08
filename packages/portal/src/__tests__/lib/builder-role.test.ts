/**
 * The builder role, through the real session guards. The dev session (no
 * Firebase) is userId 'dev-user' in organization 'default', so the member
 * document at that id gives the caller a role once the organization
 * enforces roles.
 *
 * A builder does design work (colours, fonts, the Site CSS, the render
 * version, site field definitions, the organization collection) and none of
 * the administrator's: publishing, domains, keys, sharing, the content
 * export, members. An editor designs nothing, and a share with admin
 * permission designs its site but never sees the owner's collection.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { APIRoute } from 'astro';
import { MAIN_VERSION_ID, paths, type MemberRole } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';

const ORG = 'default', USER = 'dev-user', SITE = 'mysite';
const cookies = { get: () => undefined, set: () => {}, delete: () => {} } as never;

async function seed(role?: MemberRole) {
  const store = getStore();
  await store.setDoc(paths.org(ORG), { name: 'Agency', slug: ORG, plan: 'free', created_at: new Date().toISOString(), roles_enforced: true });
  if (role) await store.setDoc(`${paths.members(ORG)}/${USER}`, { email: 'dev@typeroll.local', role, firebase_uid: USER, joined_at: '2026-01-01T00:00:00Z' });
  await store.setDoc(paths.site(ORG, SITE), { name: 'Mine', hosting_adapter: 'cloudflare', created_at: '' });
  await store.setDoc(paths.settings(ORG, SITE, MAIN_VERSION_ID), { site_name: 'Mine', colors: { primary: '#111111' } });
}

type Route = Record<string, APIRoute>;
async function call(route: Route, method: string, init: { body?: unknown; form?: Record<string, string>; params?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { accept: 'application/json' };
  let body: BodyInit | undefined;
  if (init.form) { const form = new FormData(); for (const [key, value] of Object.entries(init.form)) form.set(key, value); body = form; }
  else if (init.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(init.body); }
  const request = new Request(`http://localhost/api/sites/${SITE}/x`, { method, headers, body });
  return route[method]!({ request, cookies, params: { siteId: SITE, ...(init.params ?? {}) }, locals: {}, redirect: (to: string) => new Response(null, { status: 302, headers: { location: to } }) } as never);
}

const settings = () => import('../../pages/api/sites/[siteId]/settings') as Promise<Route>;
const customCss = () => import('../../pages/api/sites/[siteId]/custom-css') as Promise<Route>;
const renderVersion = () => import('../../pages/api/sites/[siteId]/render-version') as Promise<Route>;
const siteFields = () => import('../../pages/api/sites/[siteId]/site-fields/index') as Promise<Route>;
const collection = () => import('../../pages/api/sites/[siteId]/collection/index') as Promise<Route>;
const groups = [{ id: 'contact', label: 'Contact', fields: [{ name: 'phone', label: 'Phone', type: 'text' }] }];

describe('builder role', () => {
  beforeEach(async () => { makeTmpFixtures(); await resetDatastore(); });

  it('resolves design for a builder below admin permission', async () => {
    await seed('builder');
    const { requireSiteAccess } = await import('../../lib/access');
    const guard = await requireSiteAccess(cookies, SITE);
    expect(guard.ok && { permission: guard.value.permission, role: guard.value.role, design: guard.value.design }).toEqual({ permission: 'write', role: 'builder', design: true });
  });

  it('lets a builder change the design settings, Site CSS, render version and site field definitions', async () => {
    await seed('builder');
    expect((await call(await settings(), 'POST', { form: { settings_section: 'design', 'colors.primary': '#0a6b45' } })).status).toBe(200);
    expect(((await (await import('../../lib/version-store')).vstore.settings(ORG, SITE, MAIN_VERSION_ID)) as { colors: { primary: string } }).colors.primary).toBe('#0a6b45');
    expect((await call(await settings(), 'POST', { form: { settings_section: 'general', site_name: 'Renamed' } })).status).toBe(200);
    expect((await call(await customCss(), 'PUT', { body: { css: '.hero { color: red; }' } })).status).toBe(200);
    expect((await call(await renderVersion(), 'POST', { body: { render_version: 14 } })).status).toBe(200);
    expect((await call(await siteFields(), 'PUT', { body: { groups, expected_updated_at: '' } })).status).toBe(200);
    expect((await call(await collection(), 'GET')).status).toBe(200);
  });

  it('keeps publishing, domains, keys, sharing, the export, SEO policy and scripts from a builder', async () => {
    await seed('builder');
    for (const section of ['seo', 'advanced', 'integrations', 'access']) {
      expect((await call(await settings(), 'POST', { form: { settings_section: section } })).status, section).toBe(403);
    }
    expect((await call(await settings(), 'POST', { form: { site_name: 'Whole form' } })).status).toBe(403);
    const routes: Array<[string, () => Promise<Route>, string, Record<string, unknown>?]> = [
      ['deploy', () => import('../../pages/api/sites/[siteId]/deploy') as Promise<Route>, 'POST', {}],
      ['domain', () => import('../../pages/api/sites/[siteId]/domain/index') as Promise<Route>, 'POST', { domain: 'example.com' }],
      ['api keys', () => import('../../pages/api/sites/[siteId]/api-keys/index') as Promise<Route>, 'POST', { name: 'k' }],
      ['shares', () => import('../../pages/api/sites/[siteId]/shares/index') as Promise<Route>, 'POST', { org_id: 'other' }],
      ['export', () => import('../../pages/api/sites/[siteId]/export') as Promise<Route>, 'GET', undefined],
    ];
    for (const [label, route, method, body] of routes) expect((await call(await route(), method, body ? { body } : {})).status, label).toBe(403);
    const members = await import('../../pages/api/orgs/[orgId]/members/index') as unknown as Route;
    expect((await call(members, 'GET', { params: { orgId: ORG } })).status).toBe(403);
  });

  it('refuses design work to an editor', async () => {
    await seed('editor');
    expect((await call(await settings(), 'POST', { form: { settings_section: 'design', 'colors.primary': '#0a6b45' } })).status).toBe(403);
    expect((await call(await customCss(), 'PUT', { body: { css: '' } })).status).toBe(403);
    expect((await call(await siteFields(), 'PUT', { body: { groups, expected_updated_at: '' } })).status).toBe(403);
    // The collection is not there for an editor.
    expect((await call(await collection(), 'GET')).status).toBe(404);
  });

  it('keeps today\'s behaviour while an organization does not enforce roles', async () => {
    await seed('editor');
    await getStore().updateDoc(paths.org(ORG), { roles_enforced: false });
    expect((await call(await customCss(), 'PUT', { body: { css: '' } })).status).toBe(200);
    expect((await call(await collection(), 'GET')).status).toBe(200);
  });

  it('never shows the owner\'s collection to a share, even with admin permission', async () => {
    await seed('owner');
    const store = getStore();
    await store.setDoc(paths.site('clientorg', 'theirsite'), { name: 'Theirs', hosting_adapter: 'cloudflare', created_at: '' });
    const share = { site_id: 'theirsite', owner_org_id: 'clientorg', shared_with_org_id: ORG, permission: 'admin' as const, created_at: Date.now(), created_by: 'owner@client.test' };
    await store.setDoc(paths.share('clientorg', 'theirsite', 's1'), share);
    await store.setDoc(paths.sharesWithOrgEntry(ORG, 's1'), share);
    const request = new Request('http://localhost/api/sites/theirsite/collection', { headers: { accept: 'application/json' } });
    const route = await collection();
    const response = await route.GET!({ request, cookies, params: { siteId: 'theirsite' }, locals: {} } as never);
    expect(response.status).toBe(404);
    // The share still designs the site it was given.
    const { requireSiteAccess } = await import('../../lib/access');
    const guard = await requireSiteAccess(cookies, 'theirsite');
    expect(guard.ok && [guard.value.design, guard.value.is_owner]).toEqual([true, false]);
  });
});

describe('members', () => {
  beforeEach(async () => { makeTmpFixtures(); await resetDatastore(); });

  async function people(roles: Record<string, MemberRole>) {
    for (const [id, role] of Object.entries(roles)) await getStore().setDoc(`${paths.members(ORG)}/${id}`, { email: `${id}@example.com`, role, firebase_uid: id, joined_at: '2026-01-01T00:00:00Z' });
  }

  it('lists members for owners and admins and changes roles through the session route', async () => {
    await seed('admin');
    await people({ anna: 'owner', bo: 'editor' });
    const index = await import('../../pages/api/orgs/[orgId]/members/index') as unknown as Route;
    const one = await import('../../pages/api/orgs/[orgId]/members/[memberId]') as unknown as Route;
    const listed = await (await call(index, 'GET', { params: { orgId: ORG } })).json();
    expect(listed.members.map((member: { id: string; role: string }) => [member.id, member.role])).toEqual([['anna', 'owner'], [USER, 'admin'], ['bo', 'editor']]);
    expect(listed.members[0]).toEqual({ id: 'anna', email: 'anna@example.com', display_name: null, role: 'owner', joined_at: '2026-01-01T00:00:00Z' });
    const changed = await call(one, 'PATCH', { params: { orgId: ORG, memberId: 'bo' }, body: { role: 'builder' } });
    expect(await changed.json()).toMatchObject({ member: { id: 'bo', role: 'builder' } });
    // An admin cannot touch an owner or make one.
    expect((await call(one, 'PATCH', { params: { orgId: ORG, memberId: 'anna' }, body: { role: 'editor' } })).status).toBe(403);
    expect((await call(one, 'PATCH', { params: { orgId: ORG, memberId: 'bo' }, body: { role: 'owner' } })).status).toBe(403);
    expect((await call(one, 'DELETE', { params: { orgId: ORG, memberId: 'anna' } })).status).toBe(403);
    expect((await call(one, 'DELETE', { params: { orgId: ORG, memberId: 'bo' } })).status).toBe(200);
    expect(await getStore().getDoc(`${paths.members(ORG)}/bo`)).toBeNull();
    // Another organization is not there.
    expect((await call(index, 'GET', { params: { orgId: 'elsewhere' } })).status).toBe(404);
  });

  it('never demotes or removes the last owner', async () => {
    await seed('owner');
    const { updateMemberRole, removeMember } = await import('../../lib/members');
    await expect(updateMemberRole(ORG, { userId: USER, role: 'owner' }, USER, 'admin')).rejects.toMatchObject({ status: 409, code: 'last_owner' });
    await expect(removeMember(ORG, { userId: USER, role: 'owner' }, USER)).rejects.toMatchObject({ status: 409, code: 'last_owner' });
    await people({ anna: 'admin' });
    expect(await updateMemberRole(ORG, { userId: USER, role: 'owner' }, 'anna', 'owner')).toMatchObject({ role: 'owner' });
    // With a second owner, the first may step down or leave.
    expect(await updateMemberRole(ORG, { userId: USER, role: 'owner' }, USER, 'builder')).toMatchObject({ role: 'builder' });
    await expect(updateMemberRole(ORG, { userId: 'anna', role: 'owner' }, 'anna', 'editor')).rejects.toMatchObject({ code: 'last_owner' });
    await expect(updateMemberRole(ORG, { userId: USER, role: 'builder' }, 'anna', 'editor')).rejects.toMatchObject({ status: 403 });
    expect(await removeMember(ORG, { userId: USER, role: 'builder' }, USER)).toEqual({ removed: true, id: USER });
  });
});

describe('invites with a role', () => {
  beforeEach(async () => { makeTmpFixtures(); await resetDatastore(); });

  it('joins with the invite\'s role, editor by default, and never invites an owner', async () => {
    await seed('owner');
    const { createInvite, generateInviteToken, parseInviteOptions, redeemInvite, listInvites } = await import('../../lib/invite');
    expect(parseInviteOptions({}).role).toBe('editor');
    expect(parseInviteOptions({ role: 'builder' }).role).toBe('builder');
    expect(() => parseInviteOptions({ role: 'owner' })).toThrow(/never invited/);
    const invite = await createInvite({ orgId: ORG, ttlDays: 7, createdBy: { id: USER }, role: 'builder' });
    expect(invite.role).toBe('builder');
    expect((await listInvites(ORG))[0]!.role).toBe('builder');
    const memberPath = `${paths.members(ORG)}/newcomer`;
    const redeemed = await redeemInvite(generateInviteToken(ORG, invite.inviteId), { userId: 'newcomer', email: 'new@example.com' }, {
      alreadyMember: false, memberPath, member: { email: 'new@example.com', role: 'editor', firebase_uid: 'newcomer', joined_at: new Date().toISOString() },
    });
    expect(redeemed.ok).toBe(true);
    expect(await getStore().getDoc(memberPath)).toMatchObject({ role: 'builder' });
  });

  it('carries the role through the portal route', async () => {
    await seed('admin');
    const generate = await import('../../pages/api/orgs/invite/generate') as unknown as Route;
    const response = await call(generate, 'POST', { body: { role: 'admin', email: 'pat@example.com' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ role: 'admin', email: 'pat@example.com' });
    expect((await call(generate, 'POST', { body: { role: 'owner' } })).status).toBe(400);
  });
});
