import type { AstroCookies } from 'astro';
import { json, requireFullSession, requireOrgAdmin } from '../access';
import { requireAnyApiKey } from '../api-auth';

export type DeveloperAccessResult =
  | { ok: true; orgId: string; actorId: string }
  | { ok: false; response: Response };

/** Cookie auth for the portal and org-scoped API-key auth for the CLI. */
export async function requireDeveloperAccess(
  request: Request,
  cookies: AstroCookies,
): Promise<DeveloperAccessResult> {
  if (request.headers.get('authorization')?.toLowerCase().startsWith('bearer ')) {
    const key = await requireAnyApiKey(request);
    if (!key.ok) return key;
    if (key.value.tokenSiteId !== null) {
      return { ok: false, response: json({ error: 'Developer API requires an organization-scoped API key' }, 403) };
    }
    return { ok: true, orgId: key.value.tokenOrgId, actorId: `api:${key.value.keyPrefix}` };
  }
  const session = await requireFullSession(cookies);
  if (!session.ok) return session;
  const admin = await requireOrgAdmin(session.value);
  if (!admin.ok) return admin;
  return { ok: true, orgId: session.value.orgId, actorId: session.value.userId };
}
