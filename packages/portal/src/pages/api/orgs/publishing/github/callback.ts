import { ConnectionError } from '../../../../../lib/publishing/connections';
import type { APIRoute } from 'astro';
import { finishGithubConnection, GITHUB_COOKIE, GithubFlowError, resumeGithubInstallation, startGithubConnection } from '../../../../../lib/publishing/github-connection';
import { publishingAdmin } from '../../../../../lib/publishing/http';

export const GET: APIRoute = async (context) => {
  const guard = await publishingAdmin(context);
  if (!guard.ok) return guard.response;
  let result = 'failed';
  let continuing = false;
  try {
    const state = context.url.searchParams.get('state') ?? '';
    const browser = context.cookies.get(GITHUB_COOKIE)?.value ?? '';
    if (state.startsWith('install_')) {
      const owner = await resumeGithubInstallation(guard.value, { state, browser });
      // Do not trust installation_id or exchange GitHub's installation-time code:
      // that implicit authorization did not carry our PKCE challenge.
      const next = await startGithubConnection(guard.value, owner);
      context.cookies.set(GITHUB_COOKIE, next.browser, { path: '/api/orgs/publishing/github', httpOnly: true,
        secure: process.env.NODE_ENV === 'production' || context.url.protocol === 'https:', sameSite: 'lax', maxAge: next.maxAge });
      continuing = true;
      return new Response(null, { status: 303, headers: { Location: next.url,
        'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
    }
    result = await finishGithubConnection(guard.value, { state: context.url.searchParams.get('state') ?? '',
      code: context.url.searchParams.get('code') ?? '', browser: context.cookies.get(GITHUB_COOKIE)?.value ?? '' });
  } catch (error) {
    if (error instanceof GithubFlowError) result = error.code;
    if (error instanceof ConnectionError && error.code === 'github_expiring_authorization_required') result = error.code;
    // Neither provider responses nor the OAuth code enter HTML, logs, or redirects.
  } finally { if (!continuing) context.cookies.delete(GITHUB_COOKIE, { path: '/api/orgs/publishing/github' }); }
  return new Response(null, { status: 303, headers: { Location: `/app/settings/publishing?github=${result}`,
    'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
};
