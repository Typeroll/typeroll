// GET  /api/v1/sites/{siteId}/styles  — the site's named style library
// POST /api/v1/sites/{siteId}/styles  — create a style
//
// Styles live in SiteSettings.styles and are versioned with the settings.
// Writes validate values, unique ids/roles and text contrast (WCAG AA).

import type { APIRoute } from 'astro';
import { apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { createStyle, libraryProblems, readStyles, StyleError } from '../../../../../../lib/site-styles-store';
import { STANDARD_STYLES } from '@typeroll/shared';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const { styles, colors } = await readStyles(ctx);
  const roles = new Set(styles.map(style => style.role).filter(Boolean));
  return apiResponse(ctx, {
    styles,
    missing_standard_roles: STANDARD_STYLES.map(style => style.role!).filter(role => !roles.has(role)),
    problems: libraryProblems(styles, colors),
  });
};

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const body = await request.json().catch(() => null);
  try {
    const style = await createStyle(ctx, body);
    return apiResponse(ctx, { style }, 201, body);
  } catch (error) {
    if (error instanceof StyleError) return apiResponse(ctx, { error: error.message, errors: error.errors }, error.status, body);
    throw error;
  }
};
