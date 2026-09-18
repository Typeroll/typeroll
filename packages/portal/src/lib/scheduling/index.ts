import { createHash } from 'node:crypto';

export const WORK_COLLECTION = 'scheduled_work';
export type WorkKind = 'page_schedule' | 'site_publish' | 'publication' | 'build_result' | 'build_continue';
export interface ScheduledWork {
  kind: WorkKind;
  source: string;
  generation: string;
  due_at: number;
  payload: Record<string, any>;
  lease_until?: number;
  lease_owner?: string | null;
  blocked_by?: string | null;
}
export const isScheduledSource = (p: string) => /^organizations\/[^/]+\/build_tasks\/[^/]+$/.test(p) || /^organizations\/[^/]+\/sites\/[^/]+(?:\/versions\/main\/pages\/[^/]+|\/deploys\/[^/]+)?$/.test(p);
export type IndexWrite = { path: string; data: ScheduledWork | null };
export const workPath = (source: string, kind: WorkKind) => `${WORK_COLLECTION}/${createHash('sha256').update(`${kind}:${source}`).digest('hex')}`;
const time = (value: unknown): number => typeof value === 'string' ? Date.parse(value) : typeof value === 'number' ? value : NaN;

/** A transactional secondary index, not a scanner over customer content. */
export function scheduledIndexWrites(source: string, before: any, after: any, now = Date.now()): IndexWrite[] {
  let kind: WorkKind, due = NaN, payload: Record<string, any> = {};
  if (/^organizations\/[^/]+\/build_tasks\/[^/]+$/.test(source)) {
    kind = after?.status === 'queued' && after?.attempt > 0 ? 'build_continue' : 'build_result';
    // Running builds have no estimated restart time. Only a terminal result
    // creates the next link in the publication chain.
    if (after && (['completed', 'failed', 'cancelled'].includes(after.status) || kind === 'build_continue')) due = after.completed_at ?? after.created_at;
    payload = { identity: after?.identity ?? null, status: after?.status ?? null, attempt: after?.attempt ?? 0, cursor: after?.media_cursor ?? 0 };
  } else if (/^organizations\/[^/]+\/sites\/[^/]+\/versions\/main\/pages\/[^/]+$/.test(source)) {
    kind = 'page_schedule';
    const dates = [after?.status !== 'published' ? time(after?.publish_at) : NaN, after?.status === 'published' ? time(after?.unpublish_at) : NaN].filter(Number.isFinite);
    if (dates.length) due = Math.min(...dates);
    payload = { publish_at: after?.publish_at ?? null, unpublish_at: after?.unpublish_at ?? null, status: after?.status ?? null };
  } else if (/^organizations\/[^/]+\/sites\/[^/]+$/.test(source)) {
    kind = 'site_publish';
    const pending = time(after?.pending_deploy_at);
    const scheduled = time(after?.scheduled_publish_pending_at);
    const dates = [after?.auto_deploy?.enabled ? pending + (after.auto_deploy.debounce_minutes ?? 15) * 60000 : NaN, scheduled].filter(Number.isFinite);
    if (dates.length) due = Math.min(...dates);
    payload = { pending_deploy_at: after?.pending_deploy_at ?? null, scheduled_publish_pending_at: after?.scheduled_publish_pending_at ?? null, pending_deploy_revision: after?.pending_deploy_revision ?? null, scheduled_publish_revision: after?.scheduled_publish_revision ?? null };
  } else if (/^organizations\/[^/]+\/sites\/[^/]+\/deploys\/[^/]+$/.test(source)) {
    kind = 'publication';
    if (after && after.phase !== 'awaiting domain cutover approval') {
      if (['queued', 'running'].includes(after.status)) {
        // Persisted checkpoints are immediate events. A build wait deliberately
        // has no due time: its authenticated terminal result continues the job.
        due = time(after.continuation?.due_at);
      } else if (['succeeded', 'failed'].includes(after.status)) {
        due = time(after.finished_at ?? after.started_at);
      }
      payload = { version_id: after.version_id, environment: after.environment, dry_run: after.dry_run === true,
        token: after.continuation?.token ?? 'initial', terminal: ['succeeded', 'failed'].includes(after.status) };
    }
  } else return [];
  const path = workPath(source, kind === 'build_continue' ? 'build_result' : kind);
  const data = Number.isFinite(due) ? {
    kind, source, due_at: due,
    generation: createHash('sha256').update(JSON.stringify({ kind, source, due, payload })).digest('hex'), payload,
    lease_until: 0, lease_owner: null,
  } satisfies ScheduledWork : null;
  if (before !== undefined) {
    const previous = scheduledIndexWrites(source, undefined, before, now)[0]?.data;
    if (previous?.generation === data?.generation) return [];
  }
  return [{ path, data }];
}

/** Delivery is an acceleration; the committed index survives a transport outage. */
export async function notifyScheduledWrites(writes: IndexWrite[]): Promise<void> {
  if (!writes.some(w => w.data)) return;
  if ((!process.env.DEPLOY_QUEUE || process.env.DEPLOY_QUEUE === 'in_process') && process.env.NODE_ENV !== 'test') {
    const { deliverLocally } = await import('./transport');
    for (const write of writes) if (write.data) deliverLocally(write.path, write.data);
    return;
  }
  if (process.env.DEPLOY_QUEUE !== 'cloud_tasks') return;
  try {
    const { dispatchScheduledWork } = await import('./transport');
    for (const write of writes) if (write.data) await dispatchScheduledWork(write.path, write.data);
  } catch { console.warn('[scheduled-work] delivery pending; durable event retained'); }
}
