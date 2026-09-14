import { randomUUID } from 'node:crypto';
import { paths, type Media } from '@typeroll/shared';
import { getStore } from '../datastore';
import { siteMediaPrefix } from '../media-keys';
import { getConnection } from '../publishing/connections';
import { publicationSourceTree } from '../publishing/source-tree';
import { selectedBuildProvider } from '../builds/selection';
import { readEngineConfiguration } from '../builds/state';
import { enqueueBuild, completedBuild } from '../builds/jobs';
import { sha256 } from '../builds/contract.mjs';
import { buildTasksPath, type BuildTask } from '../builds/queue';

interface Preparation { org: string; site: string; state: 'queued' | 'running' | 'complete' | 'waiting' | 'failed'; request: string; active_request?: string; lease: string | null; lease_until: number; next_at: number; task?: string | null; error?: string | null; entries?: Array<{ id: string; sha256: string }>; completed?: number; total?: number }
const jobPath = (org: string, site: string) => `media_preparations/${sha256(`${org}\0${site}`)}`;
const imageTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif']);

/** Coalesce upload notifications. Durable scheduling never requires a browser to stay open. */
export async function requestMediaPreparation(org: string, site: string) {
  const store = getStore(), path = jobPath(org, site);
  const created = await store.createDocIfMissing(path, { org, site, state: 'queued', request: randomUUID(), lease: null, lease_until: 0, next_at: Date.now() + 10000 });
  const current = await store.getDoc<Preparation>(path);
  await store.compareAndUpdateDoc<Preparation>(path, value => value.request === current?.request, { request: randomUUID(), state: 'queued', error: null, ...(current?.state === 'failed' ? { task: null } : {}) });
  const { enqueueMediaMigration } = await import('../publishing/media-migration-queue');
  if (created || !['queued', 'running'].includes(current?.state ?? '')) await enqueueMediaMigration(org, 10000).catch(() => { console.error('[media-preparation] scheduling interrupted; durable work will be recovered'); });
}

