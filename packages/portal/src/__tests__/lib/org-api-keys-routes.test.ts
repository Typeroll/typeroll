// /api/orgs/api-keys: an organization API key acts as admin over every owned
// and shared-in site and over organization connections. Only organization
// owners and admins may list, mint or revoke them, including in organizations
// that have not opted into role enforcement (where requireOrgAdmin treats
// every member as admin).
//
// The cookie-less dev session is `dev-user` in organization `default`.

import { beforeEach, describe, expect, it } from 'vitest';
import type { APIRoute } from 'astro';
import { paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';

const ORG = 'default';
const cookies = { get: () => undefined, set: () => {}, delete: () => {} } as never;

async function seedRole(role: string, enforced = false): Promise<void> {
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.org(ORG), { name: 'Default', roles_enforced: enforced });
  await getStore().setDoc(`${paths.members(ORG)}/dev-user`, { role });
}

async function call(route: APIRoute, method: string, body?: unknown, params: Record<string, string> = {}): Promise<Response> {
  const request = new Request('https://portal.test/api/orgs/api-keys', {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return await route({ request, cookies, params, locals: {} } as never) as Response;
}

const routes = async () => ({
  ...(await import('../../pages/api/orgs/api-keys/index')),
  DELETE: (await import('../../pages/api/orgs/api-keys/[prefix]')).DELETE,
});

beforeEach(async () => {
  makeTmpFixtures();
  await resetDatastore();
});

describe('organization API key routes', () => {
  it('refuses an editor even when the organization does not enforce roles', async () => {
    await seedRole('editor', false);
    const { GET, POST, DELETE } = await routes();
    expect((await call(POST!, 'POST', { name: 'escalate' })).status).toBe(403);
    expect((await call(GET!, 'GET')).status).toBe(403);
    expect((await call(DELETE!, 'DELETE', undefined, { prefix: 'tr_abc' })).status).toBe(403);
    const { listApiKeys } = await import('../../lib/api-keys');
    expect(await listApiKeys(ORG, null)).toEqual([]);
  });

  it('refuses a member without a member record', async () => {
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(paths.org(ORG), { name: 'Default' });
    const { POST } = await routes();
    expect((await call(POST!, 'POST', { name: 'escalate' })).status).toBe(403);
  });

  it.each(['owner', 'admin'])('lets an organization %s mint, list and revoke keys', async (role) => {
    await seedRole(role);
    const { GET, POST, DELETE } = await routes();
    const created = await call(POST!, 'POST', { name: 'ci' });
    expect(created.status).toBe(200);
    const listed = await (await call(GET!, 'GET')).json() as { keys: Array<{ id: string }> };
    expect(listed.keys).toHaveLength(1);
    expect((await call(DELETE!, 'DELETE', undefined, { prefix: listed.keys[0].id })).status).toBe(200);
  });
});
