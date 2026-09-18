import { createHash, randomUUID } from 'node:crypto';
import { getStore } from '../datastore';
import { paths, type DeployJob } from '@typeroll/shared';
import { ConnectionError } from '../publishing/connections';
import { findActiveDeploy } from '../deploy/in-flight';
import { WORK_COLLECTION, workPath, notifyScheduledWrites, type ScheduledWork } from './index';

export interface WorkResult { pages_published: number; pages_unpublished: number; deployed: string[]; auto_deployed: string[]; skipped_in_flight: string[]; errors: string[] }
export const emptyWorkResult = (): WorkResult => ({ pages_published: 0, pages_unpublished: 0, deployed: [], auto_deployed: [], skipped_in_flight: [], errors: [] });
const digest = (s: string) => createHash('sha256').update(s).digest('hex');

/** Generation and lease checks make delayed and duplicate deliveries harmless. */
export async function executeScheduledWork(id: string, generation?: string, now = new Date(), result = emptyWorkResult()): Promise<WorkResult> {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid work identity');
  const store = getStore(), path = `${WORK_COLLECTION}/${id}`;
  const current = await store.getDoc<ScheduledWork>(path);
  if (!current || (generation && current.generation !== generation) || current.due_at === Number.MAX_SAFE_INTEGER) return result;
  if (current.due_at > now.valueOf()) {
    await notifyScheduledWrites([{ path, data: current }]);
    return result;
  }
  const owner = randomUUID();
  const acquired = await store.compareAndUpdateDoc<ScheduledWork>(path, work => work.generation === current.generation && (work.lease_until ?? 0) <= now.valueOf(),
    { lease_until: now.valueOf() + 300000, lease_owner: owner });
  if (!acquired) throw new Error('Scheduled work is already running');
  try {
    const parts = current.source.split('/'), org = parts[1], siteId = parts[3];
    if (current.kind === 'build_continue') {
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
          await store.compareAndUpdateDoc<ScheduledWork>(path, work => work.generation === current.generation,
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
    await store.compareAndUpdateDoc<ScheduledWork>(path, value => value.generation === current.generation && value.lease_owner === owner,
      { due_at: Number.MAX_SAFE_INTEGER, lease_until: 0, lease_owner: null });
    return result;
  } catch (error) {
    await store.compareAndUpdateDoc<ScheduledWork>(path, value => value.generation === current.generation && value.lease_owner === owner, { lease_until: 0, lease_owner: null });
    throw error;
  }
}

async function postpone(path: string, generation: string, due: number) {
  const store = getStore();
  const changed = await store.compareAndUpdateDoc<ScheduledWork>(path, value => value.generation === generation,
    { due_at: due, lease_until: 0, lease_owner: null, generation: randomUUID(), blocked_by: null } as Partial<ScheduledWork>);
  if (changed) {
    const saved = await store.getDoc<ScheduledWork>(path);
    if (saved) await notifyScheduledWrites([{ path, data: saved }]);
  }
}

export async function wakePendingSite(org: string, siteId: string, completedJob?: string) {
  const path = workPath(paths.site(org, siteId), 'site_publish');
  const work = await getStore().getDoc<ScheduledWork>(path);
  if (work && work.blocked_by && (!completedJob || work.blocked_by === completedJob)) await postpone(path, work.generation, Date.now());
}

/** At most 100 due index entries. No organization, site, page or deploy-history scan. */
export async function runDueScheduledWork(now = new Date()): Promise<WorkResult> {
  const store = getStore(), result = emptyWorkResult();
  const due = await store.listDocs<ScheduledWork>(WORK_COLLECTION, { filters: [{ field: 'due_at', op: '<=', value: now.valueOf() }], limit: 100 });
  // Coalesce due page transitions before their site publications.
  due.sort((a, b) => Number(b.kind === 'page_schedule') - Number(a.kind === 'page_schedule'));
  for (const work of due) {
    if ((work.lease_until ?? 0) > now.valueOf()) continue;
    try {
      if (process.env.DEPLOY_QUEUE === 'cloud_tasks') {
        const { dispatchScheduledWork } = await import('./transport');
        await dispatchScheduledWork(`${WORK_COLLECTION}/${work.id}`, work);
      } else await executeScheduledWork(work.id, work.generation, now, result);
    }
    catch { result.errors.push(`Scheduled work ${work.id} will retry`); }
  }
  // Newly created site markers are indexed atomically with page transitions.
  if (result.pages_published + result.pages_unpublished) {
    const sites = await store.listDocs<ScheduledWork>(WORK_COLLECTION, { filters: [{ field: 'due_at', op: '<=', value: now.valueOf() }], limit: 100 });
    for (const work of sites.filter(work => work.kind === 'site_publish')) {
      try {
      if (process.env.DEPLOY_QUEUE === 'cloud_tasks') {
        const { dispatchScheduledWork } = await import('./transport');
        await dispatchScheduledWork(`${WORK_COLLECTION}/${work.id}`, work);
      } else await executeScheduledWork(work.id, work.generation, now, result);
    }
      catch { result.errors.push(`Scheduled work ${work.id} will retry`); }
    }
  }
  return result;
}
