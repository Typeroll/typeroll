// Cookie-auth admin: read / delete a single form submission.

import type { APIRoute } from 'astro';
import { requireSiteAccess, requirePermission, json } from '../../../../../../../lib/access';
import { getStore } from '../../../../../../../lib/datastore';
import { paths } from '@typeroll/shared';
import type { FormSubmission } from '@typeroll/shared';

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { site, owner_org_id } = guard.value;
  const { formId, submissionId } = params;
  if (!formId || !submissionId) return json({ error: 'Missing id' }, 400);
  const sub = await getStore().getDoc<FormSubmission>(
    `${paths.submissions(owner_org_id, site.id)}/${submissionId}`,
  );
  if (!sub || sub.form_id !== formId) return json({ error: 'Not found' }, 404);
  return json({ submission: sub });
};

export const DELETE: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { site, owner_org_id } = guard.value;
  const { formId, submissionId } = params;
  if (!formId || !submissionId) return json({ error: 'Missing id' }, 400);
  const store = getStore();
  const sub = await store.getDoc<FormSubmission>(
    `${paths.submissions(owner_org_id, site.id)}/${submissionId}`,
  );
  if (!sub || sub.form_id !== formId) return json({ error: 'Not found' }, 404);
  const deliveries = await store.listDocs<{ id: string; submission_id?: string }>(
    paths.formWebhookDeliveries(owner_org_id, site.id),
  );
  for (const delivery of deliveries) {
    if (delivery.submission_id === submissionId) {
      await store.deleteDoc(`${paths.formWebhookDeliveries(owner_org_id, site.id)}/${delivery.id}`);
    }
  }
  await store.deleteDoc(`${paths.submissions(owner_org_id, site.id)}/${submissionId}`);
  return json({ ok: true });
};
