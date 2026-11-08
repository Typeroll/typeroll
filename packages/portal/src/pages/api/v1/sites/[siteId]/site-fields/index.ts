// GET   /api/v1/sites/{siteId}/site-fields   — definitions and values
// PUT   /api/v1/sites/{siteId}/site-fields   — replace the definitions (design: site admin or builder)
//   body: { groups, expected_updated_at? }
// PATCH /api/v1/sites/{siteId}/site-fields   — change values (merge; null removes)
//   body: { values, expected_updated_at? }
//
// Site fields are settings pages (groups of typed fields) a builder defines
// and editors fill in. Values in a group with access "admin" need site admin;
// other values need write permission. Saves are revision checked: send the
// `updated_at` you read as `expected_updated_at` ('' when nothing was saved
// yet) and a save made in between is refused with 409. Every save keeps the
// previous document as a revision and reaches the live site with the next
// publication. Invalid input answers 400 with `errors: [{ path, message }]`.

import type { APIRoute } from 'astro';
import { apiCanDesign, apiError, apiResponse, requireApiKey, withApiIdentity, type ApiContext } from '../../../../../../lib/api-auth';
import { json } from '../../../../../../lib/access';
import {
  defineSiteFields, readSiteFields, siteFieldsFailureBody, siteFieldsResponse, updateSiteFieldValues,
} from '../../../../../../lib/site-fields-write';

function failure(error: unknown, ctx: ApiContext): Response {
  const refused = siteFieldsFailureBody(error);
  if (!refused) throw error;
  return withApiIdentity(ctx, json(refused.body, refused.status));
}

async function readBody(request: Request, ctx: ApiContext): Promise<{ body: Record<string, unknown>; expected?: string } | Response> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return apiError('Invalid JSON body', 400, ctx);
  const expected = body.expected_updated_at;
  if (expected !== undefined && expected !== null && typeof expected !== 'string') return apiError('expected_updated_at must be the updated_at string you read', 400, ctx);
  return { body, ...(typeof expected === 'string' ? { expected } : expected === null ? { expected: '' } : {}) };
}

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  return apiResponse(ctx, siteFieldsResponse(await readSiteFields(ctx), ctx.permission));
};

export const PUT: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (!apiCanDesign(ctx)) return apiError('Defining site fields needs design permission on the site (an administrator or builder)', 403, ctx);
  const parsed = await readBody(request, ctx);
  if (parsed instanceof Response) return parsed;
  if (!('groups' in parsed.body)) return apiError('Send the settings pages as groups', 400, ctx);
  try {
    const { siteFields, dropped } = await defineSiteFields(ctx, parsed.body.groups,
      { permission: ctx.permission, design: apiCanDesign(ctx), updatedBy: `api-key:${ctx.keyPrefix}`, expectedUpdatedAt: parsed.expected });
    return apiResponse(ctx, { ...siteFieldsResponse(siteFields, ctx.permission), dropped_values: dropped }, 200, parsed.body);
  } catch (error) { return failure(error, ctx); }
};

export const PATCH: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const parsed = await readBody(request, ctx);
  if (parsed instanceof Response) return parsed;
  if (!('values' in parsed.body)) return apiError('Send the values to change as values', 400, ctx);
  try {
    const siteFields = await updateSiteFieldValues(ctx, parsed.body.values,
      { permission: ctx.permission, updatedBy: `api-key:${ctx.keyPrefix}`, expectedUpdatedAt: parsed.expected });
    return apiResponse(ctx, siteFieldsResponse(siteFields, ctx.permission), 200, parsed.body);
  } catch (error) { return failure(error, ctx); }
};
