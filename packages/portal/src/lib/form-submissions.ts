// Form submissions inbox shared by the portal's Forms UI, the v1 API and MCP:
// list (newest first, cursor-paginated), read one, delete one or all of a
// form's. Admins also see each submission's webhook delivery
// status, as in the portal. Deleting a submission removes its webhook
// delivery records with it.
//
// Privacy:
//   - Submissions no longer store the visitor's IP address or browser. Older
//     documents may still carry `submitted_from_ip` and `user_agent`; the
//     views below never return the IP, and only admins see the (truncated)
//     legacy user agent.
//   - Retention is opt-in per site (`Site.form_submission_retention_days`,
//     null = keep, the default). With it set, a completed submission expires
//     that many days after it was completed. Expiry is enforced three ways:
//       1. reads never return an expired submission, computed from the
//          current setting, so a new or shorter period applies at once to
//          existing submissions;
//       2. reads delete the expired submissions they meet (at most
//          LAZY_PURGE_LIMIT per call), and setting the period deletes the
//          already-expired ones and stamps the rest;
//       3. each completed submission carries `delete_at`, the store's TTL
//          field: the site's store object removes it on its alarm once that
//          time has passed, so nothing depends on someone opening the inbox.
//          Clearing the setting clears `delete_at` again.
//   - Partial submissions (a multi-step form the visitor has not finished,
//     or an app questionnaire nobody answered) are not affected by that
//     setting. Each carries its own `expires_at`: the form's
//     `partial_ttl_days` after its last step, or a day after its last
//     abandoned-partial follow-up is due if that is later (an unanswered
//     questionnaire: 30 days after it started). They are deleted the same
//     three ways: reads hide and delete expired ones, a resumed step past the
//     expiry starts over, and `delete_at` (set with `expires_at`, cleared on
//     completion) lets the store's TTL remove them. Partials saved before
//     `delete_at` existed get it when a read meets them.

import { paths } from '@typeroll/shared';
import type { Form, FormSubmission, FormWebhookDelivery, Site } from '@typeroll/shared';
import { getStore } from './datastore';

export const SUBMISSIONS_DEFAULT_LIMIT = 50;
export const SUBMISSIONS_MAX_LIMIT = 200;

export const SUBMISSION_RETENTION_MIN_DAYS = 30;
export const SUBMISSION_RETENTION_MAX_DAYS = 3650;
/** Expired submissions a single read deletes; the rest wait for the next read or the TTL policy. */
export const LAZY_PURGE_LIMIT = 100;
const USER_AGENT_MAX = 256;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export type SubmissionView = FormSubmission & { webhook_deliveries?: Partial<FormWebhookDelivery>[] };

/** A stored submission: the view plus fields that never leave the server. */
type StoredSubmission = FormSubmission & {
  submitted_from_ip?: unknown;
  user_agent?: unknown;
  delete_at?: unknown;
  intake?: unknown;
};

/** Validation message for a retention value, or null when it is valid (null clears). */
export function submissionRetentionError(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isInteger(value)
    && value >= SUBMISSION_RETENTION_MIN_DAYS && value <= SUBMISSION_RETENTION_MAX_DAYS) return null;
  return `form_submission_retention_days must be a whole number of days from ${SUBMISSION_RETENTION_MIN_DAYS} to ${SUBMISSION_RETENTION_MAX_DAYS}, or null to keep submissions until they are deleted`;
}

/** The site's retention period in days, or null (keep). Invalid stored values count as unset. */
export function siteSubmissionRetentionDays(site: Pick<Site, 'form_submission_retention_days'> | null | undefined): number | null {
  const days = site?.form_submission_retention_days;
  return days != null && submissionRetentionError(days) === null ? days : null;
}

async function loadRetentionDays(orgId: string, siteId: string): Promise<number | null> {
  return siteSubmissionRetentionDays(await getStore().getDoc<Site>(paths.site(orgId, siteId)));
}

/**
 * Expiry fields for a submission completed at `completedAt`. Without
 * retention: `expires_at: null` and no TTL timestamp, as before.
 */
export function completedRetentionFields(days: number | null, completedAt: Date): { expires_at: string | null; delete_at?: Date } {
  if (days === null) return { expires_at: null };
  const deadline = new Date(completedAt.getTime() + days * DAY_MS);
  return { expires_at: deadline.toISOString(), delete_at: deadline };
}

/** When a stored submission expires under `days`, in ms; null when it is kept. */
export function submissionRetentionDeadline(submission: StoredSubmission, days: number | null): number | null {
  if (days === null || submission.status === 'partial' || 'intake' in submission) return null;
  const completedAt = Date.parse(submission.updated_at ?? submission.created_at ?? '');
  return Number.isFinite(completedAt) ? completedAt + days * DAY_MS : null;
}

