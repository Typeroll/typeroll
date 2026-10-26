import { limitAuthRequest } from '../../../../lib/auth-request';
import type { APIRoute } from 'astro';
import { json, requireSession } from '../../../../lib/access';
import { verifyInviteToken, extractTokenFromInput, redeemInvite } from '../../../../lib/invite';
import { getStore } from '../../../../lib/datastore';
import { paths } from '@typeroll/shared';
import type { Organization, Member } from '@typeroll/shared';
import { rememberOrganization, selectOrganization } from '../../../../lib/organization-session';

export const POST: APIRoute = async ({ request, cookies }) => {
  const guard = await requireSession(cookies);
  if (!guard.ok) return guard.response;
  const session = guard.value;
  const limited = await limitAuthRequest(`join-org:${session.userId}`, 20, 600_000);
  if (limited) return limited;

  let rawToken: string;
  try {
    const body = (await request.json()) as { token?: unknown };
    rawToken = typeof body.token === 'string' ? body.token.trim() : '';
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (!rawToken) return json({ error: 'Token is required' }, 400);

  // Accept both bare token strings and full invite URLs.
  const token = extractTokenFromInput(rawToken);

  // Signature first, then the stored invite: revoked, expired, used up or
  // bound to another email address is refused. One use is consumed
  // atomically; an existing member or a retry by the same person uses none.
  const verified = verifyInviteToken(token);
  if (!verified) {
    return json({ error: 'Invalid or expired invite token.' }, 400);
  }

  const { orgId } = verified;
  const store = getStore();

  // Confirm the org exists.
  const org = await store.getDoc<Organization>(paths.org(orgId));
  if (!org) {
    return json({ error: 'The organization this invite belongs to no longer exists.' }, 404);
  }

  // An existing member keeps their role and spends no use.
  const memberPath = `${paths.members(orgId)}/${session.userId}`;
  const member: Omit<Member, 'id'> = {
    email: session.email,
    role: 'editor',
    firebase_uid: session.userId,
    ...(session.displayName ? { display_name: session.displayName } : {}),
    joined_at: new Date().toISOString(),
  };
  const redeemed = await redeemInvite(token, { userId: session.userId, email: session.email }, {
    alreadyMember: !!await store.getDoc<Member>(memberPath),
    memberPath,
    member,
  });
  if (!redeemed.ok) return json({ error: redeemed.error }, redeemed.status);

  if (session.orgId) await rememberOrganization(session.userId, session.orgId);
  await rememberOrganization(session.userId, orgId);
  selectOrganization(cookies, session.userId, orgId);
  return json({ ok: true, orgId, requiresReauth: false });
};
