// GET   /api/sites/{siteId}/site-fields   — definitions, values and the
//       settings pages this person may fill in (editable_groups)
// PUT   /api/sites/{siteId}/site-fields   — replace the definitions (site admin)
//       JSON: { groups, expected_updated_at? }
// PATCH /api/sites/{siteId}/site-fields   — change values (merge; null removes)
//       JSON: { values, expected_updated_at? }
//
// The portal's session routes for the settings pages; they share the v1 save
// path (validation, permissions per group, revision check, revisions).

import type { APIRoute } from 'astro';
import { requireSiteAccess, json, requirePermission } from '../../../../../lib/access';
import {
  defineSiteFields, readSiteFields, siteFieldsFailureBody, siteFieldsResponse, updateSiteFieldValues,
} from '../../../../../lib/site-fields-write';

function failure(error: unknown): Response {
  const refused = siteFieldsFailureBody(error);
  if (!refused) throw error;
  return json(refused.body, refused.status);
}

async function readBody(request: Request): Promise<{ body: Record<string, unknown>; expected?: string } | Response> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Invalid JSON body' }, 400);
  const expected = body.expected_updated_at;
  if (expected !== undefined && expected !== null && typeof expected !== 'string') return json({ error: 'expected_updated_at must be a string' }, 400);
  return { body, ...(typeof expected === 'string' ? { expected } : expected === null ? { expected: '' } : {}) };
}

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { site, versionId, owner_org_id, permission } = guard.value;
  return json(siteFieldsResponse(await readSiteFields({ orgId: owner_org_id, siteId: site.id, versionId }), permission));
};

export const PUT: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const adminCheck = requirePermission(guard.value, 'admin');
  if (!adminCheck.ok) return adminCheck.response;
  const { session, site, versionId, owner_org_id, permission } = guard.value;
  const parsed = await readBody(request);
  if (parsed instanceof Response) return parsed;
  if (!('groups' in parsed.body)) return json({ error: 'Send the settings pages as groups' }, 400);
  try {
    const { siteFields, dropped } = await defineSiteFields({ orgId: owner_org_id, siteId: site.id, versionId }, parsed.body.groups,
      { permission, updatedBy: session.email ?? 'unknown', expectedUpdatedAt: parsed.expected });
    return json({ ...siteFieldsResponse(siteFields, permission), dropped_values: dropped });
  } catch (error) { return failure(error); }
};

export const PATCH: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { session, site, versionId, owner_org_id, permission } = guard.value;
  const parsed = await readBody(request);
  if (parsed instanceof Response) return parsed;
  if (!('values' in parsed.body)) return json({ error: 'Send the values to change as values' }, 400);
  try {
    const siteFields = await updateSiteFieldValues({ orgId: owner_org_id, siteId: site.id, versionId }, parsed.body.values,
      { permission, updatedBy: session.email ?? 'unknown', expectedUpdatedAt: parsed.expected });
    return json(siteFieldsResponse(siteFields, permission));
  } catch (error) { return failure(error); }
};
