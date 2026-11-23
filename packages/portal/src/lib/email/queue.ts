// Application email queues share Core's durable scheduler and sender. Apps
// retain their domain records; only an explicit start authorizes delivery.
import { createHash, randomUUID } from 'node:crypto';
import { paths } from '@typeroll/shared';
import type { ReadWriteStore } from '../datastore';
import type { DeliveryReceipt, MailScope } from './delivery';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const DAY = 86_400_000, LEASE = 300_000;
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
export class EmailQueueError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'queue_error', readonly retry_after?: number) { super(message); }
}
export interface QueueEntryInput {
  id: string; to: string; subject: string; text: string;
  /** Relative, manifest-declared POST route. No caller-supplied origin. */
  preparation?: { path: string; reference: string };
}
export interface QueueEntry extends QueueEntryInput {
  status: 'queued' | 'preparing' | 'sending' | 'accepted' | 'delivered' | 'failed' | 'delivery_unknown' | 'suppressed' | 'excluded' | 'bounced' | 'complained' | 'cancelled';
  message_id?: string; error?: string; acknowledged_status?: string;
  intent_enc?: string;
}
export interface ApplicationEmailQueue extends MailScope {
  id: string; request_id: string; fingerprint: string; group: string; daily_limit: number; interval_ms: number;
  status: 'draft' | 'active' | 'paused' | 'cancelled' | 'completed';
  entries: QueueEntry[]; created_at: number; next_at: number | null; wake_revision: string;
  lease_owner?: string | null; lease_until?: number;
  error?: string;
}
interface Group {
  daily_limit: number; interval_ms: number; day: string; count: number; next_at: number;
  lease_owner?: string | null; lease_until?: number;
}
interface Intent { to: string; subject: string; text: string; idempotency_key: string; delivery_group: string; substitutions: Record<string, string>;
  scope: MailScope; queue_id: string; entry_id: string }
export interface QueueDependencies {
  store: ReadWriteStore;
  now: () => number;
  seal: (value: string) => string;
  open: (value: string) => string;
  /** Recheck installation, scopes and organization access for every delivery. */
  authorize: (scope: MailScope) => Promise<void>;
  preflight: (scope: MailScope, recipient: string, group: string) => Promise<'ready' | 'suppressed' | 'quota' | { retry_after: number }>;
  prepare: (queue: ApplicationEmailQueue, entry: QueueEntry, deliveryId: string) => Promise<{ values: Record<string, string> } | { exclude: string } | { retry_after: number }>;
  acknowledge: (queue: ApplicationEmailQueue, entry: QueueEntry, receipt: DeliveryReceipt) => Promise<void>;
  unsubscribe: (scope: MailScope, group: string, recipient: string, key: string) => Promise<string>;
  send: (scope: MailScope, intent: Intent) => Promise<DeliveryReceipt>;
  receipt: (scope: MailScope, id: string) => Promise<DeliveryReceipt | null>;
}
export const emailQueuePath = (scope: MailScope, id: string) => `${paths.site(scope.orgId, scope.siteId)}/mail_queues/${id}`;
const groupPath = (scope: MailScope, group: string) => `${paths.site(scope.orgId, scope.siteId)}/mail_queue_groups/${hash(JSON.stringify([scope.installationId, group]))}`;
export const applicationDeliveryId = (scope: MailScope, key: string) => hash(JSON.stringify([scope.orgId, scope.siteId, scope.installationId, key]));
const deliveryKey = (q: ApplicationEmailQueue, entry: QueueEntry) => hash(JSON.stringify(['mail_queue', q.id, entry.id]));
const isPending = (entry: QueueEntry) => ['queued', 'preparing', 'sending'].includes(entry.status);
const needsAcknowledgement = (entry: QueueEntry) => !!entry.preparation && !!entry.message_id &&
  ['accepted', 'delivered', 'failed', 'bounced', 'complained'].includes(entry.status) && entry.acknowledged_status !== entry.status;
const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);
const tomorrow = (now: number) => Date.parse(utcDay(now)) + DAY;

