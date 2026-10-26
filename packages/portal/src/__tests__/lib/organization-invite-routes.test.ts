// /api/orgs/invite: only organization owners and admins can create, list or
// revoke invites (also without role enforcement, where every member counts
// as admin for requireOrgAdmin). A revoked invite stops working at once.
//
// The cookie-less dev session is `dev-user` in organization `default`.

import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import type { APIRoute } from 'astro';
import { paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';

const ORG = 'default';
const cookies = { get: () => undefined, set: vi.fn(), delete: vi.fn() } as never;

async function seedRole(role: string): Promise<void> {
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.org(ORG), { name: 'Default' });
  await getStore().setDoc(`${paths.members(ORG)}/dev-user`, { role });
}

async function call(route: APIRoute, method: string, body?: unknown, params: Record<string, string> = {}) {
  const request = new Request('https://portal.test/api/orgs/invite', {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await route({ request, cookies, params, locals: {} } as never) as Response;
  return { status: response.status, json: await response.json() as any };
}

const generate = async () => (await import('../../pages/api/orgs/invite/generate')).POST!;
const list = async () => (await import('../../pages/api/orgs/invite/index')).GET!;
const revoke = async () => (await import('../../pages/api/orgs/invite/[inviteId]')).DELETE!;

beforeEach(async () => {
  makeTmpFixtures();
  await resetDatastore();
  vi.stubEnv('PORTAL_PUBLIC_URL', 'https://portal.test');
});
afterEach(() => vi.unstubAllEnvs());

describe('organization invite routes', () => {
  it('refuses an editor of an organization without role enforcement', async () => {
    await seedRole('editor');
    expect((await call(await generate(), 'POST', {})).status).toBe(403);
    expect((await call(await list(), 'GET')).status).toBe(403);
    expect((await call(await revoke(), 'DELETE', undefined, { inviteId: 'AAAAAAAAAAAAAAAAAAAAAA' })).status).toBe(403);
    const { getStore } = await import('../../lib/datastore');
    expect(await getStore().listDocs(`organizations/${ORG}/invites`)).toEqual([]);
  });

  it('lets an admin create a single-use invite, list it and revoke it', async () => {
    await seedRole('admin');
    const created = await call(await generate(), 'POST', { ttlDays: 3 });
    expect(created.status).toBe(200);
    expect(created.json).toMatchObject({ maxUses: 1, email: null });
    expect(created.json.inviteUrl).toMatch(/^https:\/\/portal\.test\/onboarding\?invite=/);

    const listed = await call(await list(), 'GET');
    expect(listed.json.invites).toEqual([expect.objectContaining({ id: created.json.inviteId, state: 'active' })]);

    expect((await call(await revoke(), 'DELETE', undefined, { inviteId: created.json.inviteId })).status).toBe(200);
    expect((await call(await list(), 'GET')).json.invites[0].state).toBe('revoked');
    expect((await call(await revoke(), 'DELETE', undefined, { inviteId: 'BBBBBBBBBBBBBBBBBBBBBB' })).status).toBe(404);
  });

  it('validates max_uses and email', async () => {
    await seedRole('owner');
    expect((await call(await generate(), 'POST', { max_uses: 0 })).status).toBe(400);
    expect((await call(await generate(), 'POST', { email: 'not-an-email' })).status).toBe(400);
    const ok = await call(await generate(), 'POST', { max_uses: 5, email: 'New@Example.com' });
    expect(ok.json).toMatchObject({ maxUses: 5, email: 'new@example.com' });
  });
});
