// POST /api/account/api-tokens  { name }  →  { token, id, name }
//
// A personal API token for scripts. It is the same credential as a personal AI
// connection: it follows the person's current access in every organization,
// lasts until it is revoked, and is shown only once. REST calls name their
// organization with the Typeroll-Organization header.

import type { APIRoute } from 'astro';
import { getSession } from '../../../lib/auth';
import { requireAuthOrigin, limitAuthRequest, readAuthBody } from '../../../lib/auth-request';
import { createPersonalConnection } from '../../../lib/api-keys';

export const POST: APIRoute = async ({ request, cookies }) => {
  const origin = requireAuthOrigin(request);
  if (origin) return origin;
  const session = await getSession(cookies);
  if (!session) return Response.json({ error: 'Sign in again.' }, { status: 401 });
  const limited = await limitAuthRequest(`api-token:${session.userId}`, 10, 600_000);
  if (limited) return limited;
  let name = '';
  try { name = String((JSON.parse(await readAuthBody(request)) as { name?: unknown }).name ?? '').trim(); }
  catch { return Response.json({ error: 'Send { "name": "…" }.' }, { status: 400 }); }
  if (!name || name.length > 80) return Response.json({ error: 'Name the token (1–80 characters), for example the script or computer that uses it.' }, { status: 400 });
  const created = await createPersonalConnection(session.userId, name, 'api_token');
  return Response.json({ id: created.prefix, name, token: created.token }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
};
