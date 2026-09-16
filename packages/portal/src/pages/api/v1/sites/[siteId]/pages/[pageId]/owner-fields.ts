import type { APIRoute } from 'astro';
import { PAGE_BUILTIN_FIELDS, pageAuthorityFields, pageContentValues } from '@typeroll/shared';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../lib/api-auth';
import { vstore } from '../../../../../../../lib/version-store';
import { applyFieldAuthority, conflictResponse, PROVENANCE_KEY, writableBy } from '../../../../../../../lib/field-authority';
import { validatePageFields } from '../../../../../../../lib/page-fields';
import { sanitizeBody } from '../../../../../../../lib/sanitize';
import { markSiteDirty } from '../../../../../../../lib/auto-deploy';

/** The provider authenticates its visitor; only an explicitly granted server credential may use this surface. */
const handle: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (!ctx.extensionIdentity?.scopes.includes('content:owner')) return apiError('An owner-authorized installation credential is required', 403);
  const pageId = params.pageId;
  if (!pageId) return apiError('Missing Page ID', 400);
  const page = await vstore.page(ctx.orgId, ctx.siteId, ctx.versionId, pageId);
  if (!page?.content_type) return apiError('Page not found', 404);
  const type = await vstore.contentType(ctx.orgId, ctx.siteId, ctx.versionId, page.content_type);
  if (!type) return apiError('Content type not found', 404);
  const fields = pageAuthorityFields(type).filter(field => writableBy(field).includes('owner'));
  const values = pageContentValues(page);
  if (request.method === 'GET') {
    const response = apiResponse(ctx, { page_id: pageId, content_type: type.id,
    fields: fields.map(field => ({ ...field, value: values[field.name] ?? null })) });
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  }
  const body = await request.json().catch(() => null);
  if (!body || Array.isArray(body) || typeof body !== 'object') return apiError('Expected a field patch', 400);
  const names = new Set(fields.map(field => field.name));
  if (Object.keys(body).some(name => !names.has(name))) return apiError('The patch contains a field that is not owner-writable', 403);
  const invalid = validatePageFields({ ...type, fields: fields.filter(field => field.name in body) }, body, true);
  if (invalid) return apiError(invalid, 400);
  function clean(value: unknown, definition: typeof fields[number]): unknown {
    if (value == null) return value;
    if (definition.type === 'richtext' && typeof value === 'string') return sanitizeBody(value);
    if (definition.type === 'object' && definition.fields && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key,child]) => [key, clean(child, definition.fields!.find(field => field.name === key)!)]));
    if (['array','list'].includes(definition.type) && definition.fields && Array.isArray(value)) return value.map(child => clean(child, { ...definition, type: 'object' }));
    return value;
  }
  for (const field of fields) if (field.name in body) body[field.name] = clean(body[field.name], field);
  const result = applyFieldAuthority({ fields, incoming: body, existing: page, actor: 'owner', actorId: `extension:${ctx.extensionIdentity.installationId}` });
  if (result.rejected.length) return apiResponse(ctx, conflictResponse(result.rejected), 409);
  await vstore.writePage(ctx.orgId, ctx.siteId, ctx.versionId, pageId, {
    ...Object.fromEntries(Object.entries(result.update).filter(([name]) => PAGE_BUILTIN_FIELDS.has(name))),
    fields: { ...page.fields, ...Object.fromEntries(Object.entries(result.update).filter(([name]) => !PAGE_BUILTIN_FIELDS.has(name))) },
    [PROVENANCE_KEY]: result.provenance, date_updated: new Date().toISOString(),
  });
  if (ctx.versionId === 'main') await markSiteDirty(ctx.orgId, ctx.siteId);
  return apiResponse(ctx, { ok: true, updated_fields: Object.keys(result.update) }, 200, body);
};
export const GET = handle;
export const PUT = handle;
