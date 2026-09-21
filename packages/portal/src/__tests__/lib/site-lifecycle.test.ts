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
