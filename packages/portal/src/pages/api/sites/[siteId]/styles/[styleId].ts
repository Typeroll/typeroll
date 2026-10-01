// Portal (session) routes: PATCH / DELETE one style.
import type { APIRoute } from 'astro';
import { requireSiteAccess, requirePermission, json } from '../../../../../lib/access';
import { deleteStyle, StyleError, updateStyle } from '../../../../../lib/site-styles-store';

const ctxOf = (value: { site: { id: string }; versionId: string; owner_org_id: string }) => ({ orgId: value.owner_org_id, siteId: value.site.id, versionId: value.versionId });

export const PATCH: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const check = requirePermission(guard.value, 'write');
  if (!check.ok) return check.response;
  try {
    return json({ style: await updateStyle(ctxOf(guard.value), params.styleId ?? '', await request.json().catch(() => null)) });
  } catch (error) {
    if (error instanceof StyleError) return json({ error: error.message, errors: error.errors }, error.status);
    throw error;
  }
};

export const DELETE: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const check = requirePermission(guard.value, 'write');
  if (!check.ok) return check.response;
  try {
    await deleteStyle(ctxOf(guard.value), params.styleId ?? '');
    return json({ ok: true });
  } catch (error) {
    if (error instanceof StyleError) return json({ error: error.message }, error.status);
    throw error;
  }
};
