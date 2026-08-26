import type { APIRoute } from 'astro';
import { requireSiteAccess, json } from '../../../../../lib/access';

/**
 * Lightweight pre-flight for the media library. Returns whether uploads can
 * actually go through (i.e. whether R2 is configured server-side) so the UI
 * can surface a banner instead of leaving the user to discover the failure
 * by trying to upload.
 */
export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;

  const accountId = process.env.R2_ACCOUNT_ID;
  const bucket = process.env.R2_BUCKET;
  const publicBase = process.env.R2_PUBLIC_BASE_URL;
  const accessKey = process.env.R2_ACCESS_KEY_ID;
  const secretKey = process.env.R2_SECRET_ACCESS_KEY;

  const missing = [
    !accountId && 'R2_ACCOUNT_ID',
    !bucket && 'R2_BUCKET',
    !publicBase && 'R2_PUBLIC_BASE_URL',
    !accessKey && 'R2_ACCESS_KEY_ID',
    !secretKey && 'R2_SECRET_ACCESS_KEY',
  ].filter(Boolean) as string[];

  if (missing.length > 0) {
    return json({
      enabled: false,
      reason: `Media uploads require Cloudflare R2 credentials. Missing on the server: ${missing.join(', ')}.`,
      missing,
    });
  }
  return json({ enabled: true });
};
