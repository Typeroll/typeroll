// Site fields over the v1 API: definitions (site admin), values per group
// access, revision checks, validation errors with paths, revisions and
// restore, per-version storage, branch diff, promote and reset.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, openingHoursField, paths } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import type { Site, SiteShare, SiteVersion } from '@typeroll/shared';

const ORG = 'ownerorg';
const PARTNER = 'partnerorg';
const READER = 'readerorg';
const SITE = 'mysite';
const BRANCH = 'feature';
let adminToken = '';
let writeToken = '';
let readToken = '';

async function setup(): Promise<void> {
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  const store = getStore();
  await store.setDoc(paths.site(ORG, SITE), { name: 'My Site', created_at: new Date().toISOString() } satisfies Partial<Site>);
  await store.setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
    name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false,
  } satisfies Partial<SiteVersion>);
  await store.setDoc(paths.version(ORG, SITE, BRANCH), {
    name: 'Feature', kind: 'branch', base_version_id: MAIN_VERSION_ID, created_at: new Date().toISOString(), robots_blocked: true,
  } satisfies Partial<SiteVersion>);
  const { writeShare } = await import('../../lib/shares');
  for (const [id, org, permission] of [['share-w', PARTNER, 'write'], ['share-r', READER, 'read']] as const) {
    await writeShare({ id, site_id: SITE, owner_org_id: ORG, shared_with_org_id: org, permission, created_at: Date.now(), created_by: 'owner@example.com' } satisfies SiteShare);
  }
  const { createApiKey } = await import('../../lib/api-keys');
  adminToken = (await createApiKey({ orgId: ORG, siteId: SITE, name: 'admin', createdBy: 'admin' })).token;
  writeToken = (await createApiKey({ orgId: PARTNER, siteId: null, name: 'partner', createdBy: 'partner' })).token;
  readToken = (await createApiKey({ orgId: READER, siteId: null, name: 'reader', createdBy: 'reader' })).token;
}

