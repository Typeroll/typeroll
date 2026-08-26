/**
 * Role enforcement. `MemberRole` sat on the Member doc unread since orgs
 * shipped — every member of an owning org resolved to `permission: 'admin'`.
 * These tests pin both halves of making it real: the opt-in switch that keeps
 * existing orgs on their current behaviour, and the actual demotion once an
 * org turns it on.
 *
 * The dev session (no Firebase configured) is userId 'dev-user', orgId
 * 'default' — so seeding a member doc at that id is what puts a role on the
 * caller.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { paths } from '@typeroll/shared';
import type { MemberRole } from '@typeroll/shared';

const fakeCookies = {
  get: () => undefined,
} as unknown as Parameters<typeof import('../../lib/access').requireSiteAccess>[0];

const DEV_ORG = 'default';
const DEV_USER = 'dev-user';

async function seed(opts: { rolesEnforced?: boolean; role?: MemberRole; withSite?: boolean }) {
  const { getStore } = await import('../../lib/datastore');
  const store = getStore();
  await store.setDoc(paths.org(DEV_ORG), {
    name: 'Dev Org',
    slug: DEV_ORG,
    plan: 'free',
    created_at: new Date().toISOString(),
    ...(opts.rolesEnforced ? { roles_enforced: true } : {}),
  });
  if (opts.role) {
    await store.setDoc(`${paths.members(DEV_ORG)}/${DEV_USER}`, {
      email: 'dev@typeroll.local',
      role: opts.role,
      firebase_uid: DEV_USER,
      joined_at: new Date().toISOString(),
    });
  }
  if (opts.withSite !== false) {
    await store.setDoc(paths.site(DEV_ORG, 'mysite'), {
      name: 'Mine',
      hosting_adapter: 'cloudflare',
    });
  }
}

describe('resolveOwnerOrgAccess', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
  });

  it('returns admin when the org has no doc at all (fixtures / fresh install)', async () => {
    const { resolveOwnerOrgAccess } = await import('../../lib/member-role');
    const access = await resolveOwnerOrgAccess(DEV_ORG, DEV_USER);
    expect(access.permission).toBe('admin');
    expect(access.role).toBeUndefined();
  });

  it('leaves an editor at admin while enforcement is off — the back-compat guarantee', async () => {
    await seed({ role: 'editor' });
    const { resolveOwnerOrgAccess } = await import('../../lib/member-role');
    const access = await resolveOwnerOrgAccess(DEV_ORG, DEV_USER);
    // The role is on the doc and deliberately ignored: turning enforcement on
    // globally would demote every invited member the moment this deployed.
    expect(access.permission).toBe('admin');
  });

  it('demotes an editor to write once the org opts in', async () => {
    await seed({ rolesEnforced: true, role: 'editor' });
    const { resolveOwnerOrgAccess } = await import('../../lib/member-role');
    const access = await resolveOwnerOrgAccess(DEV_ORG, DEV_USER);
    expect(access.permission).toBe('write');
    expect(access.role).toBe('editor');
  });

  it.each([['owner'], ['admin']] as const)('keeps %s at admin under enforcement', async (role) => {
    await seed({ rolesEnforced: true, role });
    const { resolveOwnerOrgAccess } = await import('../../lib/member-role');
    expect((await resolveOwnerOrgAccess(DEV_ORG, DEV_USER)).permission).toBe('admin');
  });

  it('fails closed to read when enforcement is on but no member doc exists', async () => {
    await seed({ rolesEnforced: true });
    const { resolveOwnerOrgAccess } = await import('../../lib/member-role');
    expect((await resolveOwnerOrgAccess(DEV_ORG, DEV_USER)).permission).toBe('read');
  });

  it('fails closed to read on an unrecognised role value', async () => {
    await seed({ rolesEnforced: true, role: 'wizard' as MemberRole });
    const { resolveOwnerOrgAccess } = await import('../../lib/member-role');
    expect((await resolveOwnerOrgAccess(DEV_ORG, DEV_USER)).permission).toBe('read');
  });
});

describe('requireSiteAccess reports the role-derived permission', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
  });

  it('gives an editor write, not admin, on an owned site under enforcement', async () => {
    await seed({ rolesEnforced: true, role: 'editor' });
    const { requireSiteAccess, requirePermission } = await import('../../lib/access');
    const guard = await requireSiteAccess(fakeCookies, 'mysite');
    expect(guard.ok).toBe(true);
    if (!guard.ok) return;

    expect(guard.value.permission).toBe('write');
    expect(guard.value.role).toBe('editor');
    // Content editing still works…
    expect(requirePermission(guard.value, 'write').ok).toBe(true);
    // …but every admin-gated route (settings, api-keys, shares, domain,
    // versions, apps, deploy, export) now refuses.
    const admin = requirePermission(guard.value, 'admin');
    expect(admin.ok).toBe(false);
    if (!admin.ok) expect(admin.response.status).toBe(403);
  });

  it('still gives an editor admin when the org has not opted in', async () => {
    await seed({ role: 'editor' });
    const { requireSiteAccess, requirePermission } = await import('../../lib/access');
    const guard = await requireSiteAccess(fakeCookies, 'mysite');
    expect(guard.ok).toBe(true);
    if (!guard.ok) return;
    expect(guard.value.permission).toBe('admin');
    expect(requirePermission(guard.value, 'admin').ok).toBe(true);
  });

  it('does not consult roles for a shared-in site — the share grant decides', async () => {
    // Enforcement on, and the caller is a mere editor in their OWN org. A
    // site shared in with 'admin' must still resolve to admin: the grant is
    // an explicit cross-org act that doesn't read the recipient's internal
    // roles. Regression guard against wiring resolveOwnerOrgAccess into the
    // share branch too.
    await seed({ rolesEnforced: true, role: 'editor', withSite: false });
    const { getStore } = await import('../../lib/datastore');
    const store = getStore();
    await store.setDoc(paths.site('otherorg', 'theirsite'), {
      name: 'Theirs',
      hosting_adapter: 'cloudflare',
    });
    const share = {
      site_id: 'theirsite',
      owner_org_id: 'otherorg',
      shared_with_org_id: DEV_ORG,
      permission: 'admin' as const,
      created_at: Date.now(),
      created_by: 'owner@otherorg.test',
    };
    await store.setDoc(paths.share('otherorg', 'theirsite', 's1'), share);
    await store.setDoc(paths.sharesWithOrgEntry(DEV_ORG, 's1'), share);

    const { requireSiteAccess } = await import('../../lib/access');
    const guard = await requireSiteAccess(fakeCookies, 'theirsite');
    expect(guard.ok).toBe(true);
    if (!guard.ok) return;
    expect(guard.value.permission).toBe('admin');
    expect(guard.value.role).toBeUndefined();
    expect(guard.value.owner_org_id).toBe('otherorg');
  });
});

describe('requireOrgAdmin', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
  });

  it('blocks an editor from minting an org-scoped API key', async () => {
    // An org-scoped key carries admin over every owned + shared-in site, so
    // leaving this route at requireFullSession let an editor route around the
    // site-level role check entirely.
    await seed({ rolesEnforced: true, role: 'editor', withSite: false });
    const { requireOrgAdmin } = await import('../../lib/access');
    const result = await requireOrgAdmin({
      userId: DEV_USER,
      email: 'dev@typeroll.local',
      orgId: DEV_ORG,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  it('allows an admin through', async () => {
    await seed({ rolesEnforced: true, role: 'admin', withSite: false });
    const { requireOrgAdmin } = await import('../../lib/access');
    const result = await requireOrgAdmin({
      userId: DEV_USER,
      email: 'dev@typeroll.local',
      orgId: DEV_ORG,
    });
    expect(result.ok).toBe(true);
  });
});
