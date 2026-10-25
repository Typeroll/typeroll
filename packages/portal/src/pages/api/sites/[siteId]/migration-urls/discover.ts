import type { APIRoute } from 'astro';
import { requireSiteAccess, requirePermission, json } from '../../../../../lib/access';
import { requireImportStorage } from '../../../../../lib/media/import-policy';
import { connectionFailure } from '../../../../../lib/publishing/http';
import { getStore } from '../../../../../lib/datastore';
import { discoverPublicWordPress } from '../../../../../lib/wp/public-inventory';
import { addInventoryUrls, analyzeCoverage } from '../../../../../lib/wp/url-inventory';

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { owner_org_id: orgId, site, versionId } = guard.value;
  try { await requireImportStorage(orgId); } catch (error) { return connectionFailure(error); }
  const body = await request.json().catch(() => null);
  if (typeof body?.source_origin !== 'string') return json({error:'Enter the public HTTPS address of the source WordPress website.'},400);
  try {
    const result = await discoverPublicWordPress(body.source_origin,{crawlPages:10});
    const imported = await addInventoryUrls(getStore(),orgId,site.id,result.urls.map(url => ({url,source:'public_wordpress'})),{defaultSource:'public_wordpress',sourceOrigin:new URL(body.source_origin).origin});
    return json({...imported, discovery:{...result,urls:undefined}, coverage:await analyzeCoverage(getStore(),orgId,site.id,versionId)});
  } catch (error) { return json({error:error instanceof Error ? error.message : 'Public URL discovery failed.'},400); }
};
