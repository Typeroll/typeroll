import { createHash } from 'node:crypto';
import { requestChain, runChainDelivery, type Enqueue } from '../scheduling/chain';
import { executeMediaMigration } from './media-migration';

/** One delivery chain per Organization (preparation) or per Site (migration). */
export const mediaChainKey = (orgId: string, siteId?: string) => siteId ? `media:${orgId}:${siteId}` : `media:${orgId}`;

/** Ask for media work; joins the existing chain for the same Organization or Site. */
/** Without a Site, runs Organization media work and pending preparation; with one, that Site's migration only. */
export async function enqueueMediaMigration(orgId: string, delayMs = 0, siteId?: string): Promise<void> {
  const mode = (process.env.DEPLOY_QUEUE ?? 'in_process').toLowerCase();
  if (mode === 'firestore') return; // The persisted migration itself is the portable worker's queue item.
  await requestChain(mediaChainKey(orgId, siteId), delayMs, transport(orgId, siteId, mode));
}

/** One delivery: runs the work, then schedules the chain's next delivery if needed. */
export async function deliverMediaMigration(orgId: string, siteId: string | undefined, generation: number): Promise<'ran' | 'superseded'> {
  const mode = (process.env.DEPLOY_QUEUE ?? 'in_process').toLowerCase();
  return runChainDelivery(mediaChainKey(orgId, siteId), generation, () => executeMediaMigration(orgId, siteId), transport(orgId, siteId, mode));
}

function transport(orgId: string, siteId: string | undefined, mode: string): Enqueue {
  if (mode === 'in_process') return async (generation, delayMs) => {
    const timer = setTimeout(() => {
      void deliverMediaMigration(orgId, siteId, generation).catch(() => console.error('[media-migration] local worker interrupted; persisted work will be recovered'));
    }, delayMs);
    timer.unref();
  };
  if (mode !== 'cloud_tasks') throw new Error(`Unsupported DEPLOY_QUEUE mode: ${mode}`);
  return async (generation, delayMs) => {
    const queue = process.env.CLOUD_TASKS_QUEUE;
    const workerUrl = process.env.DEPLOY_WORKER_URL;
    const serviceAccountEmail = process.env.CLOUD_TASKS_SERVICE_ACCOUNT;
    if (!queue || !workerUrl || !serviceAccountEmail) throw new Error('Media migration requires the configured Cloud Tasks worker.');
    const { CloudTasksClient } = await import('@google-cloud/tasks');
    const client = new CloudTasksClient();
    // A deterministic name per chain generation: a repeated enqueue of the same
    // generation is deduplicated by the queue instead of adding a delivery.
    const identity = createHash('sha256').update(`${mediaChainKey(orgId, siteId)}:${generation}`).digest('hex');
    try {
      await client.createTask({ parent: queue, task: {
        name: `${queue}/tasks/media-${identity}`,
        ...(delayMs > 0 ? { scheduleTime: { seconds: Math.ceil((Date.now() + delayMs) / 1000) } } : {}),
        httpRequest: { httpMethod: 'POST', url: workerUrl, headers: { 'Content-Type': 'application/json' },
          body: Buffer.from(JSON.stringify({ kind: 'media_migration', orgId, generation, ...(siteId ? { siteId } : {}) })).toString('base64'),
          oidcToken: { serviceAccountEmail, audience: workerUrl } },
      } });
    } catch (error) { if ((error as { code?: number }).code !== 6) throw error; }
    finally { await client.close(); }
  };
}
