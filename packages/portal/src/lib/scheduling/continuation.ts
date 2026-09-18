import { randomUUID } from 'node:crypto';
import { getStore } from '../datastore';
import { buildTasksPath, type BuildTask } from '../builds/queue';

export interface Continuation { token: string; reason: string; due_at: number | null; attempt: number }

export async function schedulePublication(path: string, reason: string, delayMs = 0): Promise<'waiting'> {
  const store = getStore(), job = await store.getDoc<any>(path);
  if (!job || !['queued', 'running'].includes(job.status)) return 'waiting';
  const attempt = job.continuation?.reason === reason ? job.continuation.attempt + 1 : 0;
  const saved = await store.compareAndReplaceDoc(path, job, { ...job, continuation: { token: randomUUID(), reason, due_at: Date.now() + delayMs, attempt } satisfies Continuation });
  if (!saved) throw Object.assign(new Error('Concurrent publication update; retry this delivery'), { code: 10 });
  return 'waiting';
}

/** Completion is the only automatic trigger for a running build. */
export async function waitForBuild(path: string, org: string, key: string): Promise<'waiting'> {
  const store = getStore();
  // Read the job before the task. CAS prevents a callback arriving between
  // these reads and the save from being overwritten by a waiting state.
  for (let attempt = 0; attempt < 5; attempt++) {
    const job = await store.getDoc<any>(path);
    if (!job || !['queued', 'running'].includes(job.status)) return 'waiting';
    const task = await store.getDoc<BuildTask>(`${buildTasksPath(org)}/${key}`);
    const complete = task && ['completed', 'failed', 'cancelled'].includes(task.status);
    if (await store.compareAndReplaceDoc(path, job, { ...job, continuation: {
      token: randomUUID(), reason: complete ? 'build_result' : `build:${key}`,
      due_at: complete ? Date.now() : null, attempt: 0,
    } satisfies Continuation })) return 'waiting';
  }
  throw Object.assign(new Error('Concurrent publication update; retry this delivery'), { code: 10 });
}

/** Only visibility/transport conditions without completion events use bounded backoff. */
export async function waitForPublicationCondition(path: string, reason: string): Promise<'waiting'> {
  const job = await getStore().getDoc<any>(path);
  const attempt = job?.continuation?.reason === reason ? job.continuation.attempt + 1 : 0;
  return schedulePublication(path, reason, [1000, 2000, 4000, 8000, 15000, 30000][Math.min(attempt, 5)]);
}
