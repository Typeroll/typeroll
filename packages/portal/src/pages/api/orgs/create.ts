// POST /api/orgs/create
//
// Creates a new organization and assigns the calling user as owner.
// Accepts pending sessions (authenticated Firebase users without an org yet)
// because this is exactly the endpoint new users call during onboarding.
//
// On success, this endpoint sets the org_id Firebase custom claim AND refreshes
// the session cookie server-side so the client can redirect to /app immediately
// without needing to call getIdToken(true). Returns requiresReauth: false when
// the server-side refresh succeeded, or requiresReauth: true as a fallback for
// the client to handle (via /api/auth/refresh-session or client-side Firebase).

import type { APIRoute } from 'astro';
import { json, requireSession } from '../../../lib/access';
import { getStore } from '../../../lib/datastore';
import { slugifyOrgName, resolveUniqueSlug } from '../../../lib/org-slug';
import { paths } from '@typeroll/shared';
import type { Organization, Member } from '@typeroll/shared';
import { isFirebaseConfigured, refreshSessionForUser } from '../../../lib/auth';
import { getFirebaseAdminApp } from '../../../lib/firebase-admin';
import { firebaseApiKey } from '../../../lib/runtime-config-server';

export const POST: APIRoute = async ({ request, cookies }) => {
  // requireSession accepts pending sessions (orgId may be undefined).
  const guard = await requireSession(cookies);
  if (!guard.ok) return guard.response;
  const { userId, email, displayName } = guard.value;

  let name: string;
  try {
    const body = (await request.json()) as { name?: unknown };
    name = typeof body.name === 'string' ? body.name.trim() : '';
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (!name) return json({ error: 'Organization name is required' }, 400);
  if (name.length > 80) return json({ error: 'Organization name must be 80 characters or fewer' }, 400);

  const store = getStore();

  // Build a unique slug. List existing orgs to collect taken slugs.
  // In practice the list will be short (per org there's one doc) but we
  // avoid a separate "slug exists?" query by doing this once.
  const baseSlug = slugifyOrgName(name);
  if (!baseSlug) return json({ error: 'Organization name produced an empty slug; please use alphanumeric characters.' }, 400);

  // Check if the base slug is already taken by reading that org doc directly.
  // This is cheaper than listing all orgs and avoids a full collection scan.
  const existing = await store.getDoc<Organization>(paths.org(baseSlug));
  const takenSlugs = new Set<string>(existing ? [baseSlug] : []);

  // Also try a few suffixed variants eagerly if the base is taken.
  if (takenSlugs.has(baseSlug)) {
    for (let i = 2; i <= 10; i++) {
      const c = `${baseSlug}-${i}`;
      const doc = await store.getDoc<Organization>(paths.org(c));
      if (doc) takenSlugs.add(c);
    }
  }

  const orgId = resolveUniqueSlug(baseSlug, takenSlugs);
  const now = new Date().toISOString();

  // Write the org doc.
  await store.setDoc(paths.org(orgId), {
    name,
    slug: orgId,
    plan: 'free',
    created_at: now,
  } satisfies Omit<Organization, 'id'>);

  // Write the member doc (owner).
  await store.setDoc(`${paths.members(orgId)}/${userId}`, {
    email,
    role: 'owner',
    firebase_uid: userId,
    display_name: displayName,
    joined_at: now,
  } satisfies Omit<Member, 'id'>);

  // Set the Firebase custom claim so future ID tokens carry org_id, then
  // immediately refresh the session cookie server-side so the new claim
  // takes effect without requiring the client to have an active Firebase SDK
  // auth state (auth.currentUser is often null in production when the login
  // established only a server-side session cookie).
  if (isFirebaseConfigured()) {
    try {
      const { getAuth } = await import('firebase-admin/auth');
      const app = await getFirebaseAdminApp();
      await getAuth(app).setCustomUserClaims(userId, { org_id: orgId });
    } catch (e) {
      // Log but don't fail — the org + member docs are written; the user
      // can retry the claim refresh. A failed claim won't cause data loss.
      console.error('[orgs/create] setCustomUserClaims failed:', e);
      return json({ ok: true, orgId, requiresReauth: true, claimWarning: true });
    }

    // Refresh the session cookie server-side so it carries the new org_id
    // claim immediately. If this fails (e.g. missing API key, network error),
    // fall back gracefully — the client's reauth() will handle it.
    const apiKey = firebaseApiKey();
    if (apiKey) {
      try {
        await refreshSessionForUser(cookies, userId, apiKey);
        // Session cookie is now up-to-date; client can redirect to /app directly.
        return json({ ok: true, orgId, requiresReauth: false });
      } catch (e) {
        console.error('[orgs/create] server-side session refresh failed, client will retry:', e);
        // Fall through to requiresReauth: true so the client attempts its own refresh.
      }
    }
  }
  // In dev (no Firebase) the session already has orgId=undefined; the
  // reauth flow is skipped since there's no real claim to refresh.
  // Also falls through here if server-side refresh failed — client retries.

  return json({ ok: true, orgId, requiresReauth: true });
};
