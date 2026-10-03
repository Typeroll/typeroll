// Cookie-auth admin: read / update / delete one form for the portal Forms UI.
//
// Admins write a form's `actions` (email notifications, webhooks) here or
// through an admin API key / MCP (lib/form-actions-api.ts), with the same
// validation. The portal chat assistant has no tool for them.

import type { APIRoute } from 'astro';
import { requireSiteAccess, requirePermission, json } from '../../../../../../lib/access';
import { getStore } from '../../../../../../lib/datastore';
import { paths, fieldsToSteps, collectStepFields, safeFormRedirectUrl } from '@typeroll/shared';
import type { Form, FormField } from '@typeroll/shared';
import { applyFormNavigation, applyStepLabels, validateFields, validateEmailActions, validateFormNavigation, maskFormActionsForAdmin } from '../../../../../../lib/forms-admin';
import { deleteAllFormSubmissions } from '../../../../../../lib/form-submissions';

function formView(form: Form, isAdmin: boolean): Form {
  return { ...form, actions: isAdmin ? maskFormActionsForAdmin(form.actions) : [] };
}

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { site, owner_org_id } = guard.value;
  const formId = params.formId;
  if (!formId) return json({ error: 'Missing formId' }, 400);
  const form = await getStore().getDoc<Form>(`${paths.forms(owner_org_id, site.id)}/${formId}`);
  if (!form) return json({ error: 'Not found' }, 404);
  return json({ form: formView(form, guard.value.permission === 'admin') });
};

export const PUT: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { site, owner_org_id } = guard.value;
  const formId = params.formId;
  if (!formId) return json({ error: 'Missing formId' }, 400);

  const store = getStore();
  const existing = await store.getDoc<Form>(`${paths.forms(owner_org_id, site.id)}/${formId}`);
  if (!existing) return json({ error: 'Not found' }, 404);
  const body = (await request.json().catch(() => null)) as Partial<Form> | null;
  if (!body) return json({ error: 'Invalid JSON body' }, 400);

  const update: Partial<Form> = {};
  if (body.name !== undefined) update.name = String(body.name);
  if (body.submit_text !== undefined) update.submit_text = String(body.submit_text);
  if (body.success_message !== undefined) update.success_message = String(body.success_message);
  if (body.success_redirect_url !== undefined) {
    // Empty or null clears the redirect; anything else must be http(s) or root-relative.
    const redirect = body.success_redirect_url ? safeFormRedirectUrl(body.success_redirect_url) : '';
    if (body.success_redirect_url && !redirect) return json({ error: 'success_redirect_url must be an http(s) URL or a path starting with /' }, 400);
    update.success_redirect_url = redirect;
  }
  if (body.partial_ttl_days !== undefined) update.partial_ttl_days = Number(body.partial_ttl_days);
  // Flat `fields` is authoring sugar — it replaces the step list with one
  // static step (steps are the only stored model).
  const bodyFields = (body as { fields?: FormField[] }).fields;
  if (bodyFields !== undefined) {
    const fields = validateFields(bodyFields);
    if (typeof fields === 'string') return json({ error: fields }, 400);
    update.steps = fieldsToSteps(fields);
  }
  // Multi-step forms: per-step button labels for the existing steps, plus
  // the form's Back and progress options.
  const stepLabels = (body as { step_labels?: unknown }).step_labels;
  if (stepLabels !== undefined) {
    const steps = applyStepLabels(update.steps ?? existing.steps ?? [], stepLabels);
    if (typeof steps === 'string') return json({ error: steps }, 400);
    update.steps = steps;
  }
  const navigation = validateFormNavigation(body as Record<string, unknown>);
  if (typeof navigation === 'string') return json({ error: navigation }, 400);
  if (body.actions !== undefined) {
    const adminCheck = requirePermission(guard.value, 'admin');
    if (!adminCheck.ok) return adminCheck.response;
    // The registry decides which types exist, so an app-contributed action
    // saves like any other and a typo still gets refused.
    const { actionRegistry } = await import('../../../../../../lib/forms/actions');
    const webhookFields = (existing.steps ?? []).flatMap((step) => collectStepFields(step.blocks)).map((field) => field.name);
    const actions = validateEmailActions(body.actions, [...(await actionRegistry()).keys()], existing.actions, webhookFields);
    if (typeof actions === 'string') return json({ error: actions }, 400);
    update.actions = actions;
  }
  if (Object.keys(update).length === 0 && Object.keys(navigation).length === 0) return json({ error: 'No writable fields in body' }, 400);

  await store.setDoc(`${paths.forms(owner_org_id, site.id)}/${formId}`, applyFormNavigation({ ...existing, ...update }, navigation));
  const fresh = await store.getDoc<Form>(`${paths.forms(owner_org_id, site.id)}/${formId}`);
  return json({ form: formView(fresh!, guard.value.permission === 'admin') });
};

export const DELETE: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { site, owner_org_id } = guard.value;
  const formId = params.formId;
  if (!formId) return json({ error: 'Missing formId' }, 400);

  const store = getStore();
  if (!(await store.getDoc(`${paths.forms(owner_org_id, site.id)}/${formId}`))) {
    return json({ error: 'Not found' }, 404);
  }
  const url = new URL(request.url);
  if (url.searchParams.get('delete_submissions') === 'true') {
    await deleteAllFormSubmissions(owner_org_id, site.id, formId);
  }
  await store.deleteDoc(`${paths.forms(owner_org_id, site.id)}/${formId}`);
  return json({ ok: true });
};