export const PARTIAL_TTL_DEFAULT_DAYS = 30;

/**
 * Days a form keeps a partial submission after its last step: the form's
 * `partial_ttl_days`, or 30 when it is unset or not a usable number of days.
 */
export function partialTtlDays(form: Pick<Form, 'partial_ttl_days'> | null | undefined): number {
  const days = form?.partial_ttl_days;
  return typeof days === 'number' && Number.isFinite(days) && days >= 1
    ? Math.min(days, SUBMISSION_RETENTION_MAX_DAYS) : PARTIAL_TTL_DEFAULT_DAYS;
}

/**
 * How long a form keeps a partial submission after its last step, in ms:
 * `partial_ttl_days`, extended to a day after the form's last
 * abandoned-partial follow-up is due, so a follow-up never finds its
 * submission already deleted.
 */
export function partialLifetimeMs(form: Partial<Pick<Form, 'partial_ttl_days' | 'actions'>> | null | undefined): number {
  const followUps = (form?.actions ?? [])
    .filter((action) => action.trigger === 'partial_abandoned' && typeof action.after_hours === 'number' && action.after_hours > 0)
    .map((action) => action.after_hours! * HOUR_MS + DAY_MS);
  return Math.min(Math.max(partialTtlDays(form) * DAY_MS, ...followUps), SUBMISSION_RETENTION_MAX_DAYS * DAY_MS);
}

/**
 * Expiry fields for a partial submission whose last step was saved at
 * `savedAt`: `expires_at` for callers and `delete_at`, the store's TTL field.
 */
export function partialExpiryFields(form: Partial<Pick<Form, 'partial_ttl_days' | 'actions'>> | null | undefined, savedAt: Date): { expires_at: string; delete_at: Date } {
  const deadline = new Date(savedAt.getTime() + partialLifetimeMs(form));
  return { expires_at: deadline.toISOString(), delete_at: deadline };
}

/** When a partial submission expires, in ms; null for completed ones or a partial without an expiry. */
export function partialDeadline(submission: object): number | null {
  const { status, expires_at: expiresAt } = submission as { status?: unknown; expires_at?: unknown };
  if (status !== 'partial' || typeof expiresAt !== 'string') return null;
  const deadline = Date.parse(expiresAt);
  return Number.isFinite(deadline) ? deadline : null;
}

/** Whether a partial submission is past its expiry and counts as deleted. */
export function isExpiredPartial(submission: object, now = Date.now()): boolean {
  const deadline = partialDeadline(submission);
  return deadline !== null && deadline <= now;
}

function isExpired(submission: StoredSubmission, days: number | null, now: number): boolean {
  if (isExpiredPartial(submission, now)) return true;
  const deadline = submissionRetentionDeadline(submission, days);
  return deadline !== null && deadline <= now;
}

/**
 * Give partials saved before they carried `delete_at` the store's TTL
 * timestamp (bounded per call), so they are removed without another read.
 * Only a still-unstamped partial with the same expiry is changed. Never fails the read.
 */
async function stampPartialTtl(orgId: string, siteId: string, submissions: StoredSubmission[]): Promise<void> {
  const pending = submissions.filter((submission) => submission.delete_at == null && partialDeadline(submission) !== null)
    .slice(0, LAZY_PURGE_LIMIT);
  if (pending.length === 0) return;
  try {
    const store = getStore();
    for (const submission of pending) {
      await store.compareAndUpdateDoc<StoredSubmission>(`${paths.submissions(orgId, siteId)}/${submission.id}`,
        (saved) => saved.status === 'partial' && saved.delete_at == null && saved.expires_at === submission.expires_at,
        { delete_at: new Date(partialDeadline(submission)!) });
    }
  } catch (error) {
    console.error('[forms] stamping partial submission expiry failed:', error);
  }
}

/**
 * What a caller sees of a stored submission. The legacy IP address and the
 * TTL timestamp are never returned; the legacy user agent only to admins.
 */
export function submissionView(submission: StoredSubmission, isAdmin: boolean): FormSubmission {
  const { required_completion: _completion, submitted_from_ip: _ip, user_agent: userAgent, delete_at: _deleteAt, ...view } = submission as StoredSubmission & {required_completion?:unknown};
  if(_completion && typeof _completion==='object' && 'state' in _completion && ['pending','running','failed','notifying','done'].includes(String(_completion.state)))view.action_status=String(_completion.state) as FormSubmission['action_status'];
  if (isAdmin && typeof userAgent === 'string' && userAgent) {
    return { ...view, user_agent: userAgent.slice(0, USER_AGENT_MAX) };
  }
  return view;
}

