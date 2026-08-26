/**
 * One-time edit links.
 *
 * The design choice under test: stored grants rather than invite.ts's
 * stateless tokens. An invite goes to someone you chose; an edit link goes to
 * an address scraped out of a registry, and mail gets forwarded. Storing the
 * grant buys revocation, audit, and "already used" — the properties a
 * stateless token cannot have at any TTL.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { paths } from '@typeroll/shared';
import type { EditGrant } from '@typeroll/shared';

const ORG = 'default';
const SITE = 'dir';

async function setup() {
  makeTmpFixtures();
  await resetDatastore();
  process.env.FORMS_HMAC_SECRET = 'y'.repeat(48);
}

const issue = async (over: Partial<Parameters<typeof import('../../lib/edit-grants').issueGrant>[0]> = {}) => {
  const { issueGrant } = await import('../../lib/edit-grants');
  return issueGrant({
    orgId: ORG, siteId: SITE, collection: 'companies', itemId: 'c1',
    email: 'biz@example.com', ...over,
  });
};

describe('token signing', () => {
  beforeEach(setup);

  it('round-trips org, site and grant id', async () => {
    const { buildGrantToken, parseGrantToken } = await import('../../lib/edit-grants');
    const t = buildGrantToken(ORG, SITE, 'g1');
    expect(parseGrantToken(t)).toEqual({ orgId: ORG, siteId: SITE, grantId: 'g1' });
  });

  it('rejects a token whose site was swapped', async () => {
    // org and site are inside the signature precisely so a token from one
    // tenant can't be pointed at another's tree.
    const { buildGrantToken, parseGrantToken } = await import('../../lib/edit-grants');
    const raw = Buffer.from(buildGrantToken(ORG, SITE, 'g1'), 'base64url').toString('utf8');
    const tampered = Buffer.from(raw.replace(`::${SITE}::`, '::other::')).toString('base64url');
    expect(parseGrantToken(tampered)).toBeNull();
  });

  it('rejects garbage without throwing', async () => {
    const { parseGrantToken } = await import('../../lib/edit-grants');
    expect(parseGrantToken(undefined)).toBeNull();
    expect(parseGrantToken('')).toBeNull();
    expect(parseGrantToken('not-base64url!!')).toBeNull();
    // A signature of the wrong LENGTH must not reach timingSafeEqual, which
    // throws rather than returning false.
    expect(parseGrantToken(Buffer.from('a::b::c::short').toString('base64url'))).toBeNull();
  });
});

describe('redeeming', () => {
  beforeEach(setup);

  it('returns the grant and its item on first use', async () => {
    const { token } = await issue();
    const { redeemGrant } = await import('../../lib/edit-grants');
    const out = await redeemGrant(token);
    expect(out.orgId).toBe(ORG);
    expect(out.grant.collection).toBe('companies');
    expect(out.grant.item_id).toBe('c1');
  });

  it('is single-use once consumed', async () => {
    const { token } = await issue();
    const { redeemGrant } = await import('../../lib/edit-grants');
    await redeemGrant(token, { consume: true });
    // A forwarded link is dead the moment the first recipient opens it.
    await expect(redeemGrant(token)).rejects.toThrow(/Invalid or expired/);
  });

  it('refuses an expired grant', async () => {
    const { token } = await issue({ ttlHours: 1 });
    const { redeemGrant } = await import('../../lib/edit-grants');
    const later = new Date(Date.now() + 2 * 3_600_000);
    await expect(redeemGrant(token, { now: later })).rejects.toThrow(/Invalid or expired/);
  });

  it('refuses a revoked grant', async () => {
    const { grantId, token } = await issue();
    const { redeemGrant, revokeGrant } = await import('../../lib/edit-grants');
    await revokeGrant(ORG, SITE, grantId);
    await expect(redeemGrant(token)).rejects.toThrow(/Invalid or expired/);
  });

  it('gives the same message for every failure mode', async () => {
    // Distinct messages would tell a caller whether a given grant id exists.
    const { redeemGrant, buildGrantToken } = await import('../../lib/edit-grants');
    const messages: string[] = [];
    for (const t of [undefined, 'junk', buildGrantToken(ORG, SITE, 'no-such-grant')]) {
      await redeemGrant(t).catch((e) => messages.push((e as Error).message));
    }
    expect(new Set(messages).size).toBe(1);
  });

  it('does not consume the grant on a read-only redeem', async () => {
    const { token } = await issue();
    const { redeemGrant } = await import('../../lib/edit-grants');
    await redeemGrant(token);
    await expect(redeemGrant(token)).resolves.toBeTruthy();
  });
});

describe('revoking outstanding grants for an item', () => {
  beforeEach(setup);

  it('kills every live link for that listing and reports the count', async () => {
    // The "someone forwarded the mail" escape hatch.
    await issue();
    await issue();
    const other = await issue({ itemId: 'c2' });
    const { revokeGrantsForItem, redeemGrant } = await import('../../lib/edit-grants');
    expect(await revokeGrantsForItem(ORG, SITE, 'companies', 'c1')).toBe(2);
    // The unrelated listing's link still works.
    await expect(redeemGrant(other.token)).resolves.toBeTruthy();
  });

  it('does not count grants that were already used or revoked', async () => {
    const a = await issue();
    const { redeemGrant, revokeGrantsForItem } = await import('../../lib/edit-grants');
    await redeemGrant(a.token, { consume: true });
    expect(await revokeGrantsForItem(ORG, SITE, 'companies', 'c1')).toBe(0);
  });

  it('writes a revoked_at rather than deleting, so the audit survives', async () => {
    const { grantId } = await issue();
    const { revokeGrant } = await import('../../lib/edit-grants');
    await revokeGrant(ORG, SITE, grantId);
    const { getStore } = await import('../../lib/datastore');
    const doc = await getStore().getDoc<EditGrant>(paths.editGrant(ORG, SITE, grantId));
    expect(doc?.revoked_at).toBeTruthy();
  });
});
