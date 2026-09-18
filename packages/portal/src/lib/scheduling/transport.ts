import { createHash } from 'node:crypto';
import type { ScheduledWork } from './index';

/** Cloud Tasks delivers persisted events and explicit schedules. */
export async function dispatchScheduledWork(path: string, work: ScheduledWork): Promise<void> {
  const queue = process.env.CLOUD_TASKS_QUEUE, url = process.env.DEPLOY_WORKER_URL, email = process.env.CLOUD_TASKS_SERVICE_ACCOUNT;
  if (!queue || !url || !email) throw new Error('Scheduled work requires the configured task transport');
  const scheduled = Math.ceil(Math.min(work.due_at, Date.now() + 28 * 86400000) / 1000);
  const identity = createHash('sha256').update(`${path}:${work.generation}:${scheduled}`).digest('hex');
  const { CloudTasksClient } = await import('@google-cloud/tasks');
  const client = new CloudTasksClient();
  try {
    await client.createTask({ parent: queue, task: {
      name: `${queue}/tasks/scheduled-${identity}`,
      scheduleTime: { seconds: scheduled },
      httpRequest: { httpMethod: 'POST', url, headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify({ kind: 'scheduled_work', workId: path.split('/').pop(), generation: work.generation })).toString('base64'),
        oidcToken: { serviceAccountEmail: email, audience: url } },
    } });
  } catch (error) { if ((error as { code?: number }).code !== 6) throw error; }
  finally { await client.close(); }
}

// Development only. Production uses a durable transport; the portable worker
// reads the same pending index. A retry always retains the event identity.
const localTimers = new Map<string, ReturnType<typeof setTimeout>>();
export function deliverLocally(path: string, work: ScheduledWork): void {
  if (work.due_at === Number.MAX_SAFE_INTEGER) return;
  const identity = `${path}:${work.generation}`;
  if (localTimers.has(identity)) return;
  const timer = setTimeout(async () => {
    localTimers.delete(identity);
    try {
      const { executeScheduledWork } = await import('./worker');
      await executeScheduledWork(path.split('/').pop()!, work.generation);
    } catch {
      deliverLocally(path, { ...work, due_at: Date.now() + 1000 });
    }
  }, Math.min(2147483647, Math.max(0, work.due_at - Date.now())));
  timer.unref();
  localTimers.set(identity, timer);
}
