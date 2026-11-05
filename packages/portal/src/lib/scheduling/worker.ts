import { readOrganizationAccess } from '../organization-access';
import { createHash, randomUUID } from 'node:crypto';
import { getStore, type ReadWriteStore } from '../datastore';
import { paths, type DeployJob } from '@typeroll/shared';
import { ConnectionError } from '../publishing/connections';
import { findActiveDeploy } from '../deploy/in-flight';
import { WORK_COLLECTION, workPath, notifyScheduledWrites, type ScheduledWork } from './index';
import { objectWorkStore, workLocation } from './objects';
import type { ScheduledDelivery } from '../store/object-scheduler';

export interface WorkResult { pages_published: number; pages_unpublished: number; deployed: string[]; auto_deployed: string[]; skipped_in_flight: string[]; errors: string[] }
export const emptyWorkResult = (): WorkResult => ({ pages_published: 0, pages_unpublished: 0, deployed: [], auto_deployed: [], skipped_in_flight: [], errors: [] });
const digest = (s: string) => createHash('sha256').update(s).digest('hex');

/** A store object's alarm hands one due item to the executor (bound by the Worker). Throws to retry. */
export async function deliverScheduledWork(delivery: Pick<ScheduledDelivery, 'object' | 'id' | 'generation'>): Promise<void> {
  await executeScheduledWork(delivery.id, delivery.generation, new Date(), emptyWorkResult(), delivery.object);
}

/**
 * Generation and lease checks make delayed and duplicate deliveries harmless.
 * `object` names the store object holding the work (sharded store); omitted in a single store.
 */
