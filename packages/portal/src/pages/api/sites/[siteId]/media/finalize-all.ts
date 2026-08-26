// POST /api/sites/{siteId}/media/finalize-all  (session-cookie auth)
//
// Backfill the entire library — applies cache headers + generates
// variants on every media item missing them. Session-cookie sibling of
// the v1 finalize-all endpoint; admin permission required since this
// can do a lot of R2 work.

import type { APIRoute } from 'astro';
import { requireSiteAccess, requirePermission, json } from '../../../../../lib/access';
import { finalizeAllMedia } from '../../../../../lib/media-finalize';

export const POST: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const adminCheck = requirePermission(guard.value, 'admin');
  if (!adminCheck.ok) return adminCheck.response;
  const { site, owner_org_id } = guard.value;

  const accountId = process.env.R2_ACCOUNT_ID;
  const bucket = process.env.R2_BUCKET;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const publicBase = process.env.R2_PUBLIC_BASE_URL;
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey || !publicBase) {
    return json({ error: 'R2 is not configured on this server' }, 503);
  }

  try {
    const result = await finalizeAllMedia(owner_org_id, site.id, {
      accountId, bucket, accessKeyId, secretAccessKey, publicBase,
    });
    return json({ ok: true, ...result });
  } catch (e) {
    return json(
      { error: `Bulk finalize failed: ${e instanceof Error ? e.message : String(e)}` },
      500,
    );
  }
};
