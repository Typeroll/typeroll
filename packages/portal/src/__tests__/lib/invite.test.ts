import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import {
  createInvite,
  extractTokenFromInput,
  generateInviteToken,
  invitePaths,
  listInvites,
  redeemInvite,
  revokeInvite,
  verifyInviteToken,
} from '../../lib/invite';

const SECRET = 'test-invite-secret-please-change-for-real-32+chars';
const INVITE_ID = 'AAAAAAAAAAAAAAAAAAAAAA';

beforeAll(() => {
  process.env.FORMS_HMAC_SECRET = SECRET;
});

function tokenFrom(url: string): string {
  return new URL(url, 'https://portal.test').searchParams.get('invite')!;
}

describe('generateInviteToken + verifyInviteToken', () => {
  it('round-trips a valid token', () => {
    expect(verifyInviteToken(generateInviteToken('acme', INVITE_ID))).toEqual({ orgId: 'acme', inviteId: INVITE_ID });
  });

  it('returns null for an empty or non-token string', () => {
    expect(verifyInviteToken('')).toBeNull();
    expect(verifyInviteToken('not-a-token')).toBeNull();
  });

  it('returns null for a tampered orgId or invite id', () => {
    const raw = Buffer.from(generateInviteToken('acme', INVITE_ID), 'base64url').toString('utf-8').split('::');
    const org = Buffer.from(['v2', 'evil', raw[2], raw[3]].join('::')).toString('base64url');
    const id = Buffer.from(['v2', 'acme', 'BBBBBBBBBBBBBBBBBBBBBB', raw[3]].join('::')).toString('base64url');
    expect(verifyInviteToken(org)).toBeNull();
    expect(verifyInviteToken(id)).toBeNull();
  });

  it('returns null when signed with a different secret', () => {
    const token = generateInviteToken('acme', INVITE_ID);
    process.env.FORMS_HMAC_SECRET = 'different-secret-please-change-for-real-32+chars';
    expect(verifyInviteToken(token)).toBeNull();
    process.env.FORMS_HMAC_SECRET = SECRET;
  });

  it('refuses the earlier stateless, irrevocable token format', () => {
    // <orgId>::<expiry>::HMAC(FORMS_HMAC_SECRET, payload) — still validly signed.
    const payload = `acme::${Date.now() + 86_400_000}`;
    const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
    expect(verifyInviteToken(Buffer.from(`${payload}::${sig}`).toString('base64url'))).toBeNull();
  });

  it('is not signed with FORMS_HMAC_SECRET directly (domain-separated key)', () => {
    const payload = `v2::acme::${INVITE_ID}`;
    const formsSig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
    expect(verifyInviteToken(Buffer.from(`${payload}::${formsSig}`).toString('base64url'))).toBeNull();
  });
});

describe('extractTokenFromInput', () => {
  it('returns the bare token unchanged and trims whitespace', () => {
    const token = generateInviteToken('org', INVITE_ID);
    expect(extractTokenFromInput(token)).toBe(token);
    expect(extractTokenFromInput(`  ${token}  `)).toBe(token);
  });

  it('extracts token from a full invite URL (query param)', () => {
    const token = generateInviteToken('org', INVITE_ID);
    expect(extractTokenFromInput(`https://app.typeroll.com/onboarding?invite=${encodeURIComponent(token)}`)).toBe(token);
  });

  it('returns the input unchanged when URL has no invite param', () => {
    const url = 'https://app.typeroll.com/onboarding';
    expect(extractTokenFromInput(url)).toBe(url);
  });
});

