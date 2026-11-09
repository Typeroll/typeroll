import { getStore } from '../datastore';
import { buildTasksPath, queuedBuildExpiresAt, type BuildTask } from './queue';
import { buildInputPath, type BuildInput } from './state';

/**
 * Why a queued build step has not started yet, in the organization's own
 * terms. Typeroll knows its own queue and the provider status of the step's
 * dispatch; it does not know who else uses the provider account, so nothing
 * here claims that.
 */
export interface BuildQueueState {
  /**
   * `waiting_for_other_builds`: other steps of this organization are claimed
   * first. `waiting_for_provider`: nothing is ahead in Typeroll's queue; the
   * provider has not started a runner for this step yet.
   */
  state: 'waiting_for_provider' | 'waiting_for_other_builds';
  queued_at: string;
  queued_for_seconds: number;
  provider: 'cloudflare' | 'github';
  /** The provider's status of this step's dispatch as last read (Cloudflare: queued, initializing, running, stopped; GitHub: queued, in_progress, completed), or null before the first read. */
  provider_status: string | null;
  provider_status_at: string | null;
  /** Steps of this organization that a runner claims before this one. */
  ahead: number;
  ahead_kinds: string[];
  /** Other steps of this organization that are running on the same build provider now. */
  running_kinds: string[];
  /** When the step fails with `build_queue_timeout` if no runner has claimed it by then. */
  expires_at: string;
  /** The same state in words, used as the deploy job's phase. */
  message: string;
}

interface QueueEntry { id: string; task: BuildTask; input: BuildInput | null }

const kindOf = (input: BuildInput | null) => input?.kind ?? 'build';
const providerOf = (input: BuildInput | null): 'cloudflare' | 'github' => input?.provider === 'github' ? 'github' : 'cloudflare';
/** The same order `OrganizationBuildQueue.claim` uses: interactive work first, then the oldest. */
const claimOrder = (entry: QueueEntry) => entry.input?.kind === 'media_preparation' ? 1 : 0;

function waited(seconds: number) {
  if (seconds < 60) return 'less than a minute';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
}

export function buildQueueMessage(queue: Omit<BuildQueueState, 'message'>, kind: string) {
  const name = queue.provider === 'github' ? 'GitHub Actions' : 'Cloudflare';
  const step = kind === 'static_verification' ? 'the verification build' : 'the build';
  const since = `queued ${waited(queue.queued_for_seconds)}`;
  if (queue.state === 'waiting_for_other_builds')
    return `waiting for ${queue.ahead} other build${queue.ahead === 1 ? '' : 's'} in this organization (${since})`;
  if (['initializing', 'running', 'in_progress'].includes(queue.provider_status ?? '')) return `${name} is starting ${step} (${since})`;
  const running = queue.running_kinds.length;
  const reason = queue.running_kinds.includes('media_preparation') ? 'this organization’s background media preparation is running on the same build account'
    : running ? `${running === 1 ? 'another build' : `${running} other builds`} in this organization ${running === 1 ? 'is' : 'are'} running on the same build account`
    : `${name} starts it when this account has build capacity`;
  return `waiting for ${name} to start ${step} (${since}; ${reason})`;
}

/** Describe a queued step against the organization's other queued and running steps. */
export function describeBuildQueue(entry: QueueEntry, others: QueueEntry[], now = Date.now()): BuildQueueState | null {
  const { task, input } = entry;
  if (task.status !== 'queued') return null;
  const provider = providerOf(input), queuedAt = task.queued_at ?? task.created_at;
  if (!Number.isFinite(queuedAt)) return null;
  const peers = others.filter(other => other.id !== entry.id && providerOf(other.input) === provider);
  // Shared Cloudflare runners claim the organization's oldest eligible step.
  // A GitHub run claims only the step it was started for, so nothing is ahead.
  const ahead = provider === 'cloudflare' ? peers.filter(other => other.task.status === 'queued' && other.task.engine_revision === task.engine_revision &&
    (claimOrder(other) - claimOrder(entry) || other.task.created_at - task.created_at) < 0) : [];
  const running = peers.filter(other => other.task.status === 'running' && other.task.lease_until > now);
  const state: Omit<BuildQueueState, 'message'> = {
    state: ahead.length ? 'waiting_for_other_builds' : 'waiting_for_provider',
    queued_at: new Date(queuedAt).toISOString(), queued_for_seconds: Math.max(0, Math.floor((now - queuedAt) / 1000)),
    provider, provider_status: input?.provider_status ?? null,
    provider_status_at: input?.provider_status_at ? new Date(input.provider_status_at).toISOString() : null,
    ahead: ahead.length, ahead_kinds: [...new Set(ahead.map(other => kindOf(other.input)))],
    running_kinds: [...new Set(running.map(other => kindOf(other.input)))],
    expires_at: new Date(queuedBuildExpiresAt(task)).toISOString(),
  };
  return { ...state, message: buildQueueMessage(state, kindOf(input)) };
}

/** The organization's queued and running steps with their inputs. */
export async function readQueueEntries(org: string): Promise<QueueEntry[]> {
  const store = getStore();
  const tasks = await store.listDocs<BuildTask>(buildTasksPath(org), { filters: [{ field: 'status', op: 'in', value: ['queued', 'running'] }], limit: 100 });
  return Promise.all(tasks.map(async ({ id, ...task }) => ({ id, task: task as BuildTask, input: await store.getDoc<BuildInput>(buildInputPath(org, id)) })));
}

/** The queue state of one step, or null when it is not queued. */
export async function readBuildQueue(org: string, key: string, now = Date.now()): Promise<BuildQueueState | null> {
  const store = getStore(), task = await store.getDoc<BuildTask>(`${buildTasksPath(org)}/${key}`);
  if (task?.status !== 'queued') return null;
  const entries = await readQueueEntries(org);
  return describeBuildQueue({ id: key, task, input: await store.getDoc<BuildInput>(buildInputPath(org, key)) }, entries, now);
}

/**
 * Record the provider's status of the current dispatch for queue reporting.
 * Written only when it changes, and only while the dispatch is unchanged.
 */
export async function recordProviderStatus(org: string, key: string, input: BuildInput, status: unknown, now = Date.now()) {
  const value = typeof status === 'string' && /^[a-z_]{1,40}$/.test(status) ? status : null;
  if (!value || input.provider_status === value) return;
  await getStore().compareAndUpdateDoc<BuildInput>(buildInputPath(org, key), current => current.dispatch_id === input.dispatch_id && current.provider_status !== value,
    { provider_status: value, provider_status_at: now });
}
