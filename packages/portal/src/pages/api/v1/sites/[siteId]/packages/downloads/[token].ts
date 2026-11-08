// GET /api/v1/sites/{siteId}/packages/downloads/{token}   — a package stored by
//     POST .../packages/export, for one hour after the export.
//
// The signed token is the credential (no API key), so the address can be
// handed to a browser or a download tool. An unknown, expired or altered
// token answers 404.

import type { APIRoute } from 'astro';
import { SITE_PACKAGE_MEDIA_TYPE } from '@typeroll/shared';
import { readPackageDownload } from '../../../../../../../lib/packages/package-download';

export const GET: APIRoute = async ({ params }) => {
  const download = await readPackageDownload(params.token, params.siteId);
  if (!download) return new Response(JSON.stringify({ error: 'This download has expired or does not exist. Export the package again.', code: 'package_download_expired' }), { status: 404, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  return new Response(new Uint8Array(download.bytes), {
    status: 200,
    headers: {
      'Content-Type': SITE_PACKAGE_MEDIA_TYPE,
      'Content-Disposition': `attachment; filename="${download.filename}"`,
      'Cache-Control': 'private, no-store',
      'Typeroll-Package-Sha256': download.sha256,
      'X-Content-Type-Options': 'nosniff',
    },
  });
};
