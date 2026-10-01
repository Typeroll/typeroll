// Archiving is only worth having if it actually freezes the site. These
// assert the gate at every door a write can come through — a session, an API
// key, an extension installation — plus the one write that must still get
// through, because otherwise an archived site could never be restored.

import { describe, it, expect, beforeEach } from 'vitest';
import { isArchivedSite, ARCHIVED_SITE_MESSAGE } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';

const archived = { lifecycle: { status: 'archived' as const, archived_at: '2026-09-21T12:00:00Z', archived_by: 'u1' } };

function ctx(site: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return {
    session: { userId: 'u1', orgId: 'o' },
    site: { id: 's', ...site },
    versionId: 'main',
    permission: 'admin',
    owner_org_id: 'o',
    is_owner: true,
    ...over,
  } as never;
}

describe('isArchivedSite', () => {
  it('treats absence as active, so no existing site needs a migration', () => {
    expect(isArchivedSite(undefined)).toBe(false);
    expect(isArchivedSite(null)).toBe(false);
    expect(isArchivedSite({})).toBe(false);
  });

  it('treats a cleared lifecycle as active — restore writes null, not a deleted key', () => {
    expect(isArchivedSite({ lifecycle: null } as never)).toBe(false);
  });

  it('reads the archived state', () => {
    expect(isArchivedSite(archived)).toBe(true);
  });
});

describe('requirePermission on an archived site', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
  });

  it('refuses writes with 409, not 403 — the caller has the authority, the site does not accept it', async () => {
    const { requirePermission } = await import('../../lib/access');
    const result = requirePermission(ctx(archived), 'write');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(409);
    expect(await result.response.json()).toEqual({ error: ARCHIVED_SITE_MESSAGE });
  });

  it('refuses admin writes too, which is what stops a publish', async () => {
    const { requirePermission } = await import('../../lib/access');
    expect(requirePermission(ctx(archived), 'admin').ok).toBe(false);
  });

  it('still allows reads, so an archived site stays inspectable', async () => {
    const { requirePermission } = await import('../../lib/access');
    expect(requirePermission(ctx(archived), 'read').ok).toBe(true);
  });

  it('leaves an active site alone', async () => {
    const { requirePermission } = await import('../../lib/access');
    expect(requirePermission(ctx({}), 'admin').ok).toBe(true);
  });

  it('reports insufficient permission ahead of the archived state', async () => {
    // A read-only share on an archived site should hear about its permission,
    // not be told the site is archived — that would leak the lifecycle of a
    // site the caller cannot write to anyway.
    const { requirePermission } = await import('../../lib/access');
    const result = requirePermission(ctx(archived, { permission: 'read' }), 'write');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(403);
  });
});

describe('requireSiteLifecycleChange', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
  });

  it('passes for an owner-org admin on an archived site, or restore would be impossible', async () => {
    const { requireSiteLifecycleChange } = await import('../../lib/access');
    expect(requireSiteLifecycleChange(ctx(archived)).ok).toBe(true);
  });

  it('refuses a cross-org share however privileged', async () => {
    const { requireSiteLifecycleChange } = await import('../../lib/access');
    const result = requireSiteLifecycleChange(ctx({}, { is_owner: false, permission: 'admin' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(403);
  });

  it('refuses an owner-org member below admin', async () => {
    const { requireSiteLifecycleChange } = await import('../../lib/access');
    expect(requireSiteLifecycleChange(ctx({}, { permission: 'write' })).ok).toBe(false);
  });
});

describe('POST /api/sites/{siteId}/lifecycle (portal session)', () => {
  // Runs as the development session (org `default`, user `dev-user`). The
  // rules are shared with the v1 route through lib/site-lifecycle.ts.
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
  });

  async function post(body: Record<string, unknown> | FormData) {
    const { POST } = await import('../../pages/api/sites/[siteId]/lifecycle');
    const request = body instanceof FormData
      ? new Request('http://localhost/api/sites/s/lifecycle', { method: 'POST', body })
      : new Request('http://localhost/api/sites/s/lifecycle', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
    return POST({ request, params: { siteId: 's' }, cookies: { get: () => undefined } as never, locals: {} as never } as never) as Promise<Response>;
  }

  it('archives from the settings form with the user as actor, then restores', async () => {
    const { getStore } = await import('../../lib/datastore');
    const { paths } = await import('@typeroll/shared');
    await getStore().setDoc(paths.site('default', 's'), { name: 'S', created_at: '2026-01-01T00:00:00Z' });
    const form = new FormData();
    form.set('action', 'archive');
    form.set('reason', 'Done');
    const archivedRes = await post(form);
    expect(archivedRes.status).toBe(200);
    const doc = await getStore().getDoc<{ lifecycle?: { archived_by: string; reason?: string } }>(paths.site('default', 's'));
    expect(doc?.lifecycle?.archived_by).toBe('dev-user');
    expect(doc?.lifecycle?.reason).toBe('Done');

    const restored = await post({ action: 'restore' });
    expect(await restored.json()).toEqual({ status: 'active', site: 's' });
  });

  it('rejects an unknown action', async () => {
    const { getStore } = await import('../../lib/datastore');
    const { paths } = await import('@typeroll/shared');
    await getStore().setDoc(paths.site('default', 's'), { name: 'S', created_at: '2026-01-01T00:00:00Z' });
    expect((await post({ action: 'destroy' })).status).toBe(400);
  });
});
