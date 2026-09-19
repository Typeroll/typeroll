import { createHash } from 'node:crypto';
import { paths, type EmailConnector, type SiteIntegrations } from '@typeroll/shared';
import { getStore } from '../datastore';
import { sendViaConnector } from './index';
import type { EmailMessage, SendResult } from './types';

export type DeliveryStatus = 'dispatching' | 'accepted' | 'delivered' | 'failed' | 'unknown' | 'bounced' | 'complained';
export interface MailScope { orgId: string; siteId: string; installationId: string }
export interface DeliveryReceipt extends MailScope {
  id: string; fingerprint: string; recipient_digest: string; provider: string;
  provider_id?: string; status: DeliveryStatus; attempts: number; created_at: string;
  updated_at: string; events: Array<{ id: string; type: string; at: string }>;
}
export class DeliveryError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const base = (scope: MailScope) => paths.site(scope.orgId, scope.siteId);
const receiptPath = (scope: MailScope, id: string) => `${base(scope)}/mail_deliveries/${id}`;
const suppressionPath = (scope: MailScope, digest: string) => `${base(scope)}/mail_suppressions/${digest}`;
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export function publicReceipt(receipt: DeliveryReceipt) {
  return { message_id: receipt.id, status: receipt.status,
    accepted: ['accepted', 'delivered', 'bounced', 'complained'].includes(receipt.status),
    delivered: receipt.status === 'delivered', attempts: receipt.attempts,
    created_at: receipt.created_at, updated_at: receipt.updated_at, events: receipt.events };
}

export async function readDelivery(scope: MailScope, id: string): Promise<DeliveryReceipt | null> {
  if (!/^[a-f0-9]{64}$/.test(id)) return null;
  const receipt = await getStore().getDoc<DeliveryReceipt>(receiptPath(scope, id));
  return receipt?.installationId === scope.installationId ? receipt : null;
}

/** One durable reservation, one sender. Uncertain sends are never reclaimed by a timer. */
export async function sendApplicationEmail(scope: MailScope,
  input: { idempotency_key: string; to: string; subject: string; text: string },
  dependencies: { send?: (connector: EmailConnector, message: EmailMessage) => Promise<SendResult>; sleep?: typeof pause } = {},
): Promise<DeliveryReceipt> {
  if (typeof input.idempotency_key !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(input.idempotency_key)) throw new DeliveryError('idempotency_key must contain 16–100 letters, digits, underscores or hyphens', 400);
  const store = getStore();
  const integrations = await store.getDoc<SiteIntegrations>(paths.integrations(scope.orgId, scope.siteId));
  if (!integrations?.email) throw new DeliveryError('Site email delivery is not configured', 409);
  const connector = integrations.email;
  const id = hash(JSON.stringify([scope.orgId, scope.siteId, scope.installationId, input.idempotency_key]));
  const path = receiptPath(scope, id);
  const fingerprint = hash(JSON.stringify([input.to.trim().toLowerCase(), input.subject, input.text]));
  const recipient = hash(`${scope.orgId}\0${scope.siteId}\0${input.to.trim().toLowerCase()}`);
  const now = new Date().toISOString();
  const receipt: DeliveryReceipt = { ...scope, id, fingerprint, recipient_digest: recipient, provider: connector.type,
    status: 'dispatching', attempts: 0, created_at: now, updated_at: now, events: [] };
  let reserved = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    const existing = await readDelivery(scope, id);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new DeliveryError('idempotency_key was already used for a different message', 409);
      return existing;
    }
    const suppression = await store.getDoc(suppressionPath(scope, recipient));
    if (suppression) throw new DeliveryError('This destination is suppressed after a bounce or complaint', 409);
    const quotaPath = `${base(scope)}/mail_quotas/${now.slice(0, 10)}`;
    const quota = await store.getDoc<{ total: number; installations: Record<string, number> }>(quotaPath);
    const installationKey = hash(scope.installationId);
    const total = quota?.total ?? 0;
    const count = quota?.installations?.[installationKey] ?? 0;
    if (total >= 500 || count >= 100) throw new DeliveryError('Daily transactional mail limit reached', 429);
    reserved = await store.compareAndReplaceDoc(path, null, receipt, [
      { path: quotaPath, expected: quota, replace: true, data: { total: total + 1, installations: { ...quota?.installations, [installationKey]: count + 1 } } },
      { path: `mail_delivery_routes/${id}`, expected: null, data: { ...scope, id } },
      { path: suppressionPath(scope, recipient), expected: null, data: {}, guardOnly: true },
    ]);
    if (reserved) break;
  }
  if (!reserved) throw new DeliveryError('Mail reservation is busy; retry with the same idempotency_key', 409);
  const send = dependencies.send ?? sendViaConnector;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await store.updateDoc(path, { attempts: attempt });
    let result: SendResult;
    try { result = await send(connector, { from: '', to: input.to, subject: input.subject, text: input.text, deliveryId: id }); }
    catch { result = { ok: false, failure: 'unknown' }; }
    if (!result.ok && result.failure === 'retryable_rejection' && attempt < 3) {
      await (dependencies.sleep ?? pause)(attempt * 250);
      continue;
    }
    const status: DeliveryStatus = result.ok ? 'accepted' : result.failure === 'rejected' || result.failure === 'retryable_rejection' ? 'failed' : 'unknown';
    // A signed provider event may win the race against this HTTP response.
    await store.compareAndUpdateDoc<DeliveryReceipt>(path, current => current.status === 'dispatching', {
      status, updated_at: new Date().toISOString(), ...(result.id ? { provider_id: result.id } : {}),
    });
    return (await readDelivery(scope, id))!;
  }
  throw new DeliveryError('Mail dispatch did not complete', 502);
}

/** Called only after the provider's event envelope has been authenticated. */
export async function applyDeliveryEvent(event: { id: string; deliveryId: string; providerId: string; provider: string;
  type: 'delivered' | 'bounced' | 'complained' | 'failed'; at: string; suppress?: boolean }): Promise<boolean> {
  const store = getStore();
  if (!/^[a-f0-9]{64}$/.test(event.deliveryId)) return false;
  const route = await store.getDoc<MailScope>(`mail_delivery_routes/${event.deliveryId}`);
  if (!route) return false;
  const path = receiptPath(route, event.deliveryId);
  const eventPath = `${path}/events/${hash(event.id)}`;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (await store.getDoc(eventPath)) return true;
    const current = await readDelivery(route, event.deliveryId);
    if (!current || current.provider !== event.provider || (current.provider_id && current.provider_id !== event.providerId)) return false;
    if (current.events.some(item => item.id === event.id)) return true;
    const rank: Record<DeliveryStatus, number> = { dispatching: 0, unknown: 0, accepted: 1, failed: 2, delivered: 3, bounced: 4, complained: 5 };
    const status = rank[event.type] > rank[current.status] ? event.type : current.status;
    const changed = await store.compareAndReplaceDoc(path, current, { ...current, status, provider_id: event.providerId,
      updated_at: new Date().toISOString(), events: [...current.events, { id: event.id, type: event.type, at: event.at }].slice(-40) },
    [{ path: eventPath, expected: null, data: { type: event.type, at: event.at } },
      ...(event.suppress ? [{ path: suppressionPath(route, current.recipient_digest), data: { reason: event.type, created_at: event.at } }] : [])]);
    if (changed) return true;
  }
  throw new DeliveryError('Mail event is busy; retry the same event', 503);
}
