/**
 * Cross-tenant denial — the single most security-critical invariant in the
 * codebase. Without this, a user from org A could read/write sites under
 * org B by guessing the siteId.
 *
 * With no Firebase configured, getSession() returns the DEV_USER (orgId =
 * 'default'). We stage a site under 'evilorg' and check requireSiteAccess
 * refuses to surface it to a 'default'-org caller.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { paths } from '@typeroll/shared';

// Fake AstroCookies — getSession in our dev fallback only reads the
// session cookie; everything else is shrug-able.
const fakeCookies = {
  get: () => undefined,
} as unknown as Parameters<typeof import('../../lib/access').requireSiteAccess>[0];

describe('requireSiteAccess', () => {
  beforeEach(async () => {
    await resetDatastore();
  });

  it("returns 404 when the site lives under a different org than the caller's", async () => {
    makeTmpFixtures();
    await resetDatastore();
    const { getStore } = await import('../../lib/datastore');
    // Site owned by some other org, but with a guessable id.
    await getStore().setDoc(paths.site('evilorg', 'shared-id'), {
      name: 'Stolen', hosting_adapter: 'cloudflare',
    });

    const { requireSiteAccess } = await import('../../lib/access');
    const guard = await requireSiteAccess(fakeCookies, 'shared-id');
    expect(guard.ok).toBe(false);
    if (!guard.ok) {
      // Either Site-not-found (404) or Unauthorized — both are safe; what
      // matters is we don't return success with someone else's site.
      expect([401, 404]).toContain(guard.response.status);
    }
  });

  it('succeeds when the site is in the caller-orgs path', async () => {
    makeTmpFixtures();
    await resetDatastore();
    const { getStore } = await import('../../lib/datastore');
    // Mirror the DEV_USER orgId so the dev fallback session matches.
    await getStore().setDoc(paths.site('default', 'mysite'), {
      name: 'Mine', hosting_adapter: 'cloudflare',
    });

    const { requireSiteAccess } = await import('../../lib/access');
    const guard = await requireSiteAccess(fakeCookies, 'mysite');
    expect(guard.ok).toBe(true);
    if (guard.ok) {
      expect(guard.value.site.name).toBe('Mine');
      expect(guard.value.session.orgId).toBe('default');
    }
  });

  it('returns 400 when siteId is missing', async () => {
    makeTmpFixtures();
    await resetDatastore();
    const { requireSiteAccess } = await import('../../lib/access');
    const guard = await requireSiteAccess(fakeCookies, undefined);
    expect(guard.ok).toBe(false);
    if (!guard.ok) expect(guard.response.status).toBe(400);
  });
});
