import type { APIRoute } from 'astro';
import { getPageTemplateStarter, getPartialCompositionStarter, getArchiveCompositionStarter, type PageTemplateStarterKind } from '@typeroll/shared';
import { apiError, apiResponse, requireApiKey } from '../../../../../lib/api-auth';

/** Read one native editable composition. Never changes a Page or partial. */
export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const query = new URL(request.url).searchParams;
  const kind = query.get('kind') ?? '';
  let blocks;
  if (kind === 'header' || kind === 'footer') {
    blocks = getPartialCompositionStarter(kind, { links: [{ label: 'Home', href: '/' }] });
  } else if (kind === 'archive') {
    const contentType = query.get('content_type');
    if (!contentType?.trim()) return apiError('content_type is required for an archive starter', 400);
    blocks = getArchiveCompositionStarter({ content_type: contentType, title: query.get('title') || 'Pages' });
  } else {
    blocks = getPageTemplateStarter(kind as PageTemplateStarterKind);
  }
  if (!blocks) return apiError('Choose header, footer, archive, custom, article, blog, checklist, team, events, products, profile or landing', 400);
  return apiResponse(guard.value, { kind, blocks, saved: false });
};
