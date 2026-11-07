// The organization collection and members over the public API: an
// organization key of the owning organization reaches the collection; a
// site-scoped key and a key that reaches the site through a share (even an
// admin share) get 404. Members: an organization key acts as an
// administrator and cannot make owners; invites carry their role.

import { beforeEach, describe, expect, it } from 'vitest';
import type { APIRoute } from 'astro';
import { paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';

const ORG = 'agency-org', CLIENT = 'client-org', SITE = 'client-site';

beforeEach(async () => {
  makeTmpFixtures();
  await resetDatastore();
  const store = getStore();
  for (const id of [ORG, CLIENT]) await store.setDoc(paths.org(id), { name: id, slug: id, plan: 'free', created_at: '2026-01-01' });
  await store.setDoc(paths.site(ORG, SITE), { name: 'Client site', created_at: '2026-01-01' });
  const share = { site_id: SITE, owner_org_id: ORG, shared_with_org_id: CLIENT, permission: 'admin' as const, created_at: Date.now(), created_by: 'owner@agency.test' };
  await store.setDoc(paths.share(ORG, SITE, 's1'), share);
  await store.setDoc(paths.sharesWithOrgEntry(CLIENT, 's1'), share);
  await store.setDoc(`${paths.members(ORG)}/anna`, { email: 'anna@agency.test', role: 'owner', firebase_uid: 'anna', joined_at: '2026-01-01T00:00:00Z' });
  await store.setDoc(`${paths.members(ORG)}/bo`, { email: 'bo@agency.test', role: 'editor', firebase_uid: 'bo', joined_at: '2026-01-02T00:00:00Z' });
});

async function key(orgId: string, siteId: string | null): Promise<string> {
  const { createApiKey } = await import('../../lib/api-keys');
  return (await createApiKey({ orgId, siteId, name: 'seed', createdBy: 'person@example.test' })).token;
}

async function call(mod: Record<string, APIRoute>, method: string, token: string, params: Record<string, string>, body?: unknown) {
  const res = await mod[method]!({
    request: new Request('https://portal.test/api/v1/x', { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) }),
    params,
  } as never) as Response;
  return { status: res.status, json: await res.json().catch(() => ({})) as any };
}

describe('collection over the public API', () => {
  it('answers the owning organization and hides it from site keys and shares', async () => {
    const list = await import('../../pages/api/v1/sites/[siteId]/collection/index') as unknown as Record<string, APIRoute>;
    const owner = await call(list, 'GET', await key(ORG, null), { siteId: SITE });
    expect(owner.status).toBe(200);
    expect(owner.json.entries.some((entry: { read_only?: boolean }) => entry.read_only)).toBe(true);
    expect(owner.json.entries[0]).not.toHaveProperty('package');
    expect((await call(list, 'GET', await key(ORG, SITE), { siteId: SITE })).status).toBe(404);
    // The client's organization key reaches the site through an admin share, not the agency's collection.
    expect((await call(list, 'GET', await key(CLIENT, null), { siteId: SITE })).status).toBe(404);
  });
});

describe('members over the public API', () => {
  it('lists, changes and removes members as an administrator, and cannot make owners', async () => {
    const index = await import('../../pages/api/v1/organization/members') as unknown as Record<string, APIRoute>;
    const one = await import('../../pages/api/v1/organization/members/[memberId]') as unknown as Record<string, APIRoute>;
    const token = await key(ORG, null);
    const listed = await call(index, 'GET', token, {});
    expect(listed.json.members.map((member: { id: string }) => member.id)).toEqual(['anna', 'bo']);
    expect((await call(one, 'PATCH', token, { memberId: 'bo' }, { role: 'builder' })).json.member.role).toBe('builder');
    expect((await call(one, 'PATCH', token, { memberId: 'bo' }, { role: 'owner' })).status).toBe(403);
    expect((await call(one, 'PATCH', token, { memberId: 'anna' }, { role: 'admin' })).status).toBe(403);
    expect((await call(one, 'PATCH', token, { memberId: 'bo' }, { role: 'superuser' })).status).toBe(400);
    expect((await call(one, 'DELETE', token, { memberId: 'nobody' })).status).toBe(404);
    expect((await call(one, 'DELETE', token, { memberId: 'bo' })).json).toEqual({ removed: true, id: 'bo' });
    // A site-scoped key has no say over membership.
    expect((await call(index, 'GET', await key(ORG, SITE), {})).status).toBe(403);
  });

  it('creates invites with a role', async () => {
    const invites = await import('../../pages/api/v1/organization/invites') as unknown as Record<string, APIRoute>;
    const created = await call(invites, 'POST', await key(ORG, null), {}, { role: 'builder' });
    expect(created.status).toBe(201);
    expect(created.json.role).toBe('builder');
    expect((await call(invites, 'POST', await key(ORG, null), {}, { role: 'owner' })).status).toBe(400);
  });
});
