import { createHash } from 'node:crypto';
import { initialOrganizationAccess, organizationAccessPolicy } from '../../../lib/organization-access';
import { limitAuthRequest } from '../../../lib/auth-request';
import { getHostingGroup } from '../../../lib/publishing/hosting-groups';
import type { APIRoute } from 'astro';
import { json, requireSession } from '../../../lib/access';
import { getStore } from '../../../lib/datastore';
import { slugifyOrgName, resolveUniqueSlug } from '../../../lib/org-slug';
import { paths } from '@typeroll/shared';
import type { Organization, Member } from '@typeroll/shared';
import { rememberOrganization, selectOrganization } from '../../../lib/organization-session';

export const POST: APIRoute = async ({ request, cookies }) => {
  // requireSession accepts pending sessions (orgId may be undefined).
  const guard = await requireSession(cookies);
  if (!guard.ok) return guard.response;
  const { userId, email, displayName } = guard.value;
  const limited = await limitAuthRequest(`create-org:${userId}`, 5, 3_600_000);
  if (limited) return limited;
  if (guard.value.orgId) await rememberOrganization(userId, guard.value.orgId);

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
  const nonce = request.headers.get('Idempotency-Key') ?? name;
  if (!nonce || nonce.length > 128 || /[\x00-\x1f]/.test(nonce)) return json({ error: 'Invalid Idempotency-Key' }, 400);
  const receiptPath = `organization_creation_requests/${createHash('sha256').update(JSON.stringify([userId, nonce])).digest('hex')}`;
  const prior = await store.getDoc<{ org_id: string; name: string }>(receiptPath);
  if (prior) {
    if (prior.name !== name || !await store.getDoc(`${paths.members(prior.org_id)}/${userId}`)) return json({ error: 'This creation key belongs to another request.' }, 409);
    selectOrganization(cookies, userId, prior.org_id);
    return json({ ok: true, orgId: prior.org_id, requiresReauth: false, reused: true });
  }

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

  const serviceAccess = initialOrganizationAccess(organizationAccessPolicy(), new Date(now));

  // Reserve the slug atomically so concurrent creators cannot overwrite an organization.
  const created = await store.compareAndReplaceDoc(paths.org(orgId), null, {
    name,
    slug: orgId,
    plan: 'free',
    roles_enforced: true,
    ...(serviceAccess ? { service_access: serviceAccess } : {}),
    created_at: now,
  } satisfies Omit<Organization, 'id'>, [{
    path: `${paths.members(orgId)}/${userId}`, expected: null, replace: true,
    data: { email, role: 'owner', firebase_uid: userId, ...(displayName ? { display_name: displayName } : {}), joined_at: now } satisfies Omit<Member, 'id'>,
  }, { path: receiptPath, expected: null, replace: true, data: { org_id: orgId, name, created_at: now } }]);
  if (!created) return json({ error: 'Organization name was just taken. Please try again.' }, 409);

  await getHostingGroup(orgId);
  await rememberOrganization(userId, orgId);
  selectOrganization(cookies, userId, orgId);
  return json({ ok: true, orgId, requiresReauth: false });
};
