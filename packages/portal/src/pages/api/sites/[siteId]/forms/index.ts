// Cookie-auth admin: list + create forms for the portal Forms UI.
// (The API-key v1 routes serve external clients; these serve the logged-in UI.)

import type { APIRoute } from 'astro';
import { requireSiteAccess, requirePermission, json } from '../../../../../lib/access';
import { getStore } from '../../../../../lib/datastore';
import { paths, collectStepFields, fieldsToSteps } from '@typeroll/shared';
import type { Form } from '@typeroll/shared';
import { FORM_ID_RE, validateFields } from '../../../../../lib/forms-admin';

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { site, owner_org_id } = guard.value;
  const store = getStore();
  const forms = await store.listDocs<Form>(paths.forms(owner_org_id, site.id));
  const subs = await store.listDocs<{ form_id?: string }>(paths.submissions(owner_org_id, site.id));
  const counts = new Map<string, number>();
  for (const s of subs) if (s.form_id) counts.set(s.form_id, (counts.get(s.form_id) ?? 0) + 1);
  return json({
    forms: forms.map((f) => ({
      id: f.id,
      name: f.name,
      kind: f.kind ?? 'form',
      field_count: (f.steps ?? []).reduce((n, s) => n + collectStepFields(s.blocks).length, 0),
      step_count: (f.steps ?? []).length,
      has_steps: Array.isArray(f.steps) && f.steps.length > 0,
      action_count: (f.actions ?? []).length,
      submission_count: counts.get(f.id) ?? 0,
      created_at: f.created_at,
    })),
  });
};

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { site, owner_org_id } = guard.value;

  const body = (await request.json().catch(() => null)) as Partial<Form> | null;
  if (!body) return json({ error: 'Invalid JSON body' }, 400);
  const id = String(body.id ?? '').trim();
  if (!id || !FORM_ID_RE.test(id)) {
    return json({ error: 'id must be lowercase, start with a letter, [a-z0-9_-] (max 63)' }, 400);
  }
  if (!body.name || typeof body.name !== 'string') return json({ error: 'name required' }, 400);
  // Steps-only storage: the UI's flat field list converts to one static step.
  const fields = validateFields((body as { fields?: unknown }).fields);
  if (typeof fields === 'string') return json({ error: fields }, 400);

  const store = getStore();
  if (await store.getDoc(`${paths.forms(owner_org_id, site.id)}/${id}`)) {
    return json({ error: `Form "${id}" already exists` }, 409);
  }
  const doc: Omit<Form, 'id'> = {
    name: body.name,
    steps: fieldsToSteps(fields),
    actions: [],
    submit_text: body.submit_text ?? 'Submit',
    success_message: body.success_message ?? 'Thanks — your message has been received.',
    created_at: new Date().toISOString(),
  };
  await store.setDoc(`${paths.forms(owner_org_id, site.id)}/${id}`, doc);
  return json({ form: await store.getDoc<Form>(`${paths.forms(owner_org_id, site.id)}/${id}`) }, 201);
};
