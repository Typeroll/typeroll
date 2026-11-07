import type { APIRoute } from 'astro';
import { getPageTemplateStarter, getPartialCompositionStarter, getArchiveCompositionStarter, getPageBodyStarter, isPageBodyStarterKind, type PageTemplateStarterKind } from '@typeroll/shared';
import { resolveRenderVersion } from '@typeroll/shared';
import { apiError, apiResponse, requireApiKey } from '../../../../../lib/api-auth';
import { vstore } from '../../../../../lib/version-store';

/** Read one native editable composition. Never changes a Page or partial. */
export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const query = new URL(request.url).searchParams;
  const kind = query.get('kind') ?? '';
  let blocks;
  if (kind === 'header' || kind === 'footer') {
    // From render version 15 the starter shows the site's primary and footer menus.
    const settings = await vstore.settings(guard.value.orgId, guard.value.siteId, guard.value.versionId);
    blocks = getPartialCompositionStarter(kind, { links: [{ label: 'Home', href: '/' }], renderVersion: resolveRenderVersion(settings?.render_version) });
  } else if (kind === 'archive') {
    const contentType = query.get('content_type');
    if (!contentType?.trim()) return apiError('content_type is required for an archive starter', 400);
    blocks = getArchiveCompositionStarter({ content_type: contentType, title: query.get('title') || 'Pages' });
  } else if (isPageBodyStarterKind(kind)) {
    // A Page body for a common marketing page, not a Page template.
    blocks = getPageBodyStarter(kind);
  } else {
    blocks = getPageTemplateStarter(kind as PageTemplateStarterKind);
  }
  if (!blocks) return apiError('Choose header, footer, archive, custom, article, blog, checklist, team, events, products, profile, landing, feature_page, comparison_page, integration_page, pricing_page or use_case_page', 400);
  return apiResponse(guard.value, { kind, blocks, saved: false });
};
