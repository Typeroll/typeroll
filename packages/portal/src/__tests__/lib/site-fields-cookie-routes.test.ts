// The portal's session routes for the settings pages: the owner's tree is
// used (owner_org_id, not the session's org), definitions need admin, values
// need write or admin by group access, and they share the v1 save path.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { APIRoute } from 'astro';

const OWNER = 'ownerorg';
const VIEWER = 'partnerorg';
const SITE = 'mysite';
let permission: 'read' | 'write' | 'admin' = 'admin';

beforeEach(async () => {
  makeTmpFixtures();
  await resetDatastore();
  vi.resetModules();
  permission = 'admin';
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

type Method = 'GET' | 'PUT' | 'PATCH' | 'POST';
async function call(route: string, method: Method, body?: unknown): Promise<Response> {
  const mod = (await import(/* @vite-ignore */ `../../pages/api/sites/[siteId]/site-fields/${route}`)) as Partial<Record<string, APIRoute>>;
  const request = new Request(`http://localhost/api/sites/${SITE}/site-fields`, {
    method, headers: { 'content-type': 'application/json' }, body: body != null ? JSON.stringify(body) : undefined,
  });
  return mod[method]!({ request, params: { siteId: SITE }, cookies: { get: () => undefined }, locals: {} } as never) as Promise<Response>;
}

const groups = [
  { id: 'booking', label: 'Booking', fields: [{ name: 'show_booking', type: 'boolean', label: 'Show the booking calendar' }] },
  { id: 'company', label: 'Company', access: 'admin', fields: [{ name: 'org_number', type: 'text', label: 'Organization number' }] },
];

describe('site fields session routes', () => {
  it('defines, fills in and restores in the owner organization', async () => {
    const defined = await call('index', 'PUT', { groups, expected_updated_at: null });
    expect(defined.status).toBe(200);
    const { updated_at } = await defined.json() as { updated_at: string };
    const { getStore } = await import('../../lib/datastore');
    expect(await getStore().getDoc(paths.siteFields(OWNER, SITE, MAIN_VERSION_ID))).not.toBeNull();
    expect(await getStore().getDoc(paths.siteFields(VIEWER, SITE, MAIN_VERSION_ID))).toBeNull();

    const saved = await call('index', 'PATCH', { values: { show_booking: true, org_number: '556677-8899' }, expected_updated_at: updated_at });
    expect(saved.status).toBe(200);
    expect((await saved.json() as { values: Record<string, unknown> }).values).toEqual({ show_booking: true, org_number: '556677-8899' });
    const invalid = await call('index', 'PATCH', { values: { show_booking: 'yes' } });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: 'The values are not valid: show_booking: true or false expected', errors: [{ path: 'show_booking', message: 'true or false expected' }] });

    const { revisions } = await (await call('revisions', 'GET')).json() as { revisions: Array<{ id: string; created_by: string }> };
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.created_by).toBe('editor@example.com');
    expect((await call('revisions', 'POST', { revId: revisions[0]!.id })).status).toBe(200);
    expect((await (await call('index', 'GET')).json() as { values: Record<string, unknown> }).values).toEqual({});
  });

  it('lets an editor change only editor pages and never the definitions', async () => {
    await call('index', 'PUT', { groups });
    permission = 'write';
    expect((await call('index', 'PUT', { groups: [] })).status).toBe(403);
    expect((await call('revisions', 'POST', { revId: 'x' })).status).toBe(403);
    expect((await (await call('index', 'GET')).json() as { editable_groups: string[] }).editable_groups).toEqual(['booking']);
    expect((await call('index', 'PATCH', { values: { org_number: '1' } })).status).toBe(403);
    expect((await call('index', 'PATCH', { values: { show_booking: false } })).status).toBe(200);
    permission = 'read';
    expect((await call('index', 'PATCH', { values: { show_booking: true } })).status).toBe(403);
    expect((await call('index', 'GET')).status).toBe(200);
  });
});