export function publicEmailQueue(queue: ApplicationEmailQueue) {
  const { lease_owner: _owner, lease_until: _lease, ...safe } = queue;
  return { ...safe, entries: safe.entries.map(({ intent_enc: _intent, ...entry }) => entry) };
}
function copyEntry(value: unknown): QueueEntry {
  const item = value as QueueEntryInput | null;
  if (!item || !identifier(item.id) || typeof item.to !== 'string' || item.to.length > 254 || !/^[^\s@,;\r\n]+@[^\s@,;\r\n]+\.[^\s@,;\r\n]+$/.test(item.to) ||
      typeof item.subject !== 'string' || !item.subject.trim() || item.subject.length > 200 || /[\r\n]/.test(item.subject) ||
      typeof item.text !== 'string' || !item.text.trim() || item.text.length > 32_000) throw new EmailQueueError('Invalid queue recipient or reviewed message');
  if (item.preparation && (!/^\/[A-Za-z0-9_/-]{1,150}$/.test(item.preparation.path) || item.preparation.path.includes('..') || !identifier(item.preparation.reference)))
    throw new EmailQueueError('Invalid app preparation reference');
  const placeholders = (item.subject + item.text).match(/\{\{[^}]*\}\}/g) ?? [];
  if (placeholders.some(value => !['{{link}}', '{{expires}}', '{{unsubscribe_url}}'].includes(value))) throw new EmailQueueError('Only dispatch-time link, expires and unsubscribe_url placeholders may remain');
  if (!item.preparation && placeholders.some(value => value !== '{{unsubscribe_url}}')) throw new EmailQueueError('A private link requires an app preparation route');
  return { id: item.id, to: item.to.trim().toLowerCase(), subject: item.subject, text: item.text,
    ...(item.preparation ? { preparation: { ...item.preparation } } : {}), status: 'queued' };
}

