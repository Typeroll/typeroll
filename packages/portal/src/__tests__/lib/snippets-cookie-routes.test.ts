// The portal's session routes for live snippets: the owner's tree is used
// (owner_org_id, not the session's org), editors may write, readers only
// read, and they share the v1 save path. Without media storage the save
// stands and says the content changes at the next publication.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { APIRoute } from 'astro';

const OWNER = 'ownerorg';
const VIEWER = 'partnerorg';
const SITE = 'mysite';
let permission: 'read' | 'write' | 'admin' = 'write';

beforeEach(async () => {
  makeTmpFixtures();
  await resetDatastore();
  vi.resetModules();
  permission = 'write';
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(OWNER, SITE), { name: 'My Site', created_at: '' });
  vi.doMock('../../lib/access', async () => {
    const actual = await vi.importActual<typeof import('../../lib/access')>('../../lib/access');
    return {
      ...actual,
      requireSiteAccess: vi.fn(async () => ({
        ok: true as const,
        value: {
          session: { orgId: VIEWER, userId: 'u1', email: 'editor@example.com' },
          site: { id: SITE, name: 'My Site', hosting_adapter: 'cloudflare', status: 'live', created_at: '' },
          versionId: MAIN_VERSION_ID, owner_org_id: OWNER, permission,
        },
      })),
    };
  });
});

type Method = 'GET' | 'PUT' | 'POST' | 'DELETE';
async function call(method: Method, id?: string, body?: unknown): Promise<Response> {
  const mod = (await import(/* @vite-ignore */ `../../pages/api/sites/[siteId]/snippets/${id ? '[snippetId]' : 'index'}`)) as Partial<Record<string, APIRoute>>;
  const request = new Request(`http://localhost/api/sites/${SITE}/snippets${id ? `/${id}` : ''}`, {
    method, headers: { 'content-type': 'application/json' }, body: body != null ? JSON.stringify(body) : undefined,
  });
  return mod[method]!({ request, params: { siteId: SITE, ...(id ? { snippetId: id } : {}) }, cookies: { get: () => undefined }, locals: {} } as never) as Promise<Response>;
}

describe('snippet session routes', () => {
  it('creates, replaces and deletes in the owner organization as the editor', async () => {
    const created = await call('POST', undefined, { name: 'Today\'s notice', kind: 'text', content: 'Closed today' });
    expect(created.status).toBe(201);
    const body = await created.json() as { snippet: { id: string; updated_by: string; updated_at: string }; live: { published: boolean; reason: string } };
    expect(body.snippet).toMatchObject({ id: 'today-s-notice', updated_by: 'editor@example.com' });
    expect(body.live).toMatchObject({ published: false, reason: expect.stringContaining('next publication') });
    const { getStore } = await import('../../lib/datastore');
    expect(await getStore().getDoc(paths.snippet(OWNER, SITE, 'today-s-notice'))).not.toBeNull();
    expect(await getStore().getDoc(paths.snippet(VIEWER, SITE, 'today-s-notice'))).toBeNull();

    const replaced = await call('PUT', 'today-s-notice', { name: 'Notice', kind: 'text', content: 'Open', expected_updated_at: body.snippet.updated_at });
    expect(replaced.status).toBe(200);
    expect((await call('PUT', 'today-s-notice', { name: 'Notice', kind: 'text', content: 'x', expected_updated_at: body.snippet.updated_at })).status).toBe(409);
    const list = await (await call('GET')).json() as { snippets: Array<{ content: string }>; live: { base_url: null }; can_edit: boolean };
    expect(list).toMatchObject({ snippets: [{ content: 'Open' }], live: { base_url: null }, can_edit: true });
    expect((await call('DELETE', 'today-s-notice')).status).toBe(200);
    expect((await call('GET', 'today-s-notice')).status).toBe(404);
  });

  it('lets a reader read but not write', async () => {
    permission = 'read';
    expect((await call('GET')).status).toBe(200);
    expect((await call('POST', undefined, { name: 'X', kind: 'text', content: 'x' })).status).toBe(403);
    expect((await call('PUT', 'x', { name: 'X', kind: 'text', content: 'x' })).status).toBe(403);
    expect((await call('DELETE', 'x')).status).toBe(403);
  });
});
