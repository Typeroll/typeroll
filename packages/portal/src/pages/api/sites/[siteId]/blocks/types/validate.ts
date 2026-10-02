// POST /api/sites/{siteId}/blocks/types/validate[?type_id=…]
//
// Check a block type definition without saving it: the builder calls this
// as the author types. Body = the definition; with `?type_id=` it is a patch
// to that stored type (`renames` allowed). Answers `{ ok, problems, merged }`,
// where each problem has a severity, a JSON-pointer path and, for markup and
// CSS, a line. Nothing is written, so any site member may call it.

import type { APIRoute } from 'astro';
import { json, requireSiteAccess } from '../../../../../../lib/access';
import { validateBlockTypeDraft } from '../../../../../../lib/block-type-write';

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { site, versionId, owner_org_id, permission } = guard.value;
  const body = await request.json().catch(() => null);
  if (body === null) return json({ error: 'Invalid JSON' }, 400);
  const typeId = new URL(request.url).searchParams.get('type_id') ?? undefined;
  const outcome = await validateBlockTypeDraft({ orgId: owner_org_id, siteId: site.id, versionId }, body, {
    typeId, allowScript: permission === 'admin',
  });
  return json(outcome.body, outcome.status);
};
