// POST /api/auth/refresh-session
//
// Server-side session cookie refresh. Used as a fallback after org creation
// when the client-side Firebase SDK has no auth state (auth.currentUser is
// null), making it impossible to call getIdToken(true) client-side.
//
// Flow: reads the current session cookie to get the userId → creates a
// Firebase custom token → exchanges for an ID token via the Firebase REST
// API (picks up the latest custom claims) → sets a fresh session cookie.
//
// This endpoint is idempotent: calling it when the session is already up-to-
// date is harmless — the cookie is simply reissued with the same claims.

import type { APIRoute } from 'astro';
import { getSession, isDevAuthEnabled, isFirebaseConfigured, refreshSessionForUser } from '../../../lib/auth';
import { json } from '../../../lib/access';
import { firebaseApiKey } from '../../../lib/runtime-config-server';

export const POST: APIRoute = async ({ cookies }) => {
  if (!isFirebaseConfigured()) {
    if (isDevAuthEnabled()) {
      // Local dev mode — no-op, the dev session is always valid.
      return json({ ok: true }, 200);
    }
    return json({ error: 'Firebase not configured' }, 503);
  }

  const session = await getSession(cookies);
  if (!session) return json({ error: 'Not authenticated' }, 401);

  const apiKey = firebaseApiKey();
  if (!apiKey) {
    return json({ error: 'Firebase API key not configured' }, 500);
  }

  try {
    await refreshSessionForUser(cookies, session.userId, apiKey);
    return json({ ok: true }, 200);
  } catch (e) {
    console.error('[refresh-session] failed:', e);
    return json({ error: 'Session refresh failed' }, 500);
  }
};
