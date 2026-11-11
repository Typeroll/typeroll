import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { getStore, type ReadWriteStore } from '../datastore';
import { BUILD_PROTOCOL, assertBuildIdentity, sha256, type BuildIdentity, type RenderReport, type SeoReport } from './contract.mjs';
import { ConnectionError } from '../publishing/connections';
import type { BuildDiagnostic } from './diagnostics.mjs';

export interface BuildTask {
  identity: BuildIdentity;
  engine_revision: string;
  provider_dispatch_id?: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  created_at: number;
  queued_at?: number;
  completed_at?: number;
  deadline: number;
  attempt: number;
  media_total?: number;
  media_cursor?: number;
  media_batches?: number;
  /** Set once the coordinator ran the task again after build storage refused its artifact. */
  artifact_upload_retried?: boolean;
  media_checkpoint_attempt?: number;
  /** Background work nobody waits on. Claims take interactive work first. */
  background?: boolean;
  lease_id: string | null;
  lease_until: number;
  token_hash: string | null;
  artifact_sha256: string | null;
  artifact_key: string | null;
  error_code: string | null;
  /** What the failed step printed: its cause and last lines, redacted. */
  error_detail?: BuildDiagnostic | null;
  render_report?: RenderReport;
  seo_report?: SeoReport;
}
const pathPart = (value: string) => { if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) throw new ConnectionError('Invalid build identifier', 400); return value; };
export const buildTasksPath = (org: string) => `organizations/${pathPart(org)}/build_tasks`;
export const buildTaskKey = (identity: BuildIdentity) => sha256(`${identity.site_id}\0${identity.version_id}\0${identity.job_id}\0${identity.commit}`);
export function equalToken(token: string, expected: string | null) {
  return typeof token === 'string' && token.length <= 512 && expected !== null && /^[a-f0-9]{64}$/.test(expected) && timingSafeEqual(Buffer.from(sha256(token), 'hex'), Buffer.from(expected, 'hex'));
}
/**
 * The longest a step may wait in the queue before a runner claims it. Waiting
 * for the provider to start a runner is normal (the provider limits concurrent
 * builds per account), so queue time does not count against the step's
 * working time. This cap only keeps a lost provider build from holding a
 * publication forever.
 */
export const QUEUED_BUILD_LIMIT_MS = 6 * 60 * 60_000;
const queuedSince = (task: Pick<BuildTask, 'queued_at' | 'created_at'>) => task.queued_at ?? task.created_at;
/** When a queued step reaches the queue cap. */
export const queuedBuildExpiresAt = (task: Pick<BuildTask, 'queued_at' | 'created_at'>) => queuedSince(task) + QUEUED_BUILD_LIMIT_MS;
export function queuedBuildExpired(task: BuildTask, now = Date.now()): boolean {
  return task.status === 'queued' && Number.isFinite(queuedSince(task)) && now >= queuedBuildExpiresAt(task);
}
/**
 * The step's working deadline. A queued step keeps the working time it had
 * left when it was queued: claiming it now would move the stored deadline by
 * the time it waited. A running step uses the deadline it was claimed with.
 */
export function buildDeadline(task: Pick<BuildTask, 'status' | 'deadline' | 'queued_at' | 'created_at'>, now = Date.now()): number {
  if (task.status !== 'queued') return task.deadline;
  const since = queuedSince(task);
  return Number.isFinite(since) ? task.deadline + Math.max(0, now - since) : task.deadline;
}
/** Revoke an unclaimed task, never start a replacement or interrupt a live lease. */
export async function expireQueuedBuild(store: ReadWriteStore, org: string, key: string, now = Date.now()) {
  await store.compareAndUpdateDoc<BuildTask>(`${buildTasksPath(org)}/${pathPart(key)}`, task => queuedBuildExpired(task, now),
    { status: 'failed', token_hash: null, lease_id: null, lease_until: 0, error_code: 'build_queue_timeout', completed_at: now });
}
const LEASE_MS = 90_000;
export const MAX_ATTEMPTS = 3;
export const MEDIA_BUILD_DEADLINE_MS = 6 * 60 * 60_000;
export const buildAttemptLimit = (task: BuildTask) => MAX_ATTEMPTS + (task.media_checkpoint_attempt ?? task.media_batches ?? 0);
const rejected = () => new ConnectionError('This build attempt has expired or was cancelled.', 409, 'build_lease_lost');

