// GET  /api/v1/sites/{siteId}/block-types
// POST /api/v1/sites/{siteId}/block-types  → create a site block type
//
// GET lists every block type usable on this site: core (always available,
// shipped in code) + the site's own (made in the portal or by an agent) +
// third-party (imported from .tcblocks packages).
//
// POST creates a block type through lib/block-type-write.ts, the write path
// every surface shares: the shared validator (unknown properties, field
// definitions, bindings, template sections and CSS are checked; each problem
// has a JSON-pointer path), the version chain, and `id = name`. Origin is
// 'ai' when the MCP adapter marks the request (`?origin=ai`), otherwise
// 'user'. Needs admin permission on the site.
//
// 400 → `{ error, problems }`; 409 → the name exists. 200 → `{ block_type,
// warnings }`. PATCH + DELETE per type live in [typeId].ts; validate,
// preview and starters have their own routes beside this one.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { vstore } from '../../../../../../lib/version-store';
import { CORE_BLOCK_TYPES, type BlockOrigin, type BlockType } from '@typeroll/shared';
import { BLOCK_TYPE_ADMIN_REQUIRED, blockTypeView, createSiteBlockType } from '../../../../../../lib/block-type-write';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const url = new URL(request.url);
  const includeCore = url.searchParams.get('include_core') !== 'false';

  const custom = await vstore.blockTypes(ctx.orgId, ctx.siteId, ctx.versionId);
  const merged: BlockType[] = includeCore
    ? [
        // template_content_slot is a marker block used inside
        // PageTemplate composition, not a content block — hide it
        // from the discovery list. Templates UI exposes it separately.
        ...CORE_BLOCK_TYPES.filter((b) => b.id !== 'template_content_slot'),
        ...custom.map(blockTypeView),
      ]
    : custom.map(blockTypeView);

  return apiResponse(ctx, { block_types: merged });
};

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.permission !== 'admin') return apiError(BLOCK_TYPE_ADMIN_REQUIRED, 403, ctx);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return apiError('Invalid JSON', 400, ctx);

  // `script` through an API key is accepted under the key holder's authority
  // (same trust level as scripts_head and as a person in the portal). The
  // write is audit-logged by apiResponse. See lib/block-script-gate.ts.
  const origin: BlockOrigin = new URL(request.url).searchParams.get('origin') === 'ai' ? 'ai' : 'user';
  const outcome = await createSiteBlockType(ctx, body, { origin, allowScript: true });
  if (!outcome.ok) return apiResponse(ctx, outcome.body, outcome.status, body);
  return apiResponse(ctx, { ...outcome.body, block_type: blockTypeView(outcome.body.block_type) }, 200, body);
};
