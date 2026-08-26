import type { APIRoute } from 'astro';
import { requireSiteAccess, json, requirePermission } from '../../../../../lib/access';
import { getStore } from '../../../../../lib/datastore';
import { paths, MAIN_VERSION_ID } from '@typeroll/shared';
import type { SiteVersion } from '@typeroll/shared';

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { session, site, owner_org_id } = guard.value;
  const list = await getStore().listDocs<SiteVersion>(paths.versions(owner_org_id, site.id));
  // Make sure main is always present in the response even if the underlying
  // doc hasn't been materialised yet (legacy sites or fresh installs).
  if (!list.some((v) => v.id === MAIN_VERSION_ID)) {
    list.unshift({
      id: MAIN_VERSION_ID,
      name: 'Main',
      kind: 'main',
      created_at: site.created_at ?? new Date().toISOString(),
      robots_blocked: false,
    });
  }
  list.sort((a, b) => (a.kind === 'main' ? -1 : b.kind === 'main' ? 1 : a.name.localeCompare(b.name)));
  return json({ versions: list });
};

/**
 * Create a branch. Copy-on-write: the new version is just a SiteVersion doc
 * with a base_version_id pointer — no content is copied. Reads through the
 * branch fall back to base for any doc the branch hasn't overridden, so the
 * branch automatically picks up upstream changes for everything it hasn't
 * itself diverged on. Writes on the branch only materialise the changed
 * doc at the branch's path; deletes write tombstones.
 *
 * Branches default to robots_blocked=true so they can't be discovered before
 * a deliberate promotion to main.
 */
export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const adminCheck = requirePermission(guard.value, 'admin');
  if (!adminCheck.ok) return adminCheck.response;
  const { session, site, owner_org_id } = guard.value;

  const body = (await request.json()) as { name?: string; base?: string };
  const name = (body.name ?? '').trim();
  if (!name) return json({ error: 'Name required' }, 400);

  const baseId = slugify(name) || 'branch';
  if (baseId === MAIN_VERSION_ID) {
    return json({ error: '"main" is reserved.' }, 400);
  }

  // Unique id check
  const existing = await getStore().listDocs<SiteVersion>(paths.versions(owner_org_id, site.id));
  const taken = new Set(existing.map((v) => v.id));
  let id = baseId;
  let n = 2;
  while (taken.has(id)) id = `${baseId}-${n++}`;

  const base = (body.base ?? MAIN_VERSION_ID).trim() || MAIN_VERSION_ID;
  if (base !== MAIN_VERSION_ID) {
    const src = await getStore().getDoc<SiteVersion>(paths.version(owner_org_id, site.id, base));
    if (!src) return json({ error: `Base version "${base}" not found.` }, 400);
  }

  const doc: Omit<SiteVersion, 'id'> = {
    name,
    kind: 'branch',
    base_version_id: base,
    created_at: new Date().toISOString(),
    created_by: session.email,
    robots_blocked: true,
  };
  await getStore().setDoc(paths.version(owner_org_id, site.id, id), doc);

  return json({ ok: true, version: { id, ...doc } });
};
