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
  const body = await request.json().catch(() => ({})) as { persona?: string; emailVerified?: unknown };
  if (!body.persona || !(body.persona in E2E_SESSION_PERSONAS)) {
    return new Response(JSON.stringify({ error: 'Unknown E2E persona' }), { status: 400 });
  }
  if (body.emailVerified !== undefined && typeof body.emailVerified !== 'boolean') {
    return new Response(JSON.stringify({ error: 'emailVerified must be a boolean' }), { status: 400 });
  }
  const emailVerified = body.emailVerified !== false;
  setE2ESessionCookie(cookies, body.persona as E2EPersonaId, { emailVerified });
  return new Response(JSON.stringify({ ok: true, persona: body.persona, emailVerified }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
