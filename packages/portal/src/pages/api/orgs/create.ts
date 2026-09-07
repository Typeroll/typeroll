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

  // Reserve the slug atomically so concurrent creators cannot overwrite an organization.
  const created = await store.createDocIfMissing(paths.org(orgId), {
    name,
    slug: orgId,
    plan: 'free',
    roles_enforced: true,
    created_at: now,
  } satisfies Omit<Organization, 'id'>);
  if (!created) return json({ error: 'Organization name was just taken. Please try again.' }, 409);

  // Write the member doc (owner).
  await store.setDoc(`${paths.members(orgId)}/${userId}`, {
    email,
    role: 'owner',
    firebase_uid: userId,
    display_name: displayName,
    joined_at: now,
  } satisfies Omit<Member, 'id'>);

  await rememberOrganization(userId, orgId);
  selectOrganization(cookies, userId, orgId);
  return json({ ok: true, orgId, requiresReauth: false });
};
