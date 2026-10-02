// Follow-up on abandoned partial submissions.
//
// An email action with `trigger: 'partial_abandoned'` runs once for a partial
// submission that has not advanced for `after_hours` hours, so a site owner
// hears about a visitor who gave contact details in step 1 but never
// finished. Completion actions are unchanged and never run here.
//
// Scheduling uses the existing scheduled-work index (lib/scheduling): the
// submit endpoint writes one entry per partial submission, due when its
// earliest pending action is. Cloud Tasks, the in-process timer or the
// periodic sweep (/api/internal/publish-sweep, Cloud Scheduler every five
// minutes) delivers it to executeScheduledWork, which calls
// runAbandonedPartial below. That function decides everything from the
// stored submission, so late, repeated or concurrent deliveries are harmless:
//   - only `status: 'partial'` submissions qualify, never completed ones;
//   - an action runs only when `after_hours` have passed since the last
//     progress (`updated_at`), and a newer step postpones it;
//   - each action is claimed on the submission (`abandoned_actions_fired`)
//     with a compare-and-update before it runs, so it runs at most once.
// Preview forms never store submissions, so they never count.

import { createHash } from 'node:crypto';
import { paths } from '@typeroll/shared';
import type { Form, FormAction } from '@typeroll/shared';
import { getStore } from '../datastore';
import { notifyScheduledWrites, workPath, type ScheduledWork } from '../scheduling/index';

const HOUR_MS = 3_600_000;

export interface PartialSubmissionDoc {
  form_id: string;
  status?: 'partial' | 'complete';
  data?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
  /** Ids of the abandoned-partial actions that already ran for this submission. */
  abandoned_actions_fired?: string[];
}

type AbandonedAction = FormAction & { id: string; after_hours: number };

/** The form's abandoned-partial actions that can run (valid id and delay). */
export function abandonedActions(form: Pick<Form, 'actions'>): AbandonedAction[] {
  return (form.actions ?? []).filter((action): action is AbandonedAction =>
    action.trigger === 'partial_abandoned' && typeof action.id === 'string' && action.id.length > 0
    && typeof action.after_hours === 'number' && action.after_hours > 0);
}

function lastProgress(submission: PartialSubmissionDoc): number {
  return Date.parse(submission.updated_at ?? submission.created_at ?? '');
}

/** When the next pending action of this partial submission is due, or null. */
export function nextAbandonedCheck(form: Pick<Form, 'actions'>, submission: PartialSubmissionDoc): number | null {
  if (submission.status !== 'partial') return null;
  const since = lastProgress(submission);
  if (!Number.isFinite(since)) return null;
  const fired = new Set(submission.abandoned_actions_fired ?? []);
  const due = abandonedActions(form).filter((action) => !fired.has(action.id)).map((action) => since + action.after_hours * HOUR_MS);
  return due.length ? Math.min(...due) : null;
}

/**
 * Index the next check for a partial submission. Called after every step
 * that leaves the submission partial; a newer step moves the due time.
 */
export async function scheduleAbandonedCheck(orgId: string, siteId: string, submissionId: string, form: Pick<Form, 'actions'>, submission: PartialSubmissionDoc): Promise<void> {
  const due = nextAbandonedCheck(form, submission);
  if (due === null) return;
  const source = `${paths.submissions(orgId, siteId)}/${submissionId}`;
  const payload = { updated_at: submission.updated_at ?? null };
  const work: ScheduledWork = {
    kind: 'form_partial_abandoned', source, due_at: due, payload,
    generation: createHash('sha256').update(JSON.stringify({ kind: 'form_partial_abandoned', source, due, payload })).digest('hex'),
    lease_until: 0, lease_owner: null,
  };
  const path = workPath(source, 'form_partial_abandoned');
  await getStore().setDoc(path, work as unknown as Record<string, unknown>);
  await notifyScheduledWrites([{ path, data: work }]);
}

/**
 * Run the due abandoned-partial actions of one submission. Idempotent.
 * Returns when the next pending action is due, or null when none remains.
 */
export async function runAbandonedPartial(source: string, now = Date.now()): Promise<number | null> {
  const match = /^organizations\/([^/]+)\/sites\/([^/]+)\/submissions\/([^/]+)$/.exec(source);
  if (!match) return null;
  const [, orgId, siteId, submissionId] = match;
  const store = getStore();
  const submission = await store.getDoc<PartialSubmissionDoc>(source);
  if (!submission || submission.status !== 'partial') return null;
  const form = await store.getDoc<Form>(`${paths.forms(orgId, siteId)}/${submission.form_id}`);
  if (!form) return null;
  const since = lastProgress(submission);
  if (!Number.isFinite(since)) return null;

  let fired = [...(submission.abandoned_actions_fired ?? [])];
  const due = abandonedActions(form).filter((action) => !fired.includes(action.id) && since + action.after_hours * HOUR_MS <= now);
  if (due.length) {
    const { actionRegistry } = await import('./actions');
    const registry = await actionRegistry();
    for (const action of due) {
      // Claim before running: the submission must still be the same partial
      // (no newer step, not completed) and the action not yet claimed.
      const claimed = await store.compareAndUpdateDoc<PartialSubmissionDoc>(source,
        (saved) => saved.status === 'partial' && saved.updated_at === submission.updated_at
          && JSON.stringify(saved.abandoned_actions_fired ?? []) === JSON.stringify(fired),
        { abandoned_actions_fired: [...fired, action.id] });
      if (!claimed) return null;
      fired = [...fired, action.id];
      const def = registry.get(action.type);
      if (!def) continue;
      try {
        await def.run(action, {
          orgId, siteId, formId: submission.form_id, data: submission.data ?? {},
          subject: { kind: 'submission', id: submissionId }, form: { steps: form.steps },
        });
      } catch (error) {
        // At most once: a failed send is logged, not retried.
        console.error(`[form action] abandoned "${action.type}" failed:`, error);
      }
    }
  }
  return nextAbandonedCheck(form, { ...submission, abandoned_actions_fired: fired });
}

