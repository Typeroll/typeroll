import { MEDIA_RECIPE_VERSION } from '../../../../../scripts/fixtures/static-publication/media-recipe.mjs';
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
import type { BuildDiagnostic } from '../builds/diagnostics.mjs';

interface Preparation { recipe?: string; full_scan?: boolean; org: string; site: string; state: 'queued' | 'running' | 'complete' | 'waiting' | 'failed'; request: string; active_request?: string; lease: string | null; lease_until: number; next_at: number; first_requested_at?: number; round_request?: string; task?: string | null; error?: string | null; entries?: Array<{ id: string; sha256: string }>; completed?: number; total?: number; unreadable?: string[] }
const jobPath = (org: string, site: string) => `media_preparations/${sha256(`${org}\0${site}`)}`;
const imageTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif']);
/** Already prepared, or known not to decode, for these exact bytes and recipe. */
const settled = (file: Media) => !!file.preparation && ['ready', 'unreadable'].includes(file.preparation.state) &&
  file.preparation.source_sha256 === file.sha256 && file.preparation.recipe === MEDIA_RECIPE_VERSION;
const UNREADABLE_LIMIT = 50;

/**
 * The library image a failed preparation round could not decode. The media
 * script names the file in a fixed locator line; only a first-attempt failure
 * while inspecting or encoding qualifies, so storage and timeout failures,
 * which it retries, still fail the job. The id must belong to the round.
 */
export function unreadableMedia(task: Pick<BuildTask, 'status' | 'error_code' | 'error_detail'> | null, entries: Array<{ id: string }>): string | null {
  if (task?.status !== 'failed' || !task.error_code?.startsWith('media_') || /timeout|interrupted/.test(task.error_code)) return null;
  const detail: BuildDiagnostic | null | undefined = task.error_detail;
  if (!detail || /media_transfer_interrupted|TimeoutError/.test(detail.cause ?? '')) return null;
  for (const line of [detail.cause ?? '', ...[...detail.lines].reverse()]) {
    const match = /step=(?:inspect_image|encode_variant) media="([A-Za-z0-9_-]{1,128})"[^\n]* attempts=1(?!\d)/.exec(line);
    if (match) return entries.some(entry => entry.id === match[1]) ? match[1] : null;
  }
  return null;
}

/**
 * What an upload response says about the image preparation it queued. The
 * job starts on the organization's shared build engine after a short delay,
 * coalesced per site, so its id is not known yet when the upload returns.
 */
export const QUEUED_PREPARATION = {
  state: 'queued',
  runs_on: 'organization_build_engine',
  starts: 'after 30 s without new uploads to the site, at most 5 min after the first',
  status: 'GET media/preparation (MCP get_media_preparation) returns build_job_id once the job starts.',
} as const;

/**
 * Uploads that arrive within this quiet window share one preparation job. A
 * slow series of single-file imports (one every few seconds) used to start a
 * job after a fixed 10 s, then another for every later batch, each occupying
 * the organization's shared build engine.
 */
export const PREPARATION_QUIET_MS = 30_000;
/** A steady stream of uploads still starts a job this long after its first request. */
export const PREPARATION_MAX_WAIT_MS = 5 * 60_000;

/** When a queued job should start: after the quiet window, never later than the cap. */
export function preparationStartAt(now: number, firstRequestedAt: number | undefined): number {
  return Math.min(now + PREPARATION_QUIET_MS, (firstRequestedAt ?? now) + PREPARATION_MAX_WAIT_MS);
}

