// Portal (session) routes for the style library editor.
// GET  — styles plus the site colours the editor needs for previews/contrast
// POST — create a style
import type { APIRoute } from 'astro';
import { requireSiteAccess, requirePermission, json } from '../../../../../lib/access';
import { createStyle, libraryProblems, readStyles, StyleError } from '../../../../../lib/site-styles-store';

const ctxOf = (value: { site: { id: string }; versionId: string; owner_org_id: string }) => ({ orgId: value.owner_org_id, siteId: value.site.id, versionId: value.versionId });

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { styles, colors } = await readStyles(ctxOf(guard.value));
  return json({ styles, colors, problems: libraryProblems(styles, colors) });
};

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const check = requirePermission(guard.value, 'write');
  if (!check.ok) return check.response;
  try {
    return json({ style: await createStyle(ctxOf(guard.value), await request.json().catch(() => null)) }, 201);
  } catch (error) {
    if (error instanceof StyleError) return json({ error: error.message, errors: error.errors }, error.status);
    throw error;
  }
};