/** Delete expired submissions (bounded) with their delivery records. Never fails the read. */
async function purgeExpired(orgId: string, siteId: string, expired: StoredSubmission[]): Promise<void> {
  if (expired.length === 0) return;
  const batch = expired.slice(0, LAZY_PURGE_LIMIT);
  try {
    const store = getStore();
    await deleteDeliveries(orgId, siteId, new Set(batch.map((submission) => submission.id)));
    for (const submission of batch) await store.deleteDoc(`${paths.submissions(orgId, siteId)}/${submission.id}`);
  } catch (error) {
    console.error('[forms] deleting expired submissions failed:', error);
  }
}

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
  const [all, days] = await Promise.all([
    getStore().listDocs<StoredSubmission>(paths.submissions(orgId, siteId)),
    loadRetentionDays(orgId, siteId),
  ]);
  const now = Date.now();
  const expired = all.filter((submission) => isExpired(submission, days, now));
  await purgeExpired(orgId, siteId, expired);
  const expiredIds = new Set(expired.map((submission) => submission.id));
  await stampPartialTtl(orgId, siteId, all.filter((submission) => !expiredIds.has(submission.id)));
  let submissions = all
    .filter((submission) => submission.form_id === formId && !expiredIds.has(submission.id)
      && (options.isAdmin || !('intake' in submission)))
    .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? '') || a.id.localeCompare(b.id));
  if (after) {
    const index = submissions.findIndex((submission) => submission.id === after);
    if (index >= 0) submissions = submissions.slice(index + 1);
  }
  const slice = submissions.slice(0, limit).map((submission) => submissionView(submission, options.isAdmin));
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
  const [stored, days] = await Promise.all([
    getStore().getDoc<StoredSubmission>(`${paths.submissions(orgId, siteId)}/${submissionId}`),
    loadRetentionDays(orgId, siteId),
  ]);
  if (!stored || stored.form_id !== formId || !isAdmin && 'intake' in stored) return null;
  if (isExpired(stored, days, Date.now())) {
    await purgeExpired(orgId, siteId, [stored]);
    return null;
  }
  await stampPartialTtl(orgId, siteId, [stored]);
  const submission = submissionView(stored, isAdmin);
  return isAdmin ? (await withDeliveries(orgId, siteId, [submission]))[0]! : submission;
}

export interface SubmissionRetentionResult {
  form_submission_retention_days: number | null;
  /** Completed submissions whose expiry was set, moved or cleared. */
  updated: number;
  /** Completed submissions that were already past the new period and were deleted. */
  deleted: number;
}

/**
 * Set (days) or clear (null) the site's retention and apply it to the
 * existing completed submissions: delete the ones already past it, stamp or
 * clear `expires_at`/`delete_at` on the rest. Idempotent — sending the same
 * value again finishes an interrupted run. The caller validates `days` and
 * the caller's permission (site admin).
 */
export async function setSubmissionRetention(orgId: string, siteId: string, days: number | null): Promise<SubmissionRetentionResult> {
  const store = getStore();
  await store.updateDoc(paths.site(orgId, siteId), { form_submission_retention_days: days });
  const now = Date.now();
  const expired: string[] = [];
  const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
  for (const submission of await store.listDocs<StoredSubmission>(paths.submissions(orgId, siteId))) {
    if (submission.status === 'partial' || 'intake' in submission) continue;
    const deadline = submissionRetentionDeadline(submission, days);
    if (deadline !== null && deadline <= now) { expired.push(submission.id); continue; }
    const expiresAt = deadline === null ? null : new Date(deadline).toISOString();
    const hasTtl = submission.delete_at != null;
    if ((submission.expires_at ?? null) === expiresAt && hasTtl === (deadline !== null)) continue;
    updates.push({ id: submission.id, data: { expires_at: expiresAt, delete_at: deadline === null ? null : new Date(deadline) } });
  }
  const CHUNK = 20;
  for (let i = 0; i < updates.length; i += CHUNK) {
    await Promise.all(updates.slice(i, i + CHUNK).map(({ id, data }) => store.updateDoc(`${paths.submissions(orgId, siteId)}/${id}`, data)));
  }
  if (expired.length) {
    await deleteDeliveries(orgId, siteId, new Set(expired));
    for (let i = 0; i < expired.length; i += CHUNK) {
      await Promise.all(expired.slice(i, i + CHUNK).map((id) => store.deleteDoc(`${paths.submissions(orgId, siteId)}/${id}`)));
    }
  }
  return { form_submission_retention_days: days, updated: updates.length, deleted: expired.length };
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
