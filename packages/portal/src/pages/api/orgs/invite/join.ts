// POST /api/orgs/invite/join
//
// Redeems a signed invite token and adds the calling user to the org.
// Requires a pending session (authenticated Firebase user without an org).
// Returns { ok: true, orgId, requiresReauth: true } on success — the client
// must force-refresh the ID token and re-exchange the session cookie.

import type { APIRoute } from 'astro';
import { json, requireSession } from '../../../../lib/access';
import { verifyInviteToken, extractTokenFromInput } from '../../../../lib/invite';
import { getStore } from '../../../../lib/datastore';
import { paths } from '@typeroll/shared';
import type { Organization, Member } from '@typeroll/shared';
import { isFirebaseConfigured, refreshSessionForUser } from '../../../../lib/auth';
import { getFirebaseAdminApp } from '../../../../lib/firebase-admin';
import { firebaseApiKey } from '../../../../lib/runtime-config-server';

export const POST: APIRoute = async ({ request, cookies }) => {
  const guard = await requireSession(cookies);
  if (!guard.ok) return guard.response;
  const session = guard.value;

  // Only pending sessions (no org yet) can join via invite.
  if (session.orgId) {
    return json({ error: 'You are already a member of an organization.' }, 400);
  }

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

  // Preserve existing membership (including its role), but always repair
  // claims and refresh the session after an interrupted onboarding attempt.
  const now = new Date().toISOString();
  await store.createDocIfMissing(`${paths.members(orgId)}/${session.userId}`, {
    email: session.email,
    role: 'editor',
    firebase_uid: session.userId,
    display_name: session.displayName,
    joined_at: now,
  } satisfies Omit<Member, 'id'>);

  // Set Firebase custom claim, then refresh the session cookie server-side so
  // the new org_id takes effect immediately without requiring client-side
  // Firebase SDK auth state.
  if (isFirebaseConfigured()) {
    try {
      const { getAuth } = await import('firebase-admin/auth');
      const app = await getFirebaseAdminApp();
      await getAuth(app).setCustomUserClaims(session.userId, { org_id: orgId });
    } catch (e) {
      console.error('[orgs/invite/join] setCustomUserClaims failed:', e);
      return json({ ok: true, orgId, requiresReauth: true, claimWarning: true });
    }

    const apiKey = firebaseApiKey();
    if (apiKey) {
      try {
        await refreshSessionForUser(cookies, session.userId, apiKey);
        return json({ ok: true, orgId, requiresReauth: false });
      } catch (e) {
        console.error('[orgs/invite/join] server-side session refresh failed, client will retry:', e);
      }
    }
  }

  return json({ ok: true, orgId, requiresReauth: true });
};
