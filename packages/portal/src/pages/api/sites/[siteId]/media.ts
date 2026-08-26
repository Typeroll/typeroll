import type { APIRoute } from 'astro';
import { requireSiteAccess, json } from '../../../../lib/access';
import { getStore } from '../../../../lib/datastore';
import { paths } from '@typeroll/shared';
import type { Media } from '@typeroll/shared';

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { session, site, owner_org_id } = guard.value;

  const list = await getStore().listDocs<Media>(paths.media(owner_org_id, site.id));
  list.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
  return json(list);
};
