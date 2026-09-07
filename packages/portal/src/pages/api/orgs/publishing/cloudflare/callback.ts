import type { APIRoute } from 'astro';
import { finishCloudflareConnection, CLOUDFLARE_COOKIE } from '../../../../../lib/publishing/cloudflare-oauth';
import { publishingAdmin } from '../../../../../lib/publishing/http';

export const GET: APIRoute = async (context) => {
  const guard = await publishingAdmin(context);
  if (!guard.ok) return guard.response;
  let result = 'failed';
  try {
    result = await finishCloudflareConnection(guard.value, { state: context.url.searchParams.get('state') ?? '',
      code: context.url.searchParams.get('code') ?? '', browser: context.cookies.get(CLOUDFLARE_COOKIE)?.value ?? '' });
  } catch { /* Provider responses and OAuth codes never enter logs or redirects. */ }
  finally { context.cookies.delete(CLOUDFLARE_COOKIE, { path: '/api/orgs/publishing/cloudflare' }); }
  return new Response(null, { status: 303, headers: { Location: `/app/settings/publishing?cloudflare=${result}`,
    'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
};