export async function executeScheduledWork(id: string, generation?: string, now = new Date(), result = emptyWorkResult(), object?: string | null): Promise<WorkResult> {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid work identity');
  if (object !== undefined && object !== null && !/^(global|org:[A-Za-z0-9_-]{1,200}|site:[A-Za-z0-9-]{1,64})$/.test(object)) throw new Error('Invalid store object');
  const store = getStore(), work = objectWorkStore(object), path = `${WORK_COLLECTION}/${id}`;
  const current = await work.getDoc<ScheduledWork>(path);
  if (!current || (generation && current.generation !== generation) || current.due_at === Number.MAX_SAFE_INTEGER) return result;
  if (current.due_at > now.valueOf()) {
    await notifyScheduledWrites([{ path, data: current }]);
    return result;
  }
  const owner = randomUUID();
  const acquired = await work.compareAndUpdateDoc<ScheduledWork>(path, value => value.generation === current.generation && (value.lease_until ?? 0) <= now.valueOf(),
    { lease_until: now.valueOf() + 300000, lease_owner: owner });
  if (!acquired) throw new Error('Scheduled work is already running');
  try {
    const parts = current.source.split('/'), org = parts[1], siteId = parts[3];
    if (['page_schedule', 'site_publish'].includes(current.kind) && !(await readOrganizationAccess(org)).can_write) {
      await work.compareAndUpdateDoc<ScheduledWork>(path, value => value.generation === current.generation && value.lease_owner === owner,
        { due_at: Number.MAX_SAFE_INTEGER, lease_until: 0, lease_owner: null, blocked_by: 'organization_access' });
      return result;
    }
    if (current.kind === 'organization_access_notice') {
      const { deliverAccessNotice } = await import('../organization-access-notices');
      await deliverAccessNotice(org, current.payload.ends_at, current.payload.days_before, now.valueOf());
    } else if (current.kind === 'build_continue') {
      const task = await store.getDoc<any>(current.source);
      if (task?.status === 'queued' && task.attempt === current.payload.attempt && task.media_cursor === current.payload.cursor) {
        const { completedBuild } = await import('../builds/jobs');
        const inputPath = `organizations/${org}/build_inputs/${parts[3]}`;
        const before = await store.getDoc<any>(inputPath);
        try { await completedBuild(org, parts[3]); }
        catch (error) {
          if (!(error instanceof ConnectionError)) throw error;
          await store.compareAndUpdateDoc<any>(current.source, value => value.status === 'queued' && value.attempt === task.attempt,
            { status: 'failed', token_hash: null, completed_at: now.valueOf(), error_code: error.code ?? 'build_continuation_failed' });
        }
        const after = await store.getDoc<any>(inputPath);
        const saved = await store.getDoc<any>(current.source);
        if (saved?.status === 'queued' && after?.dispatch_id === before?.dispatch_id && !after?.dispatch_uncertain) {
          throw new Error('Previous runner has not released its provider execution; retry continuation delivery');
        }
      }
    } else if (current.kind === 'build_result') {
      const task = await store.getDoc<any>(current.source);
      const input = await store.getDoc<any>(`organizations/${org}/build_inputs/${parts[3]}`);
      if (task && input && ['completed', 'failed', 'cancelled'].includes(task.status)) {
        const { wakeCompletedPublication } = await import('../builds/publication-wakeup');
        await wakeCompletedPublication(org, parts[3], input.kind);
      }
    } else if (current.kind === 'page_schedule') {
      const page = await store.getDoc<any>(current.source);
      const publish = page?.status !== 'published' && page?.publish_at && Date.parse(page.publish_at) <= now.valueOf();
      const unpublish = page?.status === 'published' && page?.unpublish_at && Date.parse(page.unpublish_at) <= now.valueOf();
      const sitePath = paths.site(org, siteId);
      if (page && (publish || unpublish) && await store.getDoc(sitePath)) {
        // The page transition and the site's pending-publication marker commit together.
        const changed = await store.compareAndReplaceDoc(current.source, page, {
          ...page, status: publish ? 'published' : 'draft',
          ...(publish ? { publish_at: null, date_published: page.date_published ?? now.toISOString() } : { unpublish_at: null }),
        }, [{ path: sitePath, data: { scheduled_publish_pending_at: now.toISOString(), scheduled_publish_revision: randomUUID() } }]);
        if (changed) { if (publish) result.pages_published++; else result.pages_unpublished++; }
      }
    } else if (current.kind === 'form_partial_abandoned') {
      // Written by the submit endpoint (lib/forms/abandoned.ts), not by the
      // datastore index: submissions are not scheduled sources.
      const { runAbandonedPartial } = await import('../forms/abandoned');
      const next = await runAbandonedPartial(current.source, now.valueOf());
      if (next !== null) {
        await postpone(work, path, current.generation, next);
        return result;
      }
    } else if (current.kind === 'form_webhook_retry') {
      // Written by lib/forms/webhook.ts for a pending webhook delivery; the
      // delivery record leases each attempt, so duplicates are harmless.
      const { retryFormWebhookDelivery } = await import('../forms/webhook');
      const next = await retryFormWebhookDelivery(current.source, now.valueOf());
      if (next !== null) {
        await postpone(work, path, current.generation, next);
        return result;
      }
    } else if (current.kind === 'domain_serving_check') {
      // Written by lib/publishing/serving-check.ts when a website host goes live;
      // read-only follow-up checks of who actually answers the host.
      const { runScheduledServingCheck } = await import('../publishing/serving-check');
      const next = await runScheduledServingCheck(current.source, current.payload, now.valueOf());
      if (next !== null) {
        await postpone(work, path, current.generation, next);
        return result;
      }
    } else if (current.kind === 'workflow_chunk') {
      // Written by lib/workflows/queue.ts: one chunk of a workflow run. The
      // run's own chunk id and lease make stale and duplicate deliveries
      // harmless; enqueueing the next chunk replaces this entry.
      const { runScheduledWorkflowChunk } = await import('../workflows/queue');
      const retryAt = await runScheduledWorkflowChunk(current.source, current.payload);
      if (retryAt !== null) {
        await postpone(work, path, current.generation, retryAt);
        return result;
      }
    } else if (current.kind === 'media_chain') {
      // One delivery of a media chain (publishing/media-migration-queue.ts); the chain record drops superseded ones.
      const { deliverMediaMigration } = await import('../publishing/media-migration-queue');
      await deliverMediaMigration(current.payload.org_id, current.payload.site_id ?? undefined, Number(current.generation));
    } else if (current.kind === 'deploy_dispatch') {
      // An accepted deploy request (deploy/queue.ts). The job document decides whether it still runs.
      if (!await runDeployDispatch(current)) throw new Error('Deploy is waiting for a build slot or a concurrent update; retry delivery');
    } else if (current.kind === 'site_publish') {
      const site = await store.getDoc<any>(current.source);
      if (site) {
        if (['pending_deploy_at', 'scheduled_publish_pending_at', 'pending_deploy_revision', 'scheduled_publish_revision']
          .some(key => (site[key] ?? null) !== current.payload[key])) return result;
        const jobId = `scheduled-${digest(current.source + ':' + JSON.stringify(current.payload)).slice(0, 24)}`;
        const active = findActiveDeploy(await store.listDocs<DeployJob>(paths.deploys(org, siteId)));
        if (active && active.id !== jobId) {
          result.skipped_in_flight.push(`${org}/${siteId}`);
          // Completion of the active job wakes this exact pending publication.
          await work.compareAndUpdateDoc<ScheduledWork>(path, value => value.generation === current.generation,
            { due_at: Number.MAX_SAFE_INTEGER, lease_until: 0, lease_owner: null, blocked_by: active.id } as Partial<ScheduledWork>);
          // Close the race where completion happened immediately before parking.
          const blocker = await store.getDoc<any>(paths.deploy(org, siteId, active.id));
          if (!blocker || ['succeeded', 'failed'].includes(blocker.status)) await wakePendingSite(org, siteId, active.id);
          return result;
        }
        const jobPath = paths.deploy(org, siteId, jobId);
        await store.createDocIfMissing(jobPath, { version_id: 'main', environment: 'production', status: 'queued', started_at: now.toISOString(), triggered_by: 'scheduled-publish' });
        const { getDeployQueue } = await import('../deploy/queue');
        await getDeployQueue().enqueue({ orgId: org, siteId, jobId, versionId: 'main', environment: 'production' });
        // Never erase an edit that arrived while dispatching this publication.
        await store.compareAndUpdateDoc<any>(current.source, saved => ['pending_deploy_at', 'scheduled_publish_pending_at', 'pending_deploy_revision', 'scheduled_publish_revision'].every(key => saved[key] === site[key]),
          { pending_deploy_at: null, scheduled_publish_pending_at: null });
        result.deployed.push(`${org}/${siteId}`);
        if (site.pending_deploy_at) result.auto_deployed.push(`${org}/${siteId}`);
      }
    } else {
      const job = await store.getDoc<any>(current.source);
      if (job && ['queued', 'running'].includes(job.status) && job.phase !== 'awaiting domain cutover approval') {
        const { executeDeployJob } = await import('../deploy/queue');
        const outcome = await executeDeployJob({ orgId: org, siteId, jobId: parts[5], versionId: job.version_id, environment: job.environment, dryRun: job.dry_run === true }, { slotWaitMs: 0 });
        if (outcome === 'deferred') throw new Error('Publication is already executing; retry delivery');
        if (outcome === 'continue') {
          const { schedulePublication } = await import('./continuation');
          // Some backends save their own next checkpoint. Do not overwrite it.
          const saved = await store.getDoc<any>(current.source);
          if ((saved?.continuation?.token ?? 'initial') === current.payload.token) await schedulePublication(current.source, 'checkpoint');
        }
      }
      const saved = await store.getDoc<any>(current.source);
      if (!saved || ['succeeded', 'failed'].includes(saved.status)) await wakePendingSite(org, siteId, parts[5]);
    }
    await work.compareAndUpdateDoc<ScheduledWork>(path, value => value.generation === current.generation && value.lease_owner === owner,
      { due_at: Number.MAX_SAFE_INTEGER, lease_until: 0, lease_owner: null });
    return result;
  } catch (error) {
    await work.compareAndUpdateDoc<ScheduledWork>(path, value => value.generation === current.generation && value.lease_owner === owner, { lease_until: 0, lease_owner: null });
    throw error;
  }
}

