// GET  /api/v1/sites/{siteId}/versions      list versions
// POST /api/v1/sites/{siteId}/versions      create a feature branch
//
// Branch model: copy-on-write. Creating a branch only writes a SiteVersion
// doc with base_version_id pointing at main (or another branch). No content
// is copied. The branch picks up upstream changes for any doc it hasn't
// itself diverged on. Writes on the branch materialise the changed doc at
// the branch's path; deletes write tombstones.
//
// Branches default robots_blocked: true so they can't be discovered
// before a deliberate merge to main.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { getStore } from '../../../../../../lib/datastore';
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

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const list = await getStore().listDocs<SiteVersion>(paths.versions(ctx.orgId, ctx.siteId));
  if (!list.some((v) => v.id === MAIN_VERSION_ID)) {
    list.unshift({
      id: MAIN_VERSION_ID,
      name: 'Main',
      kind: 'main',
      created_at: ctx.site.created_at ?? new Date().toISOString(),
      robots_blocked: false,
    });
  }
  list.sort((a, b) => (a.kind === 'main' ? -1 : b.kind === 'main' ? 1 : a.name.localeCompare(b.name)));
  return apiResponse(ctx, { versions: list });
};

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const body = (await request.json().catch(() => null)) as { name?: string; base?: string } | null;
  if (!body) return apiError('Invalid JSON body');
  const name = (body.name ?? '').trim();
  if (!name) return apiError('name required');

  const baseId = slugify(name) || 'branch';
  if (baseId === MAIN_VERSION_ID) return apiError('"main" is reserved');

  const store = getStore();
  const existing = await store.listDocs<SiteVersion>(paths.versions(ctx.orgId, ctx.siteId));
  const taken = new Set(existing.map((v) => v.id));
  let id = baseId;
  let n = 2;
  while (taken.has(id)) id = `${baseId}-${n++}`;

  const base = (body.base ?? MAIN_VERSION_ID).trim() || MAIN_VERSION_ID;
  if (base !== MAIN_VERSION_ID) {
    const src = await store.getDoc<SiteVersion>(paths.version(ctx.orgId, ctx.siteId, base));
    if (!src) return apiError(`Base version "${base}" not found`, 400);
  }

  const doc: Omit<SiteVersion, 'id'> = {
    name,
    kind: 'branch',
    base_version_id: base,
    created_at: new Date().toISOString(),
    created_by: `api-key:${ctx.keyPrefix}`,
    robots_blocked: true,
  };
  await store.setDoc(paths.version(ctx.orgId, ctx.siteId, id), doc);
  return apiResponse(ctx, { version: { id, ...doc } }, 201, body);
};
