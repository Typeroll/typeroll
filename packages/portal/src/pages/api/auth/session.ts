import type { APIRoute } from 'astro';
import { setSessionFromIdToken, isFirebaseConfigured } from '../../../lib/auth';

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!isFirebaseConfigured()) {
    return new Response(JSON.stringify({ error: 'Firebase not configured' }), { status: 500 });
  }
  const { idToken } = (await request.json()) as { idToken: string };
  if (!idToken) return new Response(JSON.stringify({ error: 'Missing idToken' }), { status: 400 });

  try {
    const session = await setSessionFromIdToken(cookies, idToken);
    return new Response(JSON.stringify({ ok: true, session }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : 'Auth failed' }), { status: 401 });
  }
};
