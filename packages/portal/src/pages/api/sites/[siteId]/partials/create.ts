import type { APIRoute } from 'astro';
import { requireSiteAccess, json, requirePermission } from '../../../../../lib/access';
import { getStore } from '../../../../../lib/datastore';
import { paths } from '@typeroll/shared';
import type { Partial as PartialDoc } from '@typeroll/shared';

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/**
 * Creates a new free global block. Header and footer are special cases handled
 * by [partialId].ts (their ids are reserved). This endpoint is for everything
 * else — announcement bars, CTAs, reusable HTML you reference via <x-include>.
 */
export const POST: APIRoute = async ({ request, cookies, params, redirect, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { session, site, versionId, owner_org_id } = guard.value;

  const form = await request.formData();
  const name = String(form.get('name') ?? '').trim();
  if (!name) return json({ error: 'Name required' }, 400);

  const baseId = slugify(name) || 'block';
  if (baseId === 'header' || baseId === 'footer') {
    return json({ error: `"${baseId}" is reserved for the auto-injected layout block.` }, 400);
  }

  // Make sure the id is unique across this site's partials.
  const existing = await getStore().listDocs<PartialDoc>(paths.partials(owner_org_id, site.id, versionId));
  const taken = new Set(existing.map((p) => p.id));
  let id = baseId;
  let n = 2;
  while (taken.has(id)) id = `${baseId}-${n++}`;

  const doc: Omit<PartialDoc, 'id'> = {
    name,
    kind: 'free',
    content_mode: 'html',
    html_content: '',
    status: 'draft',
  };
  await getStore().setDoc(paths.partial(owner_org_id, site.id, id, versionId), doc);
  return redirect(`/app/sites/${site.id}/partials/${id}`);
};
