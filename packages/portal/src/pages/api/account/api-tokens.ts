// POST /api/account/api-tokens
//   { name, organization_ids?: string[], read_only?: boolean, expires_in_days?: 30 | 90 | 365 | null }
//   →  { token, id, name, organization_ids, read_only, expires_at }
//
// A personal API token for scripts. It is the same credential as a personal AI
// connection: it follows the person's current access, is checked live on every
// request and is shown only once. REST calls name their organization with the
// Typeroll-Organization header. Optional limits narrow it to some
// organizations, to reads, or to a period; at most 20 can be active.

import type { APIRoute } from 'astro';
import { getSession } from '../../../lib/auth';
import { requireAuthOrigin, limitAuthRequest, readAuthBody } from '../../../lib/auth-request';
import { createPersonalConnection, listPersonalConnections } from '../../../lib/api-keys';
import { personalOrganizations } from '../../../lib/personal-site-access';

const MAX_ACTIVE_TOKENS = 20;
const EXPIRY_DAYS = new Set([30, 90, 365]);
const reply = (body: unknown, status: number) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export const POST: APIRoute = async ({ request, cookies }) => {
  const origin = requireAuthOrigin(request);
  if (origin) return origin;
  const session = await getSession(cookies);
  if (!session) return reply({ error: 'Sign in again.' }, 401);
  const limited = await limitAuthRequest(`api-token:${session.userId}`, 10, 600_000);
  if (limited) return limited;
  let input: { name?: unknown; organization_ids?: unknown; read_only?: unknown; expires_in_days?: unknown };
  try { input = JSON.parse(await readAuthBody(request)) ?? {}; }
  catch { return reply({ error: 'Send { "name": "…" }.' }, 400); }
  const name = String(input.name ?? '').trim();
  if (!name || name.length > 80) return reply({ error: 'Name the token (1–80 characters), for example the script or computer that uses it.' }, 400);
  if (input.read_only !== undefined && typeof input.read_only !== 'boolean') return reply({ error: 'read_only must be true or false.' }, 400);
  const days = input.expires_in_days ?? null;
  if (days !== null && !EXPIRY_DAYS.has(days as number)) return reply({ error: 'expires_in_days must be 30, 90, 365 or null.' }, 400);
  let organizationIds: string[] | undefined;
  if (input.organization_ids !== undefined && input.organization_ids !== null) {
    if (!Array.isArray(input.organization_ids) || !input.organization_ids.length || input.organization_ids.some(id => typeof id !== 'string')) {
      return reply({ error: 'organization_ids must list at least one organization, or be left out for all of them.' }, 400);
    }
    const member = new Set((await personalOrganizations(session.userId)).map(org => org.id));
    organizationIds = [...new Set(input.organization_ids as string[])];
    if (organizationIds.some(id => !member.has(id))) return reply({ error: 'Choose only organizations you belong to.' }, 400);
  }
  const active = (await listPersonalConnections(session.userId)).filter(entry => entry.kind === 'api_token' && !entry.revoked_at
    && !(entry.expires_at && Date.parse(entry.expires_at) <= Date.now()));
  if (active.length >= MAX_ACTIVE_TOKENS) return reply({ error: `You have ${MAX_ACTIVE_TOKENS} active API tokens. Revoke one you no longer use first.` }, 409);
  const expiresAt = days ? new Date(Date.now() + (days as number) * 86_400_000).toISOString() : undefined;
  const created = await createPersonalConnection(session.userId, name, 'api_token', {
    ...(organizationIds ? { allowed_org_ids: organizationIds } : {}), ...(input.read_only ? { read_only: true } : {}), ...(expiresAt ? { expires_at: expiresAt } : {}),
  });
  return reply({ id: created.prefix, name, token: created.token, organization_ids: organizationIds ?? null, read_only: Boolean(input.read_only), expires_at: expiresAt ?? null }, 201);
};