/** Organization-scoped queue, backed by the existing transactional datastore. */
export class OrganizationBuildQueue {
  constructor(private store: ReadWriteStore = getStore(), private clock = Date.now) {}
  async enqueue(identity: BuildIdentity, engineRevision: string, mediaTotal = 0, purpose?: 'static_verification' | 'media_preparation') {
    if (!Number.isSafeInteger(mediaTotal) || mediaTotal < 0 || mediaTotal > (purpose === 'static_verification' ? 40000 : 20000)) throw new ConnectionError('Invalid media preparation size.', 400);
    assertBuildIdentity(identity);
    const key = purpose === 'static_verification' ? sha256(`${buildTaskKey(identity)}\0verification\0${identity.source_sha256}`) : buildTaskKey(identity), path = `${buildTasksPath(identity.org_id)}/${key}`;
    const task: BuildTask = { identity, engine_revision: engineRevision, status: 'queued', created_at: this.clock(), queued_at: this.clock(), deadline: this.clock() + (mediaTotal ? MEDIA_BUILD_DEADLINE_MS : 45 * 60_000),
      media_total: mediaTotal, media_cursor: 0, media_batches: 0, ...(purpose === 'media_preparation' ? { background: true } : {}),
      attempt: 0, lease_id: null, lease_until: 0, token_hash: null, artifact_sha256: null, artifact_key: null, error_code: null };
    await this.store.createDocIfMissing(path, task);
    const existing = await this.store.getDoc<BuildTask>(path);
    if (!existing || Object.keys(identity).some(key => existing.identity[key as keyof BuildIdentity] !== identity[key as keyof BuildIdentity])) throw new ConnectionError('The frozen build identity changed.', 409);
    return { key, task: existing };
  }
  /** Run a failed or cancelled task again, unchanged, on another engine revision (after an engine update). */
  async requeue(org: string, key: string, engineRevision: string) {
    const path = `${buildTasksPath(org)}/${pathPart(key)}`;
    const existing = await this.store.getDoc<BuildTask>(path);
    if (!existing || !['failed', 'cancelled'].includes(existing.status)) return existing;
    const now = this.clock();
    await this.store.compareAndUpdateDoc<BuildTask>(path, value => value.status === existing.status && value.engine_revision === existing.engine_revision && value.attempt === existing.attempt, {
      engine_revision: engineRevision, status: 'queued', queued_at: now, deadline: now + (existing.media_total ? MEDIA_BUILD_DEADLINE_MS : 45 * 60_000),
      media_cursor: 0, media_batches: 0, attempt: 0, lease_id: null, lease_until: 0, token_hash: null, artifact_sha256: null, artifact_key: null, error_code: null, error_detail: null });
    return this.store.getDoc<BuildTask>(path);
  }
  async claim(org: string, engineRevision: string, protocol: number, expected?: { key: string; dispatch_id: string }) {
    if (protocol !== BUILD_PROTOCOL) throw new ConnectionError('Update the build engine before claiming work.', 409, 'build_protocol_unsupported');
    // One equality filter avoids requiring a provider-specific composite index.
    const exact = expected ? await this.store.getDoc<BuildTask>(`${buildTasksPath(org)}/${pathPart(expected.key)}`) : null;
    const pending = expected ? (exact ? [{ ...exact, id: expected.key }] : []) : await this.store.listDocs<BuildTask>(buildTasksPath(org), { filters: [{ field: 'status', op: 'in', value: ['queued', 'running'] }], limit: 100 });
    // Shared Cloudflare runners claim organization work. Background preparation
    // must not keep reclaiming the slot ahead of a user-requested publication.
    // Read kinds only for eligible candidates; exact GitHub claims stay pinned.
    const priority = new Map<string, number>();
    if (!expected) await Promise.all(pending.filter(task => task.engine_revision === engineRevision && task.lease_until <= this.clock()).map(async task => {
      const input = await this.store.getDoc<{ kind: string }>(`organizations/${pathPart(org)}/build_inputs/${pathPart(task.id)}`);
      priority.set(task.id, input?.kind === 'media_preparation' ? 1 : 0);
    }));
    for (const task of pending.sort((a, b) => (priority.get(a.id) ?? 0) - (priority.get(b.id) ?? 0) || a.created_at - b.created_at)) {
      if (!['queued', 'running'].includes(task.status) || task.engine_revision !== engineRevision || task.lease_until > this.clock() || (expected && task.provider_dispatch_id === expected.dispatch_id)) continue;
      const path = `${buildTasksPath(org)}/${task.id}`;
      if (queuedBuildExpired(task, this.clock())) { await expireQueuedBuild(this.store, org, task.id, this.clock()); continue; }
      if (task.status === 'running' || buildDeadline(task, this.clock()) <= this.clock() || task.attempt >= buildAttemptLimit(task)) {
        await this.store.compareAndUpdateDoc<BuildTask>(path, current => ['queued', 'running'].includes(current.status) && current.lease_until <= this.clock(),
          { status: 'failed', token_hash: null, error_code: task.status === 'running' ? 'build_connection_lost' : 'build_timeout', completed_at: this.clock() });
        continue;
      }
      // The working time starts now: time spent waiting for a runner is added
      // to the stored deadline, so a long provider queue never eats build time.
      // Engines read only `deadline` from this response, so older ones work unchanged.
      const token = randomBytes(32).toString('base64url'), lease = randomUUID(), now = this.clock(), deadline = buildDeadline(task, now);
      const won = await this.store.compareAndUpdateDoc<BuildTask>(path, current => current.engine_revision === engineRevision &&
        current.status === 'queued' && !queuedBuildExpired(current, now) && current.lease_until <= now && current.deadline === task.deadline && queuedSince(current) === queuedSince(task) &&
        deadline > now && current.attempt === task.attempt && (!expected || current.provider_dispatch_id !== expected.dispatch_id),
        { status: 'running', lease_id: lease, token_hash: sha256(token), lease_until: now + LEASE_MS, attempt: task.attempt + 1, deadline, ...(expected ? { provider_dispatch_id: expected.dispatch_id } : {}) });
      if (won) return { key: task.id, identity: task.identity, lease_id: lease, token, expires_at: now + LEASE_MS, deadline, media_cursor: task.media_cursor ?? 0, media_total: task.media_total ?? 0 };
    }
    return null;
  }
  async authorize(org: string, key: string, lease: string, token: string) {
    const task = await this.store.getDoc<BuildTask>(`${buildTasksPath(org)}/${pathPart(key)}`);
    if (!task || task.status !== 'running' || task.identity.org_id !== org || task.lease_id !== lease ||
        task.lease_until <= this.clock() || task.deadline <= this.clock() || !equalToken(token, task.token_hash)) throw rejected();
    return task;
  }
  async heartbeat(org: string, key: string, lease: string, token: string) {
    const won = await this.store.compareAndUpdateDoc<BuildTask>(`${buildTasksPath(org)}/${pathPart(key)}`, current =>
      current.status === 'running' && current.identity.org_id === org && current.lease_id === lease &&
      current.deadline > this.clock() && current.lease_until > this.clock() && equalToken(token, current.token_hash),
      { lease_until: this.clock() + LEASE_MS });
    if (!won) throw rejected();
  }
  /** Continuations revoke the old lease and preserve the exact publication identity. */
  async checkpointMedia(org: string, key: string, lease: string, token: string, cursor: number, continueBuild = false, keepLease = false) {
    const task = await this.authorize(org, key, lease, token);
    if (!Number.isSafeInteger(cursor) || cursor <= (task.media_cursor ?? 0) || cursor > (task.media_total ?? 0) || cursor - (task.media_cursor ?? 0) > 100 || (continueBuild && cursor !== task.media_total && !keepLease))
      throw new ConnectionError('Invalid media preparation checkpoint.', 400);
    const retainLease = continueBuild || keepLease;
    const won = await this.store.compareAndUpdateDoc<BuildTask>(`${buildTasksPath(org)}/${pathPart(key)}`, current =>
      current.status === 'running' && current.identity.org_id === org && current.lease_id === lease && current.deadline > this.clock() &&
      current.lease_until > this.clock() && equalToken(token, current.token_hash) && current.media_cursor === task.media_cursor,
      { ...(retainLease ? { lease_until: this.clock() + LEASE_MS } : { status: 'queued' as const, queued_at: this.clock(), token_hash: null, lease_id: null, lease_until: 0 }),
        media_cursor: cursor, media_checkpoint_attempt: task.attempt - (retainLease ? 1 : 0), media_batches: (task.media_batches ?? 0) + (retainLease ? 0 : 1), error_code: null, error_detail: null });
    if (!won) throw rejected();
  }
  async complete(org: string, key: string, lease: string, token: string, artifact: { sha256: string; key: string; render_report?: RenderReport; seo_report?: SeoReport }) {
    if (!/^[a-f0-9]{64}$/.test(artifact.sha256) || artifact.key !== `builds/${pathPart(org)}/tasks/${pathPart(key)}/${lease}/artifact.json`) throw new ConnectionError('Invalid build artifact scope', 400);
    const won = await this.store.compareAndUpdateDoc<BuildTask>(`${buildTasksPath(org)}/${pathPart(key)}`, current =>
      current.status === 'running' && current.identity.org_id === org && current.lease_id === lease && current.deadline > this.clock() &&
      current.lease_until > this.clock() && equalToken(token, current.token_hash),
      { status: 'completed', completed_at: this.clock(), token_hash: null, lease_until: 0, artifact_sha256: artifact.sha256, artifact_key: artifact.key,
        ...(artifact.seo_report ? { seo_report: artifact.seo_report } : {}),
        ...(artifact.render_report ? { render_report: artifact.render_report } : {}) });
    if (!won) throw rejected();
  }
  async cancel(org: string, key: string) {
    return this.store.compareAndUpdateDoc<BuildTask>(`${buildTasksPath(org)}/${pathPart(key)}`, task => ['queued', 'running'].includes(task.status),
      { status: 'cancelled', token_hash: null, lease_until: 0 });
  }
}
