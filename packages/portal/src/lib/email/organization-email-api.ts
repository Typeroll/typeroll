import type { AstroCookies } from 'astro';
import { paths, type Member, type SiteApiKey } from '@typeroll/shared';
import { getStore } from '../datastore';
import { json, requireFullSession } from '../access';
import { apiError, apiResponse, requireAnyApiKey, withApiIdentity } from '../api-auth';
import { organizationMembership } from '../organization-session';
import { publishingJsonBody } from '../publishing/http';
import { ConnectionError } from '../publishing/connections';
import { OrganizationEmailError, organizationEmailSummary, removeOrganizationEmail, saveOrganizationEmail, testOrganizationEmail } from './organization-email';

const REFUSAL = 'Only an organization owner can manage its email account and site access.';
export async function organizationEmailOwner(cookies: AstroCookies) {
  const guard = await requireFullSession(cookies);
  if (!guard.ok) return guard;
  const member = await organizationMembership(guard.value.userId, guard.value.orgId);
  return member?.role === 'owner' ? guard : { ok: false as const, response: json({ error: REFUSAL }, 403) };
}
export async function organizationEmailApiOwner(request: Request) {
  const guard = await requireAnyApiKey(request);
  if (!guard.ok) return guard;
  const ctx = guard.value;
  if (ctx.tokenSiteId !== null || ctx.extensionIdentity || request.method !== 'GET' && ctx.permission !== 'admin') return { ok: false as const, response: apiError(REFUSAL, 403) };
  let owner = false;
  if (ctx.personalUserId) owner = (await organizationMembership(ctx.personalUserId, ctx.tokenOrgId))?.role === 'owner';
  else {
    const key = await getStore().getDoc<SiteApiKey & { created_by_org_id?: string }>(paths.orgApiKey(ctx.tokenOrgId, ctx.keyPrefix));
    if (key && (!key.created_by_org_id || key.created_by_org_id === ctx.tokenOrgId)) {
      const members = await getStore().listDocs<Member>(paths.members(ctx.tokenOrgId), { filters: [{ field: 'role', op: '==', value: 'owner' }], limit: 1000 });
      owner = members.some(member => member.id === key.created_by || !!member.email && member.email.toLowerCase() === key.created_by?.toLowerCase());
    }
  }
  return owner ? guard : { ok: false as const, response: apiError(REFUSAL, 403) };
}
const failure = (error: unknown) => {
  const known = error instanceof OrganizationEmailError || error instanceof ConnectionError;
  const response = json({ error: known ? error.message : 'Organization email settings could not be confirmed' }, known ? error.status : 503);
  response.headers.set('Cache-Control', 'no-store'); return response;
};
async function operation(orgId: string, actor: string, request: Request) {
  if (request.method === 'GET') return organizationEmailSummary(orgId);
  const body = await publishingJsonBody(request, 131072);
  if (request.method === 'PUT') return saveOrganizationEmail(orgId, actor, body);
  if (request.method === 'POST') return testOrganizationEmail(orgId, body.to);
  if (request.method === 'DELETE') return removeOrganizationEmail(orgId, actor, body.expected_revision);
  throw new OrganizationEmailError('Method not allowed', 405);
}
export async function organizationEmailCookie(request: Request, cookies: AstroCookies) {
  const guard = await organizationEmailOwner(cookies);
  if (!guard.ok) return guard.response;
  try { const response = json(await operation(guard.value.orgId, guard.value.userId, request)); response.headers.set('Cache-Control', 'no-store'); return response; }
  catch (error) { return failure(error); }
}
export async function organizationEmailPublicApi(request: Request) {
  const guard = await organizationEmailApiOwner(request);
  if (!guard.ok) return guard.response;
  try {
    const result = await operation(guard.value.tokenOrgId, guard.value.personalUserId ?? `api-key:${guard.value.keyPrefix}`, request);
    return apiResponse(guard.value, result, 200, request.method === 'GET' ? undefined : { action: 'organization_email_settings', method: request.method });
  } catch (error) { return withApiIdentity(guard.value, failure(error)); }
}