async function postpone(store: ReadWriteStore, path: string, generation: string, due: number) {
  const changed = await store.compareAndUpdateDoc<ScheduledWork>(path, value => value.generation === generation,
    { due_at: due, lease_until: 0, lease_owner: null, generation: randomUUID(), blocked_by: null } as Partial<ScheduledWork>);
  if (changed) {
    const saved = await store.getDoc<ScheduledWork>(path);
    if (saved) await notifyScheduledWrites([{ path, data: saved }]);
  }
}

export async function wakePendingSite(org: string, siteId: string, completedJob?: string) {
  const sitePath = paths.site(org, siteId), path = workPath(sitePath, 'site_publish');
  const { store } = await workLocation(sitePath);
  const work = await store.getDoc<ScheduledWork>(path);
  if (work && work.blocked_by && (!completedJob || work.blocked_by === completedJob)) await postpone(store, path, work.generation, Date.now());
}

/**
 * One accepted deploy request: runs only while the job is queued, or running
 * on an external engine (whose coordinator resumes in steps). True when the
 * delivery is consumed; false hands it back for a retry.
 */
async function runDeployDispatch(work: ScheduledWork): Promise<boolean> {
  const store = getStore(), jobPath = work.source;
  const [, org, , siteId, , jobId] = jobPath.split('/');
  const job = await store.getDoc<DeployJob & { continuation?: { token?: string } }>(jobPath);
  if (!job) return true;
  const { isExternalDeploy } = await import('../deploy/in-flight');
  if (job.status !== 'queued' && !(job.status === 'running' && isExternalDeploy(job))) return true;
  const { executeDeployJob } = await import('../deploy/queue');
  const { slotWaitMs } = await import('../deploy/concurrency');
  // dryRun travels with the request: dropping it once turned dry runs into production deploys.
  const outcome = await executeDeployJob({ orgId: org!, siteId: siteId!, jobId: jobId!, versionId: work.payload.version_id,
    environment: work.payload.environment, dryRun: work.payload.dry_run === true }, { slotWaitMs: slotWaitMs() });
  if (outcome === 'ran') return true;
  const pending = await store.getDoc<DeployJob & { continuation?: { token?: string } }>(jobPath);
  if (!pending || !isExternalDeploy(pending) || !['queued', 'running'].includes(pending.status)) return outcome !== 'deferred';
  if (outcome === 'waiting') return true;
  if (outcome === 'continue') {
    // Some backends save their own next checkpoint. Do not overwrite it.
    if (!pending.continuation || pending.continuation.token === job.continuation?.token) {
      const { schedulePublication } = await import('./continuation');
      await schedulePublication(jobPath, 'checkpoint');
    }
    return true;
  }
  // Contention is a delivery retry, never a second observation chain.
  return false;
}

