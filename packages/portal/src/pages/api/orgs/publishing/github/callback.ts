import type { APIRoute } from 'astro';
import {
  finishGithubConnection, GITHUB_COOKIE, GithubFlowError, recordGithubCallbackError, recordGithubFlowFailure,
  resumeGithubInstallation, startGithubConnection,
} from '../../../../../lib/publishing/github-connection';
import { publishingAdmin } from '../../../../../lib/publishing/http';

const SETTINGS = '/app/settings/publishing';
const redirect = (location: string) => new Response(null, { status: 303, headers: { Location: location,
  'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });

// The result is persisted as the organization's GitHub diagnosis. The query
// parameter only tells the page that the person has just returned.
// `state_expired` means the request matched no sign-in this person started in
// this browser; it can come from a link on any site, so nothing is recorded.
export const GET: APIRoute = async (context) => {
  const guard = await publishingAdmin(context);
  if (!guard.ok) {
    // The Typeroll session ended while the person was on GitHub. Nothing can be
    // completed without it; send them to sign in and back to the GitHub card.
    if (guard.response.status === 401) {
      context.cookies.delete(GITHUB_COOKIE, { path: '/api/orgs/publishing/github' });
      return redirect(`/login?next=${encodeURIComponent(`${SETTINGS}?github=session_expired#github`)}`);
    }
    return guard.response;
  }
  let result = 'retryable_error';
  let continuing = false;
  try {
    const parameters = context.url.searchParams;
    const state = parameters.get('state') ?? '';
    const browser = context.cookies.get(GITHUB_COOKIE)?.value ?? '';
    const oauthError = parameters.get('error');
    if (oauthError) {
      result = (await recordGithubCallbackError(guard.value, { error: oauthError, state, browser }))?.outcome ?? 'state_expired';
    } else if (state.startsWith('install_')) {
      const resumed = await resumeGithubInstallation(guard.value, { state, browser, setupAction: parameters.get('setup_action') });
      if (resumed.waiting) {
        result = resumed.diagnosis.outcome;
      } else {
        // Do not trust installation_id or exchange GitHub's installation-time code:
        // that implicit authorization did not carry our PKCE challenge.
        const next = await startGithubConnection(guard.value, resumed.owner);
        context.cookies.set(GITHUB_COOKIE, next.browser, { path: '/api/orgs/publishing/github', httpOnly: true,
          secure: process.env.NODE_ENV === 'production' || context.url.protocol === 'https:', sameSite: 'lax', maxAge: next.maxAge });
        continuing = true;
        return redirect(next.url);
      }
    } else {
      const finished = await finishGithubConnection(guard.value, { state, code: parameters.get('code') ?? '', browser });
      result = finished === 'select' ? 'choose' : 'connected';
    }
  } catch (error) {
    // Neither provider responses nor the OAuth code enter HTML, logs, or redirects.
    const diagnosis = error instanceof GithubFlowError ? error.diagnosis : await recordGithubFlowFailure(guard.value, error);
    result = diagnosis?.outcome ?? (error instanceof GithubFlowError && error.unrecorded ? 'state_expired' : 'retryable_error');
  } finally { if (!continuing) context.cookies.delete(GITHUB_COOKIE, { path: '/api/orgs/publishing/github' }); }
  return redirect(`${SETTINGS}?github=${result}#github`);
};
