import type { APIRoute } from 'astro';
import { paths, type Form } from '@typeroll/shared';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../lib/api-auth';
import { getStore } from '../../../../../../../lib/datastore';
import { runBeforeActions, runFormActions } from '../../../../../../../lib/forms/actions';
export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (!ctx.extensionIdentity?.scopes.includes('forms:execute') || !params.formId) return apiError('An action-authorized installation credential is required', 403);
  const form = await getStore().getDoc<Form>(`${paths.forms(ctx.orgId, ctx.siteId)}/${params.formId}`);
  if (!form || form.target?.installation_id !== ctx.extensionIdentity.installationId) return apiError('Form not found', 404);
  const body = await request.json().catch(() => null);
  if (!body || !['before', 'after'].includes(body.phase) || !body.data || typeof body.data !== 'object' || Array.isArray(body.data)) return apiError('Invalid action request');
  const actionContext = { orgId: ctx.orgId, siteId: ctx.siteId, formId: params.formId, data: body.data,
    ...(typeof body.page_id === 'string' ? { subject: { kind: 'page' as const, id: body.page_id } } : {}) };
  if (body.phase === 'before') {
    const verdict = await runBeforeActions(form, actionContext);
    return apiResponse(ctx, verdict, verdict.ok ? 200 : 409);
  }
  return apiResponse(ctx, await runFormActions(form, actionContext));
};