/** Coalesce upload notifications. Durable scheduling never requires a browser to stay open. */
export async function requestMediaPreparation(org: string, site: string, mediaId?: string): Promise<boolean> {
  const store = getStore(), path = jobPath(org, site);
  if (mediaId) {
    // Finalization names the immutable file it just completed. Never discover
    // automatic work by scanning all legacy records without preparation flags.
    const queued = await store.compareAndUpdateDoc<Media>(`${paths.media(org, site)}/${mediaId}`,
      file => imageTypes.has(file.mime_type ?? '') && file.storage?.provider === 'organization_r2' && file.storage.state === 'ready' && !!file.sha256 && !settled(file),
      { preparation_pending: true });
    if (!queued) return false;
  }
  const now = Date.now();
  const created = await store.createDocIfMissing(path, { org, site, full_scan: !mediaId, state: 'queued', request: randomUUID(), lease: null, lease_until: 0, first_requested_at: now, next_at: preparationStartAt(now, now) });
  const current = await store.getDoc<Preparation>(path);
  // A queued job waits for the uploads to go quiet; a running job keeps its
  // schedule and picks the new files up in its next round. A finished job
  // starts a new window.
  // An explicit request (prepare_media, a migration) starts without waiting.
  const fresh = current?.state === 'complete' || current?.state === 'failed';
  const schedule = !mediaId && current?.state !== 'running' ? { first_requested_at: now, next_at: now }
    : !current || created ? {}
    : fresh ? { first_requested_at: now, next_at: preparationStartAt(now, now) }
      : current.state === 'queued' && !current.task ? { next_at: preparationStartAt(now, current.first_requested_at ?? now) }
        : {};
  await store.compareAndUpdateDoc<Preparation>(path, value => value.request === current?.request, { request: randomUUID(), state: current?.state === 'running' ? 'running' : 'queued', error: null, ...schedule, ...(!mediaId ? { full_scan: true } : current?.state === 'complete' ? { full_scan: false } : {}), ...(current?.state === 'failed' ? { task: null } : {}) });
  const { enqueueMediaMigration } = await import('../publishing/media-migration-queue');
  if (created || !['queued', 'running'].includes(current?.state ?? '')) await enqueueMediaMigration(org, 10000).catch(() => { console.error('[media-preparation] scheduling interrupted; durable work will be recovered'); });
  return true;
}

