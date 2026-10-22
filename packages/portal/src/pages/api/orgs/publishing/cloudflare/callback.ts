import type { APIRoute } from 'astro';
import {
  CLOUDFLARE_COOKIE, cloudflareCallbackGroup, CloudflareFlowError, cloudflareUpdateContinuation, finishCloudflareConnection, recordCloudflareCallbackError,
  recordCloudflareFlowFailure, startCloudflareConnection,
} from '../../../../../lib/publishing/cloudflare-oauth';
import { publishingAdmin } from '../../../../../lib/publishing/http';

const SETTINGS = '/app/settings/publishing';
const COOKIE_PATH = '/api/orgs/publishing/cloudflare';
const redirect = (location: string) => new Response(null, { status: 303, headers: { Location: location,
  'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
/** The Cloudflare card of a Hosting Group: Default lives in organization Publishing, others in Hosting Groups. */
const card = (result: string, groupId: string) => groupId === 'default' ? `${SETTINGS}?cloudflare=${result}#cloudflare`
  : `${SETTINGS}?cloudflare=${result}&hosting_group=${encodeURIComponent(groupId)}#hosting-${encodeURIComponent(groupId)}`;

// The result is persisted as the Hosting Group's Cloudflare diagnosis. The
// query parameter only tells the page that the person has just returned:
// `connected`, `choose` or the diagnosis outcome. `state_expired` means the
// request matched no sign-in this person started in this browser; it can come
// from a link on any site, so nothing is recorded.
export const GET: APIRoute = async (context) => {
  const guard = await publishingAdmin(context);
  if (!guard.ok) {
    // The Typeroll session ended while the person was on Cloudflare. Nothing can be
    // completed without it; send them to sign in and back to the Cloudflare card.
    if (guard.response.status === 401) {
      context.cookies.delete(CLOUDFLARE_COOKIE, { path: COOKIE_PATH });
      return redirect(`/login?next=${encodeURIComponent(`${SETTINGS}?cloudflare=session_expired#cloudflare`)}`);
    }
    return guard.response;
  }
  const parameters = context.url.searchParams;
  const state = parameters.get('state') ?? '';
  const browser = context.cookies.get(CLOUDFLARE_COOKIE)?.value ?? '';
  let result = 'retryable_error';
  let groupId = 'default';
  try {
    groupId = await cloudflareCallbackGroup(guard.value, state);
    const oauthError = parameters.get('error');
    if (oauthError) {
      result = (await recordCloudflareCallbackError(guard.value, { error: oauthError, state, browser }))?.outcome ?? 'state_expired';
    } else {
      result = await finishCloudflareConnection(guard.value, { state, code: parameters.get('code') ?? '', browser }) === 'select' ? 'choose' : 'connected';
    }
  } catch (error) {
    // Neither provider responses nor the OAuth code enter HTML, logs, or redirects.
    const diagnosis = error instanceof CloudflareFlowError ? error.diagnosis : await recordCloudflareFlowFailure(guard.value, error, groupId);
    result = diagnosis?.outcome ?? (error instanceof CloudflareFlowError && error.unrecorded ? 'state_expired' : 'retryable_error');
  } finally { context.cookies.delete(CLOUDFLARE_COOKIE, { path: COOKIE_PATH }); }
  if (result === 'connected') {
    // A permission update renews every connection of this Organization that uses the same Cloudflare account:
    // continue with the next one. Any failure returns to the card of the connection that just finished.
    try {
      const continuation = await cloudflareUpdateContinuation(guard.value, state, groupId);
      if (continuation) {
        const next = await startCloudflareConnection(guard.value, continuation.next, false, false, { then: continuation.then });
        context.cookies.set(CLOUDFLARE_COOKIE, next.browser, { path: COOKIE_PATH, httpOnly: true,
          secure: process.env.NODE_ENV === 'production' || context.url.protocol === 'https:', sameSite: 'lax', maxAge: next.maxAge });
        return redirect(next.url);
      }
    } catch { /* The finished connection is saved; the other card still offers Approve update. */ }
  }
  return redirect(card(result, groupId));
};