type Method = 'GET' | 'PUT' | 'PATCH' | 'POST';
async function call(route: string, method: Method, url: string, body?: unknown, token = adminToken, params: Record<string, string> = {}): Promise<Response> {
  const mod = (await import(/* @vite-ignore */ `../../pages/api/v1/sites/[siteId]/site-fields/${route}`)) as Partial<Record<string, APIRoute>>;
  const req = new Request(`http://localhost/api/v1/sites/${SITE}/site-fields${url}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  return mod[method]!({ request: req, params: { siteId: SITE, ...params }, cookies: { get: () => undefined }, locals: {} } as never) as Promise<Response>;
}

interface Doc { groups: Array<{ id: string; fields: Array<{ name: string }> }>; values: Record<string, unknown>; updated_at: string | null; editable_groups: string[]; dropped_values?: string[] }
const q = (version?: string) => (version ? `?version=${version}` : '');
const read = async (token = adminToken, version?: string) => (await call('index', 'GET', q(version), undefined, token)).json() as Promise<Doc>;
const define = (body: unknown, token = adminToken, version?: string) => call('index', 'PUT', q(version), body, token);
const patch = (body: unknown, token = adminToken, version?: string) => call('index', 'PATCH', q(version), body, token);

const groups = [
  { id: 'booking', label: 'Booking', fields: [
    { name: 'show_booking', type: 'boolean', label: 'Show the booking calendar' },
    { name: 'delivery_days', type: 'number', label: 'Delivery days right now', min: 0 },
    { name: 'kind', type: 'select', label: 'Kind', options: ['a', 'b'] },
  ] },
  { id: 'company', label: 'Company', access: 'admin', fields: [
    { name: 'visiting_address', type: 'textarea', label: 'Visiting address', required: true },
    openingHoursField(),
  ] },
];

describe('site fields over the v1 API', () => {
  beforeEach(async () => { await setup(); });

  it('starts empty and lets an admin define settings pages with a revision check', async () => {
    expect(await read()).toEqual({ groups: [], values: {}, updated_at: null, editable_groups: [] });

    const invalid = await define({ groups: [{ id: 'Bad id', label: '', fields: [{ name: 'x', type: 'select', label: 'X' }] }] });
    expect(invalid.status).toBe(400);
    const refused = await invalid.json() as { error: string; errors: Array<{ path: string; message: string }> };
    expect(refused.errors.map((e) => e.path)).toEqual(['groups[0].id', 'groups[0].label', 'groups[0].fields[0].options']);

    expect((await define({ groups }, writeToken)).status).toBe(403);
    const first = await define({ groups, expected_updated_at: '' });
    expect(first.status).toBe(200);
    const saved = await first.json() as Doc;
    expect(saved.updated_at).toEqual(expect.any(String));
    expect(saved.groups.map((group) => group.id)).toEqual(['booking', 'company']);
    expect(saved.editable_groups).toEqual(['booking', 'company']);

    // A second save based on the empty document is stale.
    expect((await define({ groups, expected_updated_at: '' })).status).toBe(409);
    expect((await define({ groups, expected_updated_at: saved.updated_at })).status).toBe(200);
  });

  it('changes values by group access: editors fill editor pages, admins every page', async () => {
    const { updated_at } = await (await define({ groups })).json() as Doc;
    expect((await read(writeToken)).editable_groups).toEqual(['booking']);
    expect((await read(readToken)).editable_groups).toEqual([]);

    expect((await patch({ values: { show_booking: true } }, readToken)).status).toBe(403);
    const adminOnly = await patch({ values: { visiting_address: 'Storgatan 1' } }, writeToken);
    expect(adminOnly.status).toBe(403);
    expect((await adminOnly.json() as { error: string }).error).toContain('visiting_address');

    const edited = await patch({ values: { show_booking: true, delivery_days: '3' }, expected_updated_at: updated_at }, writeToken);
    expect(edited.status).toBe(200);
    const after = await edited.json() as Doc;
    expect(after.values).toEqual({ show_booking: true, delivery_days: 3 });
    expect(after.updated_at).not.toBe(updated_at);
    expect((await patch({ values: { show_booking: false }, expected_updated_at: updated_at }, writeToken)).status).toBe(409);

    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((day, i) => (i < 5 ? { day, opens: '09:00', closes: '17:00' } : { day, closed: true }));
    const hours = { days, exceptions: [{ date: '2026-12-24', closed: true, note: 'Christmas Eve' }] };
    const admin = await patch({ values: { visiting_address: 'Storgatan 1', opening_hours: hours } });
    expect(admin.status).toBe(200);
    expect((await admin.json() as Doc).values).toMatchObject({ show_booking: true, delivery_days: 3, visiting_address: 'Storgatan 1', opening_hours: hours });

    // null removes a value; a required one cannot be removed.
    expect((await (await patch({ values: { delivery_days: null } })).json() as Doc).values).not.toHaveProperty('delivery_days');
    const required = await patch({ values: { visiting_address: null } });
    expect(required.status).toBe(400);
    expect((await required.json() as { errors: Array<{ path: string }> }).errors).toEqual([{ path: 'visiting_address', message: 'Visiting address is required' }]);
  });

  it('reports invalid and unknown values with their paths and saves nothing', async () => {
    await define({ groups });
    const res = await patch({ values: { delivery_days: 'soon', kind: 'c', nope: 1, opening_hours: { exceptions: [{ closed: true }] } } });
    expect(res.status).toBe(400);
    const body = await res.json() as { errors: Array<{ path: string }> };
    expect(body.errors.map((e) => e.path)).toEqual(['nope']);
    const typed = await patch({ values: { delivery_days: 'soon', kind: 'c', opening_hours: { exceptions: [{ closed: true }] } } });
    expect((await typed.json() as { errors: Array<{ path: string }> }).errors.map((e) => e.path).sort())
      .toEqual(['delivery_days', 'kind', 'opening_hours.exceptions[0].date']);
    expect((await read()).values).toEqual({});
    expect((await patch({ groups })).status).toBe(400);
    expect((await patch({ values: [] })).status).toBe(400);
  });

  it('drops the values of removed or retyped fields when the definitions change', async () => {
    await define({ groups });
    await patch({ values: { show_booking: true, delivery_days: 4, kind: 'a', visiting_address: 'Storgatan 1' } });
    const next = [
      { id: 'booking', label: 'Booking', fields: [
        { name: 'show_booking', type: 'boolean', label: 'Show the booking calendar' },
        { name: 'kind', type: 'select', label: 'Kind', options: ['b'] },
      ] },
      { id: 'company', label: 'Company', access: 'admin', fields: [{ name: 'visiting_address', type: 'number', label: 'Now a number' }] },
    ];
    const res = await define({ groups: next });
    const body = await res.json() as Doc;
    expect(body.values).toEqual({ show_booking: true });
    expect(body.dropped_values).toEqual(['delivery_days', 'kind', 'visiting_address']);
  });

  it('keeps every save as a revision and restores one', async () => {
    await define({ groups });
    await patch({ values: { delivery_days: 1 } });
    await patch({ values: { delivery_days: 2 } });
    const listed = await (await call('revisions/index', 'GET', '/revisions')).json() as { revisions: Array<{ id: string; value_count: number; group_count: number }>; total: number };
    expect(listed.total).toBe(2);
    const oldest = listed.revisions[1]!;
    expect(oldest).toMatchObject({ group_count: 2, value_count: 0 });

    expect((await call('revisions/[revId]/restore', 'POST', `/revisions/${oldest.id}/restore`, {}, writeToken, { revId: oldest.id })).status).toBe(403);
    expect((await call('revisions/[revId]/restore', 'POST', '/revisions/missing/restore', {}, adminToken, { revId: 'missing' })).status).toBe(404);
    const restored = await call('revisions/[revId]/restore', 'POST', `/revisions/${oldest.id}/restore`, {}, adminToken, { revId: oldest.id });
    expect(restored.status).toBe(200);
    expect((await restored.json() as Doc).values).toEqual({});
    expect(((await (await call('revisions/index', 'GET', '/revisions')).json()) as { total: number }).total).toBe(3);
  });

  it('stores site fields per version; a branch diff, promote and reset include them', async () => {
    await define({ groups });
    await patch({ values: { delivery_days: 1 } });
    // The branch inherits main until it saves its own.
    expect((await read(adminToken, BRANCH)).values).toEqual({ delivery_days: 1 });
    await patch({ values: { delivery_days: 7 } }, adminToken, BRANCH);
    expect((await read(adminToken, BRANCH)).values).toEqual({ delivery_days: 7 });
    expect((await read()).values).toEqual({ delivery_days: 1 });

    const { diffVersion, promoteBranch, resetBranch } = await import('../../lib/version-promote');
    const diff = await diffVersion(ORG, SITE, BRANCH);
    expect(diff.siteFields).toBe('modified');
    expect(diff.totalChanges).toBe(1);
    await promoteBranch(ORG, SITE, BRANCH);
    expect((await read()).values).toEqual({ delivery_days: 7 });
    // Main kept what it had as a revision.
    const { listRevisions } = await import('../../lib/revisions');
    const history = await listRevisions({ orgId: ORG, siteId: SITE, versionId: MAIN_VERSION_ID, kind: 'site_fields', resourceIds: ['default'] });
    expect(history[0]!.note).toBe(`Promoted from branch "${BRANCH}"`);

    await patch({ values: { delivery_days: 9 } }, adminToken, BRANCH);
    await resetBranch(ORG, SITE, BRANCH);
    expect((await diffVersion(ORG, SITE, BRANCH)).siteFields).toBe('unchanged');
    expect((await read(adminToken, BRANCH)).values).toEqual({ delivery_days: 7 });
  });
});
