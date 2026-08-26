// GET  /api/v1/sites/{siteId}/forms      list forms (full shape)
// POST /api/v1/sites/{siteId}/forms      create a new form

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { getStore } from '../../../../../../lib/datastore';
import { formEmbedInfo } from '../../../../../../lib/forms-signing';
import { paths, collectStepFields, fieldsToSteps } from '@typeroll/shared';
import type { Form, FormStep } from '@typeroll/shared';
import { FORM_ID_RE as ID_RE, validateFields, validSteps } from '../../../../../../lib/forms-admin';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const forms = await getStore().listDocs<Form>(paths.forms(ctx.orgId, ctx.siteId));
  return apiResponse(ctx, {
    forms: forms.map((form) => ({
      id: form.id,
      name: form.name,
      steps: form.steps ?? [],
      // Derived wire-field summary (from the step blocks) — handy for
      // agents that just want the field names without walking blocks.
      fields: (form.steps ?? []).flatMap((s) => collectStepFields(s.blocks)),
      submit_text: form.submit_text,
      success_message: form.success_message,
      created_at: form.created_at,
    })),
  });
};

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const body = (await request.json().catch(() => null)) as Partial<Form> | null;
  if (!body) return apiError('Invalid JSON body');

  const id = String(body.id ?? '').trim();
  if (!id || !ID_RE.test(id)) {
    return apiError('id must be lowercase, start with a letter, [a-z0-9_-] (max 63)');
  }
  if (!body.name || typeof body.name !== 'string') return apiError('name required');

  if (body.steps !== undefined && !validSteps(body.steps)) {
    return apiError('steps must be a non-empty array of { id, blocks?, render?: static|dynamic, next? } with unique ids');
  }
  // Steps are the only stored model. A flat `fields` list is authoring
  // sugar for simple forms: validate it, then convert to a single static
  // step. When both are provided, explicit steps win.
  let steps: FormStep[];
  if (body.steps !== undefined && validSteps(body.steps)) {
    steps = body.steps;
  } else {
    const v = validateFields((body as { fields?: unknown }).fields);
    if (typeof v === 'string') return apiError(`Provide steps, or fields (${v})`);
    steps = fieldsToSteps(v);
  }

  const store = getStore();
  const existing = await store.getDoc(`${paths.forms(ctx.orgId, ctx.siteId)}/${id}`);
  if (existing) return apiError(`Form "${id}" already exists`, 409);
  const doc: Omit<Form, 'id'> = {
    name: body.name,
    // `actions` (email notifications) are admin-only — never set through the
    // API-key / MCP write path. Managed via the cookie-auth admin route.
    actions: [],
    submit_text: body.submit_text ?? 'Submit',
    success_message: body.success_message ?? 'Thanks — your message has been received.',
    steps,
    ...(typeof body.styles === 'string' ? { styles: body.styles } : {}),
    ...(typeof body.kind === 'string' ? { kind: body.kind } : {}),
    ...(typeof body.partial_ttl_days === 'number' ? { partial_ttl_days: body.partial_ttl_days } : {}),
    created_at: new Date().toISOString(),
  };
  await store.setDoc(`${paths.forms(ctx.orgId, ctx.siteId)}/${id}`, doc);
  const fresh = await store.getDoc<Form>(`${paths.forms(ctx.orgId, ctx.siteId)}/${id}`);
  // Embed info up front so create→embed is one round-trip; see [formId].ts GET.
  return apiResponse(ctx, { form: fresh ? { ...fresh, actions: [] } : fresh, ...formEmbedInfo(ctx.orgId, ctx.siteId, id) }, 201, body);
};