export class ApplicationEmailQueues {
  constructor(private readonly deps: QueueDependencies) {}
  async read(scope: MailScope, id: string) {
    if (!identifier(id)) throw new EmailQueueError('Invalid queue');
    const q = await this.deps.store.getDoc<ApplicationEmailQueue>(emailQueuePath(scope, id));
    if (!q || q.installationId !== scope.installationId || q.orgId !== scope.orgId || q.siteId !== scope.siteId) throw new EmailQueueError('Queue not found', 404);
    return q;
  }
  async create(scope: MailScope, input: { id: string; group: string; daily_limit?: number; interval_minutes?: number; entries: unknown[] }) {
    if (!identifier(input.id) || input.id.length < 16 || !identifier(input.group) || !Array.isArray(input.entries) || !input.entries.length || input.entries.length > 1000)
      throw new EmailQueueError('Use a stable queue id, delivery group and 1–1000 reviewed recipients');
    const daily = input.daily_limit ?? 10, minutes = input.interval_minutes ?? 15;
    if (!Number.isInteger(daily) || daily < 1 || daily > 10000 || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new EmailQueueError('Invalid queue sending limits');
    const entries = input.entries.map(copyEntry);
    if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new EmailQueueError('Queue recipient ids must be unique');
    if (Buffer.byteLength(JSON.stringify(entries)) > 800_000) throw new EmailQueueError('Reviewed messages are too large; split the campaign');
    await this.deps.authorize(scope);
    const fingerprint = hash(JSON.stringify({ group: input.group, daily, minutes, entries }));
    const id = hash(JSON.stringify([scope.installationId, input.id]));
    const candidate: ApplicationEmailQueue = { ...scope, id, request_id: input.id, group: input.group, daily_limit: daily, interval_ms: minutes * 60_000,
      fingerprint, entries, created_at: this.deps.now(), status: 'draft', next_at: null, wake_revision: randomUUID() };
    const path = emailQueuePath(scope, id);
    if (!await this.deps.store.compareAndReplaceDoc(path, null, candidate)) {
      const existing = await this.read(scope, id);
      if (existing.fingerprint !== fingerprint) throw new EmailQueueError('Queue id already identifies different reviewed messages', 409);
      return existing;
    }
    return candidate;
  }
  async control(scope: MailScope, id: string, action: 'start' | 'pause' | 'resume' | 'cancel', fingerprint: string) {
    await this.deps.authorize(scope);
    for (let tries = 0; tries < 8; tries++) {
      const q = await this.read(scope, id);
      if (q.fingerprint !== fingerprint) throw new EmailQueueError('Review the current queue before changing delivery', 409);
      if (!['start', 'pause', 'resume', 'cancel'].includes(action)) throw new EmailQueueError('Invalid queue action');
      if (action === 'start' && !['draft', 'active'].includes(q.status) || action === 'resume' && !['paused', 'active'].includes(q.status))
        throw new EmailQueueError('This queue cannot be started or resumed', 409);
      if (action === 'pause' && !['active', 'paused'].includes(q.status)) throw new EmailQueueError('Only an active queue can be paused', 409);
      if (q.status === 'completed' || q.status === 'cancelled') return q;
      const status = action === 'pause' ? 'paused' : action === 'cancel' ? 'cancelled' : 'active';
      const saved = { ...q, status, ...(status === 'active' ? { error: undefined } : {}), wake_revision: randomUUID(), next_at: status === 'active' || q.entries.some(entry => needsAcknowledgement(entry) || entry.status === 'sending') ? this.deps.now() : null,
        entries: action === 'cancel' ? q.entries.map(entry => ['queued', 'preparing'].includes(entry.status) ? { ...entry, status: 'cancelled' as const } : entry) : q.entries } satisfies ApplicationEmailQueue;
      if (await this.deps.store.compareAndReplaceDoc(emailQueuePath(scope, id), q, saved)) return saved;
    }
    throw new EmailQueueError('Queue changed; refresh before retrying', 409);
  }
  async cancelEntry(scope: MailScope, id: string, entryId: string, fingerprint: string) {
    await this.deps.authorize(scope);
    const q = await this.read(scope, id);
    if (q.fingerprint !== fingerprint || !q.entries.some(entry => entry.id === entryId)) throw new EmailQueueError('Review the current queue recipient first', 409);
    await this.updateEntry(scope, id, entryId, entry => ['queued', 'preparing'].includes(entry.status) ? { ...entry, status: 'cancelled' } : entry);
    await this.wake(scope, id, this.deps.now());
    return this.read(scope, id);
  }
  /** Reconcile receipts only. A missing or unknown receipt never authorizes another POST. */
  async reconcile(scope: MailScope, id: string) {
    await this.deps.authorize(scope);
    const q = await this.read(scope, id);
    for (const entry of q.entries.filter(entry => ['sending', 'delivery_unknown', 'accepted', 'delivered', 'bounced', 'complained'].includes(entry.status))) {
      const receipt = await this.deps.receipt(scope, applicationDeliveryId(scope, deliveryKey(q, entry)));
      if (receipt) await this.settle(scope, id, entry.id, receipt);
    }
    await this.wake(scope, id, this.deps.now());
    return this.read(scope, id);
  }
  private async settle(scope: MailScope, id: string, entryId: string, receipt: DeliveryReceipt) {
    for (let tries = 0; tries < 8; tries++) {
      const q = await this.read(scope, id), index = q.entries.findIndex(entry => entry.id === entryId), entry = q.entries[index];
      if (!entry) return;
      const status: QueueEntry['status'] = receipt.status === 'dispatching' || receipt.status === 'unknown' ? 'delivery_unknown' : receipt.status;
      const savedEntry: QueueEntry = { ...entry, status, message_id: receipt.id };
      if (status !== 'delivery_unknown') delete savedEntry.intent_enc;
      const entries = [...q.entries]; entries[index] = savedEntry;
      if (!await this.deps.store.compareAndReplaceDoc(emailQueuePath(scope, id), q, { ...q, entries })) continue;
      if (receipt.status !== 'dispatching' && receipt.status !== 'unknown' && entry.acknowledged_status !== status) {
        try {
          await this.deps.acknowledge(q, savedEntry, receipt);
          for (let j = 0; j < 8; j++) {
            const latest = await this.read(scope, id), current = latest.entries[index];
            if (!current || current.message_id !== receipt.id || current.status !== status) break;
            const next = [...latest.entries]; next[index] = { ...current, acknowledged_status: status };
            if (await this.deps.store.compareAndReplaceDoc(emailQueuePath(scope, id), latest, { ...latest, entries: next })) break;
          }
        } catch { /* A durable receipt remains available for explicit reconciliation. */ }
      }
      return;
    }
    throw new EmailQueueError('Receipt changed; reconcile again', 409);
  }
  /** One bounded dispatch. Scheduler leases and the group CAS fence concurrent queues. */
  async run(scope: MailScope, id: string): Promise<void> {
    await this.deps.authorize(scope);
    let q = await this.read(scope, id);
    const interrupted = q.entries.find(entry => entry.status === 'sending');
    if (interrupted) {
      const receipt = await this.deps.receipt(scope, applicationDeliveryId(scope, deliveryKey(q, interrupted)));
      if (receipt) await this.settle(scope, id, interrupted.id, receipt);
      else await this.updateEntry(scope, id, interrupted.id, entry => entry.status === 'sending' ? { ...entry, status: 'delivery_unknown' } : entry);
      await this.wake(scope, id, this.deps.now()); return;
    }
    const pendingAcknowledgement = q.entries.find(needsAcknowledgement);
    if (pendingAcknowledgement) {
      const receipt = await this.deps.receipt(scope, pendingAcknowledgement.message_id!);
      if (receipt) await this.settle(scope, id, pendingAcknowledgement.id, receipt);
      await this.wake(scope, id, this.deps.now() + 60_000); return;
    }
    if (q.status !== 'active') return;
    const now = this.deps.now(), owner = randomUUID(), gp = groupPath(scope, q.group);
    for (let tries = 0; tries < 8; tries++) {
      const group = await this.deps.store.getDoc<Group>(gp);
      if ((group?.lease_until ?? 0) > now) throw new EmailQueueError('Delivery group is already running', 409);
      const next: Group = { daily_limit: q.daily_limit, interval_ms: q.interval_ms, day: group?.day ?? utcDay(now), count: group?.count ?? 0,
        next_at: group?.next_at ?? now, lease_owner: owner, lease_until: now + LEASE };
      if (await this.deps.store.compareAndReplaceDoc(gp, group, next)) break;
      if (tries === 7) throw new EmailQueueError('Delivery group is busy', 409);
    }
    try {
      q = await this.read(scope, id);
      if (q.status !== 'active') return;
      const group = (await this.deps.store.getDoc<Group>(gp))!;
      const waitUntil = Math.max(group.next_at, group.day === utcDay(now) && group.count >= group.daily_limit ? tomorrow(now) : now);
      if (waitUntil > now) { await this.wake(scope, id, waitUntil); return; }
      const entry = q.entries.find(isPending);
      if (!entry) { await this.wake(scope, id, null); return; }
      const preflight = await this.deps.preflight(scope, entry.to, q.group);
      if (typeof preflight === 'object') { await this.wake(scope, id, now + Math.max(1, preflight.retry_after) * 1000); return; }
      if (preflight === 'quota') { await this.wake(scope, id, tomorrow(now)); return; }
      if (preflight === 'suppressed') { await this.updateEntry(scope, id, entry.id, current => ({ ...current, status: 'suppressed' })); await this.wake(scope, id, now); return; }
      const key = deliveryKey(q, entry), deliveryId = applicationDeliveryId(scope, key);
      if (!await this.updateEntry(scope, id, entry.id, current => ['queued', 'preparing'].includes(current.status) ? { ...current, status: 'preparing' } : current, owner)) return;
      const prepared = entry.preparation ? await this.deps.prepare(q, entry, deliveryId) : { values: {} };
      if ('retry_after' in prepared) { await this.wake(scope, id, this.deps.now() + Math.max(1000, Math.min(DAY, prepared.retry_after * 1000))); return; }
      if ('exclude' in prepared) {
        if (await this.updateEntry(scope, id, entry.id, current => ({ ...current, status: 'excluded', error: prepared.exclude.slice(0, 300) }), owner)) await this.wake(scope, id, now);
        return;
      }
      const interpolate = (text: string, values: Record<string, string>) => text.replace(/\{\{(link|expires|unsubscribe_url)\}\}/g, (_, name: string) => {
        const value = values[name]; if (typeof value !== 'string' || !value || value.length > 4096) throw new EmailQueueError('App did not prepare the reviewed placeholder', 409); return value;
      });
      let intent: Intent;
      if (entry.intent_enc) {
        intent = JSON.parse(this.deps.open(entry.intent_enc));
        if (intent.queue_id !== q.id || intent.entry_id !== entry.id || intent.scope?.orgId !== scope.orgId || intent.scope.siteId !== scope.siteId || intent.scope.installationId !== scope.installationId ||
            intent.to !== entry.to || intent.idempotency_key !== key || intent.delivery_group !== q.group) throw new EmailQueueError('Protected email intent belongs to a different delivery', 409);
        // Revalidate the app's private grant after a pause or a quota delay,
        // but never replace the already frozen message or generate a new link.
        const values = { ...prepared.values, unsubscribe_url: intent.substitutions.unsubscribe_url! };
        if (interpolate(entry.subject, values) !== intent.subject || interpolate(entry.text, values) !== intent.text) {
          if (await this.updateEntry(scope, id, entry.id, current => ({ ...current, status: 'excluded', error: 'Prepared private values changed; review this delivery instead of replacing its message.' }), owner)) await this.wake(scope, id, now);
          return;
        }
      }
      else {
        const unsubscribe = await this.deps.unsubscribe(scope, q.group, entry.to, key);
        const values: Record<string, string> = { ...prepared.values, unsubscribe_url: unsubscribe };
        intent = { to: entry.to, subject: interpolate(entry.subject, values), text: interpolate(entry.text, values), idempotency_key: key, delivery_group: q.group, substitutions: values, scope, queue_id: q.id, entry_id: entry.id };
        if (/[\r\n]/.test(intent.subject) || intent.subject.length > 200 || intent.text.length > 32_000) throw new EmailQueueError('Prepared email exceeds the reviewed message limits', 409);
        const sealed = this.deps.seal(JSON.stringify(intent));
        if (!await this.updateEntry(scope, id, entry.id, current => ({ ...current, intent_enc: sealed }), owner)) return;
      }
      await this.deps.authorize(scope);
      q = await this.read(scope, id);
      const currentGroup = await this.deps.store.getDoc<Group>(gp);
      if (q.status !== 'active' || currentGroup?.lease_owner !== owner || (currentGroup.lease_until ?? 0) <= this.deps.now()) return;
      const finalCheck = await this.deps.preflight(scope, entry.to, q.group);
      if (finalCheck === 'suppressed') { await this.updateEntry(scope, id, entry.id, current => ({ ...current, status: 'suppressed' }), owner); await this.wake(scope, id, now); return; }
      if (finalCheck !== 'ready') { await this.wake(scope, id, typeof finalCheck === 'object' ? this.deps.now() + finalCheck.retry_after * 1000 : tomorrow(now)); return; }
      const index = q.entries.findIndex(item => item.id === entry.id), entries = [...q.entries];
      if (!['queued', 'preparing'].includes(entries[index]?.status ?? '')) { await this.wake(scope, id, now); return; }
      const dispatchAt = this.deps.now();
      if ((currentGroup.lease_until ?? 0) <= dispatchAt) return;
      entries[index] = { ...entries[index]!, status: 'sending' };
      const reserved = { ...currentGroup, day: utcDay(dispatchAt), count: (currentGroup.day === utcDay(dispatchAt) ? currentGroup.count : 0) + 1, next_at: dispatchAt + q.interval_ms };
      if (!await this.deps.store.compareAndReplaceDoc(emailQueuePath(scope, id), q, { ...q, entries }, [{ path: gp, expected: currentGroup, replace: true, data: reserved }])) throw new EmailQueueError('Queue changed before dispatch', 409);
      try { await this.settle(scope, id, entry.id, await this.deps.send(scope, intent)); }
      catch (error) {
        if (error instanceof EmailQueueError && error.code === 'account_unavailable') {
          await this.updateEntry(scope, id, entry.id, current => current.status === 'sending' ? { ...current, status: 'queued', error: error.message } : current);
          await this.pauseForConfiguration(scope, id, error.message); return;
        }
        if (error instanceof EmailQueueError && ['quota', 'suppressed', 'pacing'].includes(error.code)) {
          await this.updateEntry(scope, id, entry.id, current => current.status === 'sending' ? { ...current, status: error.code === 'suppressed' ? 'suppressed' : 'queued', error: error.message } : current);
          await this.wake(scope, id, error.code === 'quota' ? tomorrow(now) : error.code === 'pacing' ? this.deps.now() + (error.retry_after ?? 60) * 1000 : reserved.next_at); return;
        }
        await this.updateEntry(scope, id, entry.id, current => current.status === 'sending' ? { ...current, status: 'delivery_unknown', error: 'Delivery could not be confirmed. Reconcile this receipt; do not create a replacement message.' } : current);
      }
      await this.wake(scope, id, reserved.next_at);
    } finally {
      await this.deps.store.compareAndUpdateDoc<Group>(gp, group => group.lease_owner === owner, { lease_owner: null, lease_until: 0 });
    }
  }
  async pauseForConfiguration(scope: MailScope, id: string, message: string) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const q = await this.read(scope, id);
      if (await this.deps.store.compareAndReplaceDoc(emailQueuePath(scope, id), q, { ...q, status: q.status === 'active' ? 'paused' : q.status,
        next_at: null, error: message.slice(0, 300), wake_revision: randomUUID() })) return;
    }
    throw new EmailQueueError('Queue changed while pausing', 409);
  }
  private async updateEntry(scope: MailScope, id: string, entryId: string, transform: (entry: QueueEntry) => QueueEntry, owner?: string): Promise<boolean> {
    for (let tries = 0; tries < 8; tries++) {
      const q = await this.read(scope, id), index = q.entries.findIndex(entry => entry.id === entryId);
      if (index < 0) throw new EmailQueueError('Queue recipient not found', 404);
      const gp = groupPath(scope, q.group), group = owner ? await this.deps.store.getDoc<Group>(gp) : null;
      if (owner && (q.status !== 'active' || group?.lease_owner !== owner || (group.lease_until ?? 0) <= this.deps.now())) return false;
      const entries = [...q.entries]; entries[index] = transform(entries[index]!);
      if (await this.deps.store.compareAndReplaceDoc(emailQueuePath(scope, id), q, { ...q, entries }, owner ? [{ path: gp, expected: group, data: {}, guardOnly: true }] : [])) return true;
    }
    throw new EmailQueueError('Queue recipient changed', 409);
  }
  private async wake(scope: MailScope, id: string, due: number | null) {
    for (let tries = 0; tries < 8; tries++) {
      const q = await this.read(scope, id);
      const pending = q.status === 'active' && q.entries.some(isPending);
      const acknowledgements = q.entries.some(needsAcknowledgement);
      const saved: ApplicationEmailQueue = { ...q, status: q.status === 'active' && !pending ? 'completed' : q.status,
        next_at: pending ? due ?? this.deps.now() : acknowledgements ? this.deps.now() + 60_000 : null, wake_revision: randomUUID() };
      if (await this.deps.store.compareAndReplaceDoc(emailQueuePath(scope, id), q, saved)) return;
    }
    throw new EmailQueueError('Queue changed before scheduling', 409);
  }
}
