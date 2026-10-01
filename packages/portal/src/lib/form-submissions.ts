// Form submissions inbox shared by the portal's Forms UI, the v1 API and MCP:
// list (newest first, cursor-paginated), read one, delete one or all of a
// form's. Admins also see each submission's webhook delivery
// status, as in the portal. Deleting a submission removes its webhook
// delivery records with it.

import { paths } from '@typeroll/shared';
import type { FormSubmission, FormWebhookDelivery } from '@typeroll/shared';
import { getStore } from './datastore';

export const SUBMISSIONS_DEFAULT_LIMIT = 50;
export const SUBMISSIONS_MAX_LIMIT = 200;

export type SubmissionView = FormSubmission & { webhook_deliveries?: Partial<FormWebhookDelivery>[] };

function encodeCursor(afterId: string): string {
  return Buffer.from(JSON.stringify({ after_id: afterId }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | null | undefined): string | null {
  if (!cursor) return null;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return typeof decoded?.after_id === 'string' ? decoded.after_id : null;
  } catch {
    return null;
  }
}

/** Clamp a requested page size to 1..200, defaulting to 50. */
export function submissionsLimit(raw: unknown): number {
  const limit = Number(raw ?? SUBMISSIONS_DEFAULT_LIMIT);
  return Math.max(1, Math.min(SUBMISSIONS_MAX_LIMIT, Number.isFinite(limit) ? Math.floor(limit) : SUBMISSIONS_DEFAULT_LIMIT));
}

async function withDeliveries(orgId: string, siteId: string, submissions: FormSubmission[]): Promise<SubmissionView[]> {
  const deliveries = await getStore().listDocs<FormWebhookDelivery>(paths.formWebhookDeliveries(orgId, siteId));
  return submissions.map((submission) => ({
    ...submission,
    webhook_deliveries: deliveries
      .filter((delivery) => delivery.submission_id === submission.id)
      .map((delivery) => ({
        webhook_id: delivery.webhook_id,
        status: delivery.status,
        attempts: delivery.attempts,
        response_status: delivery.response_status,
        last_error: delivery.last_error,
        updated_at: delivery.updated_at,
      })),
  }));
}

export async function formExists(orgId: string, siteId: string, formId: string): Promise<boolean> {
  return Boolean(await getStore().getDoc(`${paths.forms(orgId, siteId)}/${formId}`));
}

/** One page of a form's submissions. The caller checks the form exists. */
export async function listFormSubmissions(
  orgId: string,
  siteId: string,
  formId: string,
  options: { limit?: unknown; cursor?: string | null; isAdmin: boolean },
): Promise<{ submissions: SubmissionView[]; next_cursor: string | null; form_id: string }> {
  const limit = submissionsLimit(options.limit);
  const after = decodeCursor(options.cursor);
  let submissions = (await getStore().listDocs<FormSubmission>(paths.submissions(orgId, siteId)))
    .filter((submission) => submission.form_id === formId)
    .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? '') || a.id.localeCompare(b.id));
  if (after) {
    const index = submissions.findIndex((submission) => submission.id === after);
    if (index >= 0) submissions = submissions.slice(index + 1);
  }
  const slice = submissions.slice(0, limit);
  const next_cursor = submissions.length > limit ? encodeCursor(slice[slice.length - 1]!.id) : null;
  return {
    submissions: options.isAdmin ? await withDeliveries(orgId, siteId, slice) : slice,
    next_cursor,
    form_id: formId,
  };
}

/** One submission of this form, or null (a submission of another form is not found). */
export async function readFormSubmission(
  orgId: string,
  siteId: string,
  formId: string,
  submissionId: string,
  isAdmin: boolean,
): Promise<SubmissionView | null> {
  const submission = await getStore().getDoc<FormSubmission>(`${paths.submissions(orgId, siteId)}/${submissionId}`);
  if (!submission || submission.form_id !== formId) return null;
  return isAdmin ? (await withDeliveries(orgId, siteId, [submission]))[0]! : submission;
}

async function deleteDeliveries(orgId: string, siteId: string, submissionIds: Set<string>): Promise<void> {
  if (submissionIds.size === 0) return;
  const store = getStore();
  const deliveries = await store.listDocs<{ id: string; submission_id?: string }>(paths.formWebhookDeliveries(orgId, siteId));
  for (const delivery of deliveries) {
    if (delivery.submission_id && submissionIds.has(delivery.submission_id)) {
      await store.deleteDoc(`${paths.formWebhookDeliveries(orgId, siteId)}/${delivery.id}`);
    }
  }
}

/** Delete one submission of this form with its webhook delivery records. False when not found. */
export async function deleteFormSubmission(orgId: string, siteId: string, formId: string, submissionId: string): Promise<boolean> {
  const store = getStore();
  const path = `${paths.submissions(orgId, siteId)}/${submissionId}`;
  const submission = await store.getDoc<FormSubmission>(path);
  // Submissions live in one per-site collection keyed by form_id, so an id
  // under the wrong form must not delete another form's entry.
  if (!submission || submission.form_id !== formId) return false;
  await deleteDeliveries(orgId, siteId, new Set([submissionId]));
  await store.deleteDoc(path);
  return true;
}

/** Delete every submission of a form with their webhook delivery records. Returns the count. */
export async function deleteAllFormSubmissions(orgId: string, siteId: string, formId: string): Promise<number> {
  const store = getStore();
  const submissions = await store.listDocs<{ id: string; form_id?: string }>(paths.submissions(orgId, siteId));
  const deleted = new Set<string>();
  for (const submission of submissions) {
    if (submission.form_id === formId) {
      deleted.add(submission.id);
      await store.deleteDoc(`${paths.submissions(orgId, siteId)}/${submission.id}`);
    }
  }
  await deleteDeliveries(orgId, siteId, deleted);
  return deleted.size;
}