describe('stored invites', () => {
  const ORG = 'acme';
  const creator = { id: 'owner-1', email: 'owner@example.com' };
  const memberPath = (userId: string) => `${paths.members(ORG)}/${userId}`;
  const join = async (token: string, userId: string, email = `${userId}@example.com`) => {
    const { getStore } = await import('../../lib/datastore');
    return redeemInvite(token, { userId, email }, {
      alreadyMember: !!await getStore().getDoc(memberPath(userId)),
      memberPath: memberPath(userId),
      member: { role: 'editor', email, firebase_uid: userId, joined_at: '2026-01-01' },
    });
  };

  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
  });

  it('is single use by default and creates the membership with the use', async () => {
    const invite = await createInvite({ orgId: ORG, ttlDays: 7, createdBy: creator });
    expect(await join(tokenFrom(invite.inviteUrl), 'first')).toEqual({ ok: true, orgId: ORG });
    expect(await join(tokenFrom(invite.inviteUrl), 'second')).toMatchObject({ ok: false, status: 400 });
    const { getStore } = await import('../../lib/datastore');
    expect(await getStore().getDoc(memberPath('first'))).toMatchObject({ role: 'editor' });
    expect(await getStore().getDoc(memberPath('second'))).toBeNull();
    expect(await getStore().getDoc(invitePaths.invite(ORG, invite.inviteId))).toMatchObject({ used_count: 1, used_by: ['first'] });
  });

  it('lets a removed member not come back with the link they used', async () => {
    const invite = await createInvite({ orgId: ORG, ttlDays: 7, createdBy: creator, maxUses: 5 });
    expect((await join(tokenFrom(invite.inviteUrl), 'editor')).ok).toBe(true);
    const { getStore } = await import('../../lib/datastore');
    await getStore().deleteDoc(memberPath('editor'));
    expect(await join(tokenFrom(invite.inviteUrl), 'editor')).toMatchObject({ ok: false });
    expect(await getStore().getDoc(memberPath('editor'))).toBeNull();
  });

  it('lets an existing member through without spending a use', async () => {
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(memberPath('owner-2'), { role: 'owner' });
    const invite = await createInvite({ orgId: ORG, ttlDays: 7, createdBy: creator });
    expect((await join(tokenFrom(invite.inviteUrl), 'owner-2')).ok).toBe(true);
    expect(await getStore().getDoc(memberPath('owner-2'))).toMatchObject({ role: 'owner' });
    expect((await join(tokenFrom(invite.inviteUrl), 'newcomer')).ok).toBe(true);
  });

  it('stops working as soon as it is revoked', async () => {
    const invite = await createInvite({ orgId: ORG, ttlDays: 7, createdBy: creator, maxUses: 10 });
    expect(await revokeInvite(ORG, invite.inviteId, creator)).toBe(true);
    expect(await join(tokenFrom(invite.inviteUrl), 'late')).toMatchObject({ ok: false, status: 400 });
    expect((await listInvites(ORG))[0]).toMatchObject({ id: invite.inviteId, state: 'revoked' });
    expect(await revokeInvite(ORG, 'BBBBBBBBBBBBBBBBBBBBBB', creator)).toBe(false);
    expect(await revokeInvite('other-org', invite.inviteId, creator)).toBe(false);
  });

  it('refuses an expired invite', async () => {
    const invite = await createInvite({ orgId: ORG, ttlDays: 7, createdBy: creator });
    const { getStore } = await import('../../lib/datastore');
    await getStore().updateDoc(invitePaths.invite(ORG, invite.inviteId), { expires_at: '2020-01-01T00:00:00.000Z' });
    expect(await join(tokenFrom(invite.inviteUrl), 'late')).toMatchObject({ ok: false, status: 400 });
  });

  it('honours an email binding', async () => {
    const invite = await createInvite({ orgId: ORG, ttlDays: 7, createdBy: creator, email: 'named@example.com' });
    expect(await join(tokenFrom(invite.inviteUrl), 'someone', 'someone@example.com')).toMatchObject({ ok: false, status: 403 });
    expect((await join(tokenFrom(invite.inviteUrl), 'named', 'Named@Example.com')).ok).toBe(true);
  });

  it('refuses a validly signed token whose record does not exist', async () => {
    expect(await join(generateInviteToken(ORG, INVITE_ID), 'forger')).toMatchObject({ ok: false, status: 400 });
  });

  it('lists invites without their tokens', async () => {
    const invite = await createInvite({ orgId: ORG, ttlDays: 7, createdBy: creator });
    const listed = await listInvites(ORG);
    expect(listed).toEqual([expect.objectContaining({ id: invite.inviteId, state: 'active', max_uses: 1, used_count: 0, created_by: 'owner@example.com' })]);
    expect(JSON.stringify(listed)).not.toContain(tokenFrom(invite.inviteUrl));
  });
});