/** Uses the selected customer engine, with private cache grants and no hosting target. */
export async function runPendingMediaPreparation(org?: string): Promise<boolean> {
  const store = getStore(); let pending = false;
  for (const item of await store.listDocs<Preparation>('media_preparations', { filters: org ? [{ field: 'org', op: '==', value: org }] : [] })) {
    if (item.state === 'complete' || item.state === 'failed') continue;
    if (item.lease_until > Date.now() || item.next_at > Date.now()) { pending = true; continue; }
    const path = jobPath(item.org, item.site), lease = randomUUID();
    const won = await store.compareAndUpdateDoc<Preparation>(path, value => value.lease_until <= Date.now() && value.request === item.request,
      { lease, lease_until: Date.now() + 90000 });
    if (!won) { pending = true; continue; }
    const heartbeat = setInterval(() => { void store.compareAndUpdateDoc<Preparation>(path, value => value.lease === lease, { lease_until: Date.now() + 90000 }).catch(() => {}); }, 20000);
    const update = (value: Record<string, unknown>) => store.compareAndUpdateDoc<Preparation>(path, current => current.lease === lease && current.lease_until > Date.now(), value);
    try {
      if (item.task) {
        const result = await completedBuild(item.org, item.task);
        if (!result) { pending = true; continue; }
        for (const entry of item.entries ?? []) await store.compareAndUpdateDoc<Media>(`${paths.media(item.org, item.site)}/${entry.id}`,
          value => value.sha256 === entry.sha256, { preparation: { state: 'ready', source_sha256: entry.sha256, recipe: 'v1' } });
        await store.compareAndUpdateDoc<Preparation>(path, value => value.lease === lease,
          { task: null, state: 'queued', completed: item.entries?.length ?? 0, error: null });
        pending = true;
        continue;
      }
      const engine = await readEngineConfiguration(item.org, await selectedBuildProvider(item.org));
      const connection = await getConnection(item.org, 'cloudflare');
      if (!engine || !engine.media_preparation || engine.status !== 'ready' || !connection.media_ready || !connection.cloudflare?.public_bucket) {
        await update({ state: 'waiting', next_at: Date.now() + 60000, error: 'Connect media storage and finish or update Builds setup in Publishing to prepare images automatically.' });
        continue;
      }
      const media = (await store.listDocs<Media & { preparation?: { source_sha256: string; recipe: string; state: string } }>(paths.media(item.org, item.site)))
        .filter(file => imageTypes.has(file.mime_type ?? '') && file.storage?.provider === 'organization_r2' && file.storage.state === 'ready' && file.sha256 &&
          !(file.preparation?.state === 'ready' && file.preparation.source_sha256 === file.sha256 && file.preparation.recipe === 'v1')).slice(0, 1000);
      if (!media.length) {
        const finished = await store.compareAndUpdateDoc<Preparation>(path, value => value.lease === lease && value.request === item.request, { state: 'complete', error: null });
        pending ||= !finished; continue;
      }
      const prefix = await siteMediaPrefix(item.org, item.site);
      const entries = media.map(file => ({ id: file.id, source_key: file.storage!.key, sha256: file.sha256!, size_bytes: file.size_bytes,
        mime_type: file.mime_type, public_key: `${prefix}/prepared/${file.sha256}`, public_path: `/prepared/${file.sha256}`, aliases: [] }));
      const preparationRequest = randomUUID();
      const publicationId = sha256(JSON.stringify({ request: preparationRequest, entries, recipe: 'v1' }));
      const publication = { core_commit: process.env.TYPEROLL_SOURCE_SHA, publication_id: publicationId, media: entries,
        media_manifest: { cache_only: true, site_prefix: prefix, entries, account_id: connection.cloudflare.account_id,
          original_bucket: connection.cloudflare.bucket, public_bucket: connection.cloudflare.public_bucket } };
      const source = await publicationSourceTree(publication);
      if (!await update({ active_request: preparationRequest })) { pending = true; continue; }
      const queued = await enqueueBuild(engine, { org_id: item.org, site_id: item.site, version_id: 'main', job_id: `media-${preparationRequest}`,
        publication_id: publicationId, commit: engine.runner_commit, branch: 'main' }, source, 'media_preparation');
      await update({ task: queued.key, active_request: preparationRequest, entries: entries.map(({ id, sha256 }) => ({ id, sha256 })),
        state: 'running', total: entries.length, completed: 0, next_at: 0 });
      pending = true;
    } catch {
      await store.compareAndUpdateDoc<Preparation>(path, value => value.lease === lease,
        { state: 'failed', error: 'Image preparation stopped. The originals are safe. Retry preparation or publish to prepare the required images.' });
    } finally {
      clearInterval(heartbeat);
      await store.compareAndUpdateDoc<Preparation>(path, value => value.lease === lease, { lease: null, lease_until: 0 });
    }
  }
  return pending;
}

export async function mediaPreparationStatus(org: string, site: string) {
  const item = await getStore().getDoc<Preparation>(jobPath(org, site));
  if (!item) return null;
  const task = item.task ? await getStore().getDoc<BuildTask>(`${buildTasksPath(org)}/${item.task}`) : null;
  return { state: item.state, completed: task?.media_cursor ?? item.completed ?? 0, total: task?.media_total ?? item.total ?? 0, error: item.error ?? null };
}

export async function preparationStillRunning(task: BuildTask) {
  const job = await getStore().getDoc<Preparation>(jobPath(task.identity.org_id, task.identity.site_id));
  const site = await getStore().getDoc(paths.site(task.identity.org_id, task.identity.site_id));
  return Boolean(site && job && ['queued', 'running', 'waiting'].includes(job.state) && task.identity.job_id === `media-${job.active_request}`);
}