/**
 * The sweep of a single store (local development): at most 100 due index
 * entries, no organization, site, page or deploy-history scan. On Cloudflare
 * each store object delivers its own work; sweep.ts is the Cron safety net.
 */
export async function runDueScheduledWork(now = new Date()): Promise<WorkResult> {
  const store = getStore(), result = emptyWorkResult();
  const due = await store.listDocs<ScheduledWork>(WORK_COLLECTION, { filters: [{ field: 'due_at', op: '<=', value: now.valueOf() }], limit: 100 });
  // Coalesce due page transitions before their site publications.
  due.sort((a, b) => Number(b.kind === 'page_schedule') - Number(a.kind === 'page_schedule'));
  for (const work of due) {
    if ((work.lease_until ?? 0) > now.valueOf()) continue;
    try { await executeScheduledWork(work.id, work.generation, now, result); }
    catch { result.errors.push(`Scheduled work ${work.id} will retry`); }
  }
  // Newly created site markers are indexed atomically with page transitions.
  if (result.pages_published + result.pages_unpublished) {
    const sites = await store.listDocs<ScheduledWork>(WORK_COLLECTION, { filters: [{ field: 'due_at', op: '<=', value: now.valueOf() }], limit: 100 });
    for (const work of sites.filter(work => work.kind === 'site_publish')) {
      try { await executeScheduledWork(work.id, work.generation, now, result); }
      catch { result.errors.push(`Scheduled work ${work.id} will retry`); }
    }
  }
  return result;
}