/** Uses the selected customer engine, with private cache grants and no hosting target. */
export async function runPendingMediaPreparation(org?: string): Promise<boolean> {
  const store = getStore(); let pending = false;
  for (const item of await store.listDocs<Preparation>('media_preparations', { filters: org ? [{ field: 'org', op: '==', value: org }] : [{ field: 'state', op: 'in', value: ['queued', 'running', 'waiting'] }] })) {
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
        let result;
        try { result = await completedBuild(item.org, item.task); }
        catch (error) {
          // One image that does not decode must not hold back the rest of the
          // library. Record it against its bytes and run the round without it.
          const failed = await store.getDoc<BuildTask>(`${buildTasksPath(item.org)}/${item.task}`);
          const id = unreadableMedia(failed, item.entries ?? []);
          const entry = item.entries?.find(value => value.id === id);
          if (!entry) throw error;
          await store.compareAndUpdateDoc<Media>(`${paths.media(item.org, item.site)}/${entry.id}`, value => value.sha256 === entry.sha256,
            { preparation_pending: false, preparation: { state: 'unreadable', source_sha256: entry.sha256, recipe: item.recipe ?? MEDIA_RECIPE_VERSION } });
          const unreadable = [...new Set([entry.id, ...(item.unreadable ?? [])])].slice(0, UNREADABLE_LIMIT);
          console.warn(`[media-preparation] skipped an image that could not be decoded org=${item.org} site=${item.site} media=${entry.id}`);
          await store.compareAndUpdateDoc<Preparation>(path, value => value.lease === lease,
            { task: null, state: 'queued', error: null, next_at: Date.now(), unreadable });
          pending = true;
          continue;
        }
        if (!result) { pending = true; continue; }
        // A completion from before a rollout keeps its actual recipe identity.
        const completedRecipe = item.recipe ?? 'v1';
        for (const entry of item.entries ?? []) await store.compareAndUpdateDoc<Media>(`${paths.media(item.org, item.site)}/${entry.id}`,
          value => value.sha256 === entry.sha256, { preparation_pending: completedRecipe !== MEDIA_RECIPE_VERSION, preparation: { state: 'ready', source_sha256: entry.sha256, recipe: completedRecipe } });
        // Files uploaded while this round ran wait for a quiet window too;
        // without new uploads the job finishes on the next poll.
        const finishedAt = Date.now();
        const uploadedMeanwhile = item.round_request !== undefined && item.request !== item.round_request;
        await store.compareAndUpdateDoc<Preparation>(path, value => value.lease === lease,
          { task: null, state: 'queued', completed: item.entries?.length ?? 0, error: null, ...(uploadedMeanwhile ? { first_requested_at: finishedAt, next_at: preparationStartAt(finishedAt, finishedAt) } : {}) });
        pending = true;
        continue;
      }
      const engine = await readEngineConfiguration(item.org, await selectedBuildProvider(item.org));
      const connection = await getConnection(item.org, 'cloudflare');
      if (!engine || !engine.media_preparation || engine.status !== 'ready' || !connection.media_ready || !connection.cloudflare?.public_bucket) {
        await update({ state: 'waiting', next_at: Date.now() + 60000, error: 'Connect media storage and finish or update Builds setup in Publishing to prepare images automatically.' });
        continue;
      }
      // Jobs queued before targeted uploads shipped retain their library scope.
      // A new automatic request after completion explicitly switches it off.
      const media = (await store.listDocs<Media>(paths.media(item.org, item.site), item.full_scan !== false ? undefined : { filters: [{ field: 'preparation_pending', op: '==', value: true }] }))
        .filter(file => imageTypes.has(file.mime_type ?? '') && file.storage?.provider === 'organization_r2' && file.storage.state === 'ready' && file.sha256 && !settled(file)).slice(0, 1000);
      if (!media.length) {
        const finished = await store.compareAndUpdateDoc<Preparation>(path, value => value.lease === lease && value.request === item.request, { state: 'complete', full_scan: false, error: null });
        pending ||= !finished; continue;
      }
      const prefix = await siteMediaPrefix(item.org, item.site);
      const entries = media.map(file => ({ id: file.id, source_key: file.storage!.key, sha256: file.sha256!, size_bytes: file.size_bytes,
        mime_type: file.mime_type, public_key: `${prefix}/prepared/${file.sha256}`, public_path: `/prepared/${file.sha256}`, aliases: [] }));
      const preparationRequest = randomUUID();
      const publicationId = sha256(JSON.stringify({ request: preparationRequest, entries, recipe: MEDIA_RECIPE_VERSION }));
      const publication = { core_commit: process.env.TYPEROLL_SOURCE_SHA, publication_id: publicationId, media: entries,
        media_manifest: { cache_only: true, site_prefix: prefix, entries, account_id: connection.cloudflare.account_id,
          original_bucket: connection.cloudflare.bucket, public_bucket: connection.cloudflare.public_bucket } };
      const source = await publicationSourceTree(publication);
      if (!await update({ active_request: preparationRequest })) { pending = true; continue; }
      const queued = await enqueueBuild(engine, { org_id: item.org, site_id: item.site, version_id: 'main', job_id: `media-${preparationRequest}`,
        publication_id: publicationId, commit: engine.runner_commit, branch: 'main' }, source, 'media_preparation');
      await update({ task: queued.key, recipe: MEDIA_RECIPE_VERSION, active_request: preparationRequest, round_request: item.request, entries: entries.map(({ id, sha256 }) => ({ id, sha256 })),
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
  // The build engine job id lets agents see the job among the organization's active builds.
  const running = item.state === 'running' && item.task;
  return { state: item.state, completed: task?.media_cursor ?? item.completed ?? 0, total: task?.media_total ?? item.total ?? 0, error: item.error ?? null,
    build_job_id: running && item.active_request ? `media-${item.active_request}` : null, build_task: running ? item.task : null,
    // Library images whose stored file does not decode. They were skipped; upload a working copy to prepare them.
    unreadable_media: item.unreadable ?? [] };
}

export async function preparationStillRunning(task: BuildTask) {
  const job = await getStore().getDoc<Preparation>(jobPath(task.identity.org_id, task.identity.site_id));
  const site = await getStore().getDoc(paths.site(task.identity.org_id, task.identity.site_id));
  return Boolean(site && job && ['queued', 'running', 'waiting'].includes(job.state) && task.identity.job_id === `media-${job.active_request}`);
}
