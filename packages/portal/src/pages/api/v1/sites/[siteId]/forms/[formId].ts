// GET    /api/v1/sites/{siteId}/forms/{formId}
// PATCH  /api/v1/sites/{siteId}/forms/{formId}
// DELETE /api/v1/sites/{siteId}/forms/{formId}

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { getStore } from '../../../../../../lib/datastore';
import { formEmbedInfo } from '../../../../../../lib/forms-signing';
import { paths, fieldsToSteps } from '@typeroll/shared';
import type { Form, FormField } from '@typeroll/shared';
import { validateFields, validSteps } from '../../../../../../lib/forms-admin';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const formId = params.formId;
  if (!formId) return apiError('Missing formId');
  const doc = await getStore().getDoc<Form>(`${paths.forms(ctx.orgId, ctx.siteId)}/${formId}`);
  if (!doc) return apiError('Not found', 404);
  // submit_token + submit_url are what an agent needs to embed a working
  // form: hidden `_token` input + absolute action URL. The token is stable
  // until FORMS_HMAC_SECRET rotates, so baking it into static HTML is fine.
  return apiResponse(ctx, { form: { ...doc, actions: [] }, ...formEmbedInfo(ctx.orgId, ctx.siteId, formId) });
};

export const PATCH: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const formId = params.formId;
  if (!formId) return apiError('Missing formId');
  const store = getStore();
  const existing = await store.getDoc<Form>(`${paths.forms(ctx.orgId, ctx.siteId)}/${formId}`);
  if (!existing) return apiError('Not found', 404);
  const body = (await request.json().catch(() => null)) as Partial<Form> | null;
  if (!body) return apiError('Invalid JSON body');

  const update: Partial<Form> = {};
  if (body.name !== undefined) update.name = String(body.name);
  if (body.submit_text !== undefined) update.submit_text = String(body.submit_text);
  if (body.success_message !== undefined) update.success_message = String(body.success_message);
  // `actions` (email notifications) are admin-only — the API-key / MCP write
  // path can't add, change, or remove them. They survive untouched here.
  if (body.steps !== undefined) {
    if (!validSteps(body.steps)) return apiError('steps must be a non-empty array of { id, blocks?, render?: static|dynamic, next? } with unique ids');
    update.steps = body.steps;
  }
  if (body.styles !== undefined) update.styles = String(body.styles);
  if (body.kind !== undefined) update.kind = String(body.kind);
  if (body.partial_ttl_days !== undefined) update.partial_ttl_days = Number(body.partial_ttl_days);
  // Flat `fields` is authoring sugar: it REPLACES the whole step list with
  // one static step (mirroring how `fields` always replaced the full field
  // list). Explicit `steps` in the same body wins.
  const bodyFields = (body as { fields?: FormField[] }).fields;
  if (body.steps === undefined && bodyFields !== undefined) {
    const fields = validateFields(bodyFields);
    if (typeof fields === 'string') return apiError(fields);
    update.steps = fieldsToSteps(fields);
  }
  if (Object.keys(update).length === 0) return apiError('No writable fields in body');

  await store.setDoc(
    `${paths.forms(ctx.orgId, ctx.siteId)}/${formId}`,
    { ...existing, ...update },
  );
  const fresh = await store.getDoc<Form>(`${paths.forms(ctx.orgId, ctx.siteId)}/${formId}`);
  return apiResponse(ctx, { form: fresh ? { ...fresh, actions: [] } : fresh, ...formEmbedInfo(ctx.orgId, ctx.siteId, formId) }, 200, body);
};

export const DELETE: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const formId = params.formId;
  if (!formId) return apiError('Missing formId');
  const store = getStore();
  const existing = await store.getDoc(`${paths.forms(ctx.orgId, ctx.siteId)}/${formId}`);
  if (!existing) return apiError('Not found', 404);
  // Existing submissions stay — they're a record of customer interactions
  // that survive a form being retired. Pass ?delete_submissions=true to
  // also drop them.
  const url = new URL(request.url);
  if (url.searchParams.get('delete_submissions') === 'true') {
    const subs = await store.listDocs(paths.submissions(ctx.orgId, ctx.siteId));
    for (const s of subs) {
      const sub = s as { form_id?: string };
      if (sub.form_id === formId) {
        await store.deleteDoc(`${paths.submissions(ctx.orgId, ctx.siteId)}/${(s as { id: string }).id}`);
      }
    }
  }
  await store.deleteDoc(`${paths.forms(ctx.orgId, ctx.siteId)}/${formId}`);
  return apiResponse(ctx, { ok: true });
};
