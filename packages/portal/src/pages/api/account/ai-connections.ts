import type { APIRoute } from 'astro';
import { getSession } from '../../../lib/auth';
import { requireAuthOrigin, readAuthBody } from '../../../lib/auth-request';
import { revokePersonalConnection } from '../../../lib/api-keys';

export const POST: APIRoute = async ({ request, cookies }) => {
  const origin = requireAuthOrigin(request);
  if (origin) return origin;
  const session = await getSession(cookies);
  if (!session) return new Response('Sign in again.', { status: 401 });
  let id: string;
  try { id = new URLSearchParams(await readAuthBody(request)).get('connection_id') || ''; }
  catch { return new Response('Invalid request.', { status: 400 }); }
  if (!await revokePersonalConnection(session.userId, id)) return new Response('Connection not found.', { status: 404 });
  return new Response(null, { status: 303, headers: { Location: '/app/settings/ai-connections?revoked=1', 'Cache-Control': 'no-store' } });
};
