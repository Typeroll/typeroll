import type { APIRoute } from 'astro';
import { json, requireSession } from '../../../../lib/access';
import { verifyInviteToken, extractTokenFromInput } from '../../../../lib/invite';
import { getStore } from '../../../../lib/datastore';
import { paths } from '@typeroll/shared';
import type { Organization, Member } from '@typeroll/shared';
import { rememberOrganization, selectOrganization } from '../../../../lib/organization-session';

export const POST: APIRoute = async ({ request, cookies }) => {
  const guard = await requireSession(cookies);
  if (!guard.ok) return guard.response;
  const session = guard.value;

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

  // Preserve the original role when an invite is redeemed more than once.
  const now = new Date().toISOString();
  await store.createDocIfMissing(`${paths.members(orgId)}/${session.userId}`, {
    email: session.email,
    role: 'editor',
    firebase_uid: session.userId,
    display_name: session.displayName,
    joined_at: now,
  } satisfies Omit<Member, 'id'>);

  if (session.orgId) await rememberOrganization(session.userId, session.orgId);
  await rememberOrganization(session.userId, orgId);
  selectOrganization(cookies, session.userId, orgId);
  return json({ ok: true, orgId, requiresReauth: false });
};
