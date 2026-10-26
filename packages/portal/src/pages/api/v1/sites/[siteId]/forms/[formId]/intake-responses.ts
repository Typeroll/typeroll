import type { APIRoute } from 'astro';
import { paths, type Form } from '@typeroll/shared';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../lib/api-auth';
import { getStore } from '../../../../../../../lib/datastore';
import { type IntakeRecord, IntakeError } from '../../../../../../../lib/forms/extension-intake';
import { dispatchIntakeNotifications, intakeNoticeStatus } from '../../../../../../../lib/forms/intake-notifications';

/** Private profile-linked answers. Installation credentials can see only their own form. */
const handle: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value, store = getStore();
  if (ctx.extensionIdentity && !ctx.extensionIdentity.scopes.includes('forms:intake:read')) return apiError('Private questionnaire read permission required', 403);
  if (!ctx.extensionIdentity && ctx.permission !== 'admin') return apiError('Administrator access required', 403);
  const form = await store.getDoc<Form>(`${paths.forms(ctx.orgId, ctx.siteId)}/${params.formId}`);
  const installation = form?.target?.installation_id;
  if (!form || !installation || ctx.extensionIdentity && ctx.extensionIdentity.installationId !== installation) return apiError('Form not found', 404);
  const url = new URL(request.url), pageId = url.searchParams.get('page_id');
  if (!pageId || pageId.length > 200 || /[\x00-\x1f/\\]/.test(pageId)) return apiError('Supply a valid page_id');
  const visible = (record: IntakeRecord) => record.form_id === form.id && record.installation_id === installation && record.intake?.reference.page_id === pageId;
  try {
    if (request.method === 'POST') {
      const text = await request.text();
      if (new TextEncoder().encode(text).length > 4096) return apiError('Retry request is too large', 413);
      let body: any; try { body = JSON.parse(text); } catch { return apiError('Invalid JSON'); }
      if (!body || !/^[a-f0-9]{64}$/.test(body.submission_id) || !['first_answer', 'complete'].includes(body.event)) return apiError('Supply submission_id and notification event');
      const record = await store.getDoc<IntakeRecord>(`${paths.submissions(ctx.orgId, ctx.siteId)}/${body.submission_id}`);
      if (!record || !visible(record)) return apiError('Submission not found', 404);
      const notice = record.notifications?.[body.event];
      if (!notice || !['pending', 'failed'].includes(notice.status) || notice.attempts >= 3) return apiError('This notification cannot be retried safely. Refresh its status.', 409);
      await dispatchIntakeNotifications(store, { orgId: ctx.orgId, siteId: ctx.siteId, installationId: installation }, body.submission_id, { retry: true, event: body.event });
    }
    const limit = 50, after = url.searchParams.get('after_id') ?? '';
    if (after && !/^[a-f0-9]{64}$/.test(after)) return apiError('Invalid after_id');
    const records = (await store.listDocs<IntakeRecord>(paths.submissions(ctx.orgId, ctx.siteId), {
      filters: [{ field: 'form_id', op: '==', value: form.id }, { field: 'installation_id', op: '==', value: installation }, { field: 'intake.reference.page_id', op: '==', value: pageId }],
      limit: limit + 1, startAfterId: after,
    })).filter(record => visible(record) && record.id > after).sort((a, b) => a.id.localeCompare(b.id));
    const rows = records.slice(0, limit);
    const response = apiResponse(ctx, { responses: rows.map(record => ({ id: record.id, status: record.status, answers: record.data,
      reference: record.intake.reference, revision: record.answer_revision ?? record.intake.revision, saved_at: record.updated_at,
      labels: Object.fromEntries(record.intake.steps.flatMap(step => step.fields.map(field => [field.name, field.label || field.name]))),
      notifications: intakeNoticeStatus(record),
    })), next_after_id: records.length > limit ? rows.at(-1)!.id : null });
    response.headers.set('Cache-Control', 'private, no-store'); return response;
  } catch (error) { if (error instanceof IntakeError) return apiError(error.message, error.status); throw error; }
};
export const GET = handle;
export const POST = handle;
