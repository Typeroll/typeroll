import { randomUUID } from 'node:crypto';
import { executeMediaMigration } from './media-migration';

const localJobs = new Set<string>();

/** Reuse the configured worker transport and identity; no customer deployment is enqueued. */
/** Without a Site, runs Organization media work and pending preparation; with one, that Site's migration only. */
export async function enqueueMediaMigration(orgId: string, delayMs = 0, siteId?: string): Promise<void> {
  const mode = (process.env.DEPLOY_QUEUE ?? 'in_process').toLowerCase();
  if (mode === 'firestore') return; // The persisted migration itself is the portable worker's queue item.
  if (mode === 'in_process') {
    const job = siteId ? `${orgId}\0${siteId}` : orgId;
    if (localJobs.has(job)) return;
    localJobs.add(job);
    const attempt = async () => {
      try {
        const delay = await executeMediaMigration(orgId, siteId);
        if (delay !== null) {
          const timer = setTimeout(() => { void attempt(); }, delay);
          timer.unref();
        } else localJobs.delete(job);
      } catch {
        localJobs.delete(job);
        console.error('[media-migration] local worker interrupted; persisted work will be recovered');
      }
    };
    const timer = setTimeout(() => { void attempt(); }, delayMs);
    timer.unref();
    return;
  }
  if (mode !== 'cloud_tasks') throw new Error(`Unsupported DEPLOY_QUEUE mode: ${mode}`);
  const queue = process.env.CLOUD_TASKS_QUEUE;
  const workerUrl = process.env.DEPLOY_WORKER_URL;
  const serviceAccountEmail = process.env.CLOUD_TASKS_SERVICE_ACCOUNT;
  if (!queue || !workerUrl || !serviceAccountEmail) throw new Error('Media migration requires the configured Cloud Tasks worker.');
  const { CloudTasksClient } = await import('@google-cloud/tasks');
  const client = new CloudTasksClient();
  try {
    await client.createTask({ parent: queue, task: {
      // Every accepted continuation needs a fresh identity: Cloud Tasks retains
      // consumed names. Leases and durable per-file cursors make duplicates safe.
      name: `${queue}/tasks/media-${randomUUID()}`,
      ...(delayMs > 0 ? { scheduleTime: { seconds: Math.ceil((Date.now() + delayMs) / 1000) } } : {}),
      httpRequest: { httpMethod: 'POST', url: workerUrl, headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify({ kind: 'media_migration', orgId, ...(siteId ? { siteId } : {}) })).toString('base64'),
        oidcToken: { serviceAccountEmail, audience: workerUrl } },
    } });
  } finally { await client.close(); }
}
