import type { APIRoute } from 'astro';
import {
  E2E_SESSION_PERSONAS,
  isE2EAuthEnabled,
  matchesE2EAuthSecret,
  setE2ESessionCookie,
  type E2EPersonaId,
} from '../../../lib/e2e-auth';

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!isE2EAuthEnabled()) return new Response('Not found', { status: 404 });
  if (!matchesE2EAuthSecret(request.headers.get('x-typeroll-e2e-secret'))) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
  }
  const body = await request.json().catch(() => ({})) as { persona?: string };
  if (!body.persona || !(body.persona in E2E_SESSION_PERSONAS)) {
    return new Response(JSON.stringify({ error: 'Unknown E2E persona' }), { status: 400 });
  }
  setE2ESessionCookie(cookies, body.persona as E2EPersonaId);
  return new Response(JSON.stringify({ ok: true, persona: body.persona }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
