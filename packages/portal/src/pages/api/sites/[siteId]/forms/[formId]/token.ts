// Mint an HMAC token for a form.
//
// The static site build embeds the returned token as the form's hidden
// `token` input (or as a `?token=…` query string on the form action URL).
// Tokens are stable for the lifetime of FORMS_HMAC_SECRET, so the build can
// fetch once and bake it into the static HTML.
//
// The endpoint is authenticated — only members of the form's org can mint a
// token for it. There's no expiry encoded in the signature: tokens are
// invalidated by rotating the server-side secret.

import type { APIRoute } from 'astro';
import { requireSiteAccess, json } from '../../../../../../lib/access';
import { getStore } from '../../../../../../lib/datastore';
import { paths } from '@typeroll/shared';
import type { Form } from '@typeroll/shared';
import { signFormToken, isFormsSigningConfigured } from '../../../../../../lib/forms-signing';
import { buildFormEmbedDirective } from '../../../../../../lib/forms-admin';

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { session, site, owner_org_id } = guard.value;
  const { formId } = params;
  if (!formId) return json({ error: 'Missing formId' }, 400);

  if (!isFormsSigningConfigured()) {
    return json(
      { error: 'FORMS_HMAC_SECRET is not configured on this server.' },
      503
    );
  }

  const form = await getStore().getDoc<Form>(`${paths.forms(owner_org_id, site.id)}/${formId}`);
  if (!form) return json({ error: 'Form not found' }, 404);

  const token = signFormToken(owner_org_id, site.id, formId);
  // The submit URL needs to point at the portal's API origin. In prod set
  // PORTAL_PUBLIC_URL; in dev it falls back to a relative path that works
  // only when the static site and portal share an origin.
  const apiBase = (process.env.PORTAL_PUBLIC_URL ?? '').replace(/\/$/, '');
  const submitUrl = `${apiBase}/api/forms/submit`;
  const snippet = buildFormEmbedDirective(formId);
  return json({
    token,
    submitUrl,
    snippet,
    snippet_kind: 'server_rendered_directive',
  });
};
