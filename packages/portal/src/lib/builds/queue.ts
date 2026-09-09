import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { getStore, type ReadWriteStore } from '../datastore';
import { BUILD_PROTOCOL, assertBuildIdentity, sha256, type BuildIdentity } from './contract.mjs';
import { ConnectionError } from '../publishing/connections';

export interface BuildTask {
  identity: BuildIdentity;
  engine_revision: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  created_at: number;
  deadline: number;
  attempt: number;
  lease_id: string | null;
  lease_until: number;
  token_hash: string | null;
  artifact_sha256: string | null;
  artifact_key: string | null;
  error_code: string | null;
}
const pathPart = (value: string) => { if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) throw new ConnectionError('Invalid build identifier', 400); return value; };
export const buildTasksPath = (org: string) => `organizations/${pathPart(org)}/build_tasks`;
export const buildTaskKey = (identity: BuildIdentity) => sha256(`${identity.site_id}\0${identity.version_id}\0${identity.job_id}\0${identity.commit}`);
export function equalToken(token: string, expected: string | null) {
  return typeof token === 'string' && token.length <= 512 && expected !== null && /^[a-f0-9]{64}$/.test(expected) && timingSafeEqual(Buffer.from(sha256(token), 'hex'), Buffer.from(expected, 'hex'));
}
const LEASE_MS = 90_000;
const MAX_ATTEMPTS = 3;
const rejected = () => new ConnectionError('This build attempt has expired or was cancelled.', 409, 'build_lease_lost');

/** Organization-scoped queue, backed by the existing transactional datastore. */
export class OrganizationBuildQueue {
  constructor(private store: ReadWriteStore = getStore(), private clock = Date.now) {}
  async enqueue(identity: BuildIdentity, engineRevision: string) {
    assertBuildIdentity(identity);
    const key = buildTaskKey(identity), path = `${buildTasksPath(identity.org_id)}/${key}`;
    const task: BuildTask = { identity, engine_revision: engineRevision, status: 'queued', created_at: this.clock(), deadline: this.clock() + 45 * 60_000,
      attempt: 0, lease_id: null, lease_until: 0, token_hash: null, artifact_sha256: null, artifact_key: null, error_code: null };
    await this.store.createDocIfMissing(path, task);
    const existing = await this.store.getDoc<BuildTask>(path);
    if (!existing || Object.keys(identity).some(key => existing.identity[key as keyof BuildIdentity] !== identity[key as keyof BuildIdentity])) throw new ConnectionError('The frozen build identity changed.', 409);
    return { key, task: existing };
  }
  async claim(org: string, engineRevision: string, protocol: number) {
    if (protocol !== BUILD_PROTOCOL) throw new ConnectionError('Update the build engine before claiming work.', 409, 'build_protocol_unsupported');
    // One equality filter avoids requiring a provider-specific composite index.
    const pending = await this.store.listDocs<BuildTask>(buildTasksPath(org), { filters: [{ field: 'status', op: 'in', value: ['queued', 'running'] }], limit: 100 });
    for (const task of pending.sort((a, b) => a.created_at - b.created_at)) {
      if (task.engine_revision !== engineRevision || task.lease_until > this.clock()) continue;
      const path = `${buildTasksPath(org)}/${task.id}`;
      if (task.deadline <= this.clock() || task.attempt >= MAX_ATTEMPTS) {
        await this.store.compareAndUpdateDoc<BuildTask>(path, current => ['queued', 'running'].includes(current.status) && current.lease_until <= this.clock(),
          { status: 'failed', token_hash: null, error_code: 'build_timeout' });
        continue;
      }
      const token = randomBytes(32).toString('base64url'), lease = randomUUID(), now = this.clock();
      const won = await this.store.compareAndUpdateDoc<BuildTask>(path, current => current.engine_revision === engineRevision &&
        ['queued', 'running'].includes(current.status) && current.lease_until <= now && current.deadline > now && current.attempt === task.attempt,
        { status: 'running', lease_id: lease, token_hash: sha256(token), lease_until: now + LEASE_MS, attempt: task.attempt + 1 });
      if (won) return { key: task.id, identity: task.identity, lease_id: lease, token, expires_at: now + LEASE_MS, deadline: task.deadline };
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
  async complete(org: string, key: string, lease: string, token: string, artifact: { sha256: string; key: string }) {
    if (!/^[a-f0-9]{64}$/.test(artifact.sha256) || artifact.key !== `builds/${pathPart(org)}/${pathPart(key)}/${lease}/artifact.json`) throw new ConnectionError('Invalid build artifact scope', 400);
    const won = await this.store.compareAndUpdateDoc<BuildTask>(`${buildTasksPath(org)}/${pathPart(key)}`, current =>
      current.status === 'running' && current.identity.org_id === org && current.lease_id === lease && current.deadline > this.clock() &&
      current.lease_until > this.clock() && equalToken(token, current.token_hash),
      { status: 'completed', token_hash: null, lease_until: 0, artifact_sha256: artifact.sha256, artifact_key: artifact.key });
    if (!won) throw rejected();
  }
  async cancel(org: string, key: string) {
    await this.store.compareAndUpdateDoc<BuildTask>(`${buildTasksPath(org)}/${pathPart(key)}`, task => ['queued', 'running'].includes(task.status),
      { status: 'cancelled', token_hash: null, lease_until: 0 });
  }
}
