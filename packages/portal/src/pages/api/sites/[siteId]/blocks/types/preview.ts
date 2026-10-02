// POST /api/sites/{siteId}/blocks/types/preview
//
// Render an unsaved block type definition the way a page renders it (site
// theme, named styles, custom CSS, render version, sanitizer, the other site
// block types). Body: `{ definition, data?, render_version?, type_id? }`;
// without `data` the block shows sample values derived from its fields.
// Answers `{ ok, html, css, document, data, render_version, problems }`;
// `document` is a standalone page for the builder's iframe. Block scripts
// never run in a preview. Nothing is written, so any site member may call it.

import type { APIRoute } from 'astro';
import { json, requireSiteAccess } from '../../../../../../lib/access';
import { previewBlockTypeDraft } from '../../../../../../lib/block-type-write';

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { site, versionId, owner_org_id, permission } = guard.value;
  const body = await request.json().catch(() => null);
  if (body === null) return json({ error: 'Invalid JSON' }, 400);
  const outcome = await previewBlockTypeDraft({ orgId: owner_org_id, siteId: site.id, versionId }, body, {
    allowScript: permission === 'admin',
  });
  return json(outcome.body, outcome.status);
};
