// Where an app-backed form POSTs.
//
// The forms module is app-agnostic: a Form declares `target.app` and the two
// generic behaviours it wants, and something outside resolves that name into
// a URL. This is that something — and it lives in ONE place because there are
// two callers that must agree: the deploy runner (bakes submit_url into the
// build snapshot) and render-preview (mints it live for the editor).
//
// They drifted the moment this existed as two code paths: the preview called
// formEmbedInfo unconditionally, so a directory edit form previewed as posting
// to the submissions collector. It looked right and would have collected
// listing edits as form submissions.

import { getAppDef } from './registry';
import type { Form } from '@typeroll/shared';

export interface FormEndpoint {
  submit_url: string;
  /** App-backed forms carry no forms HMAC or proof-of-work — their authority
   *  is whatever session the runtime holds, not a token minted at build time. */
  submit_token: null;
  pow_bits: 0;
}

/**
 * Resolve a form's app-owned endpoint, or null when it's an ordinary form
 * (or names an app that declares none — in which case the caller falls back
 * to the submissions collector rather than emitting a form that posts
 * nowhere).
 *
 * Deliberately does NOT check whether the app is enabled: the endpoint itself
 * refuses when it isn't, with a message the visitor can act on. Silently
 * re-pointing the form at the submissions collector would be worse — the edit
 * would look accepted and land somewhere nobody reads.
 */
export function resolveAppFormEndpoint(
  form: Pick<Form, 'target'>,
  args: { siteId: string; portalUrl: string },
): FormEndpoint | null {
  const app = form.target?.app;
  if (!app) return null;
  const url = getAppDef(app)?.formEndpoint?.({ ...args, form: form.target?.form });
  if (!url) return null;
  return { submit_url: url, submit_token: null, pow_bits: 0 };
}
