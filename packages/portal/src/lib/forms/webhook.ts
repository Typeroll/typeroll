// Generic form webhooks: one signed POST per (submission, webhook) event.
//
// Delivery never holds the visitor's request for long. The submit request
// makes ONE short attempt (SYNC_TIMEOUT_MS) for at most a few webhooks per
// run (see `syncWebhooks` in ./actions); everything else is persisted as a
// `pending` delivery and retried in the background through the
// scheduled-work index (lib/scheduling, kind `form_webhook_retry`). Cloud
// Tasks, the in-process timer, the self-host worker loop or the periodic
// sweep (/api/internal/publish-sweep) delivers that entry to
// executeScheduledWork, which calls retryFormWebhookDelivery below.
//
// Each attempt is claimed on the delivery record with a compare-and-update
// lease, so a late, repeated or concurrent delivery of the same work entry
// never sends the same attempt twice. The event id (and Idempotency-Key)
// and the exact request body stay the same across attempts; every attempt
// signs with a fresh timestamp. The body is kept on the delivery record only
// while it is pending and removed once it is delivered or given up.

import crypto from 'node:crypto';
import { paths } from '@typeroll/shared';
import type { Form, FormAction, FormWebhookDelivery } from '@typeroll/shared';
import { getStore } from '../datastore';
import { decryptSecret } from '../secret-crypto';
import type { ActionContext } from './actions';
import { notifyScheduledWrites, workPath, type ScheduledWork } from '../scheduling/index';
import { OutboundRequestError, parseOutboundUrl, resolveOutboundAddresses, safeFetch, type OutboundPolicy } from '../net/safe-fetch';

/** Deadline of the one attempt made inside the visitor's request. */
export const SYNC_TIMEOUT_MS = 3_000;
/** Deadline of each background attempt. */
export const RETRY_TIMEOUT_MS = 8_000;
/** Delay after attempt n fails before attempt n + 1. Its length + 1 is the attempt limit. */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
/** How long one attempt owns a delivery; longer than any attempt can take. */
const ATTEMPT_LEASE_MS = 2 * 60_000;
/** A synchronous attempt is not started with less time than this left. */
const MIN_SYNC_MS = 1_000;

const DELIVERY_SOURCE_RE = /^organizations\/([^/]+)\/sites\/([^/]+)\/form_webhook_deliveries\/([^/]+)$/;

interface StoredWebhookConfig {
  url: string;
  fields: string[];
  secret_enc: string;
  webhook_id: string;
}

/** The delivery record with its retry bookkeeping. */
type StoredDelivery = Omit<FormWebhookDelivery, 'id' | 'response_status' | 'last_error'> & {
  response_status?: number | null;
  last_error?: string | null;
  /** When the next background attempt is due (ISO); null once settled. */
  next_attempt_at?: string | null;
  /** Exact request body, kept only while pending. */
  payload?: string | null;
  /** Attempt lease (epoch ms) and its owner. */
  lease_until?: number;
  lease_owner?: string | null;
};

type AttemptOutcome =
  | { kind: 'delivered'; status: number }
  | { kind: 'retry' | 'failed'; error: string; status?: number };

const WEBHOOK_POLICY: OutboundPolicy = { label: 'Webhook URL', timeoutMs: RETRY_TIMEOUT_MS, maxBytes: 64 * 1024 };

export function parseWebhookUrl(raw: string): URL {
  const url = parseOutboundUrl(raw, WEBHOOK_POLICY);
  if (url.hash) throw new Error('Webhook URL must not contain a fragment');
  return url;
}

function eventId(ctx: ActionContext, config: StoredWebhookConfig): string {
  const source = [ctx.orgId, ctx.siteId, ctx.formId, ctx.subject?.id, config.webhook_id].join(':');
  return `evt_${crypto.createHash('sha256').update(source).digest('hex').slice(0, 32)}`;
}

function message(error: unknown, fallback: string): string {
  return (error instanceof Error ? error.message : fallback).slice(0, 500);
}

function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), Math.max(0, ms));
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** One signed POST. Classifies the result; never throws. */
async function attemptDelivery(url: URL, secretEnc: string, id: string, payload: string, timeoutMs: number): Promise<AttemptOutcome> {
  const deadline = Date.now() + timeoutMs;
  let secret: string;
  try {
    secret = decryptSecret(secretEnc);
  } catch (error) {
    return { kind: 'failed', error: message(error, 'Webhook configuration failed') };
  }
  try {
    await withDeadline(resolveOutboundAddresses(url.hostname, WEBHOOK_POLICY), deadline - Date.now(), 'Webhook host lookup');
  } catch (error) {
    // A non-public destination is configuration; a lookup that failed or
    // timed out may succeed on the next attempt.
    if (error instanceof OutboundRequestError && error.code === 'blocked_destination') {
      return { kind: 'failed', error: 'Webhook URL resolved to a non-public address' };
    }
    return { kind: 'retry', error: message(error, 'Webhook host could not be resolved') };
  }
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  try {
    // The pinned transport re-checks the address the socket connects to.
    const response = await safeFetch(url, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Typeroll-Webhooks/1.0',
        'Idempotency-Key': id,
        'X-Typeroll-Event': 'form.submission.completed',
        'X-Typeroll-Event-Id': id,
        'X-Typeroll-Timestamp': timestamp,
        'X-Typeroll-Signature': `v1=${signature}`,
      },
      body: payload,
    }, { ...WEBHOOK_POLICY, timeoutMs: Math.max(1, deadline - Date.now()) });
    void response.body?.cancel().catch(() => {});
    if (response.ok) return { kind: 'delivered', status: response.status };
    const retryable = response.status >= 500 || response.status === 408 || response.status === 429;
    return { kind: retryable ? 'retry' : 'failed', error: `Webhook responded with HTTP ${response.status}`, status: response.status };
  } catch (error) {
    return { kind: 'retry', error: message(error, 'Webhook request failed') };
  }
}

/**
 * Save the outcome of the attempt `owner` leased. Returns when the next
 * attempt is due, or null when the delivery is settled (or was removed).
 */
async function recordOutcome(path: string, owner: string, attempts: number, outcome: AttemptOutcome, now: number): Promise<{ written: boolean; next: number | null }> {
  const at = new Date(now).toISOString();
  const release = { lease_until: 0, lease_owner: null };
  let patch: Partial<StoredDelivery>;
  let next: number | null = null;
  if (outcome.kind === 'delivered') {
    patch = { status: 'delivered', attempts, response_status: outcome.status, delivered_at: at, last_error: null, next_attempt_at: null, payload: null };
  } else if (outcome.kind === 'failed' || attempts >= MAX_ATTEMPTS) {
    patch = { status: 'failed', attempts, last_error: outcome.error, next_attempt_at: null, payload: null,
      ...(outcome.status !== undefined ? { response_status: outcome.status } : {}) };
  } else {
    next = now + RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length) - 1]!;
    patch = { status: 'pending', attempts, last_error: outcome.error, next_attempt_at: new Date(next).toISOString(),
      ...(outcome.status !== undefined ? { response_status: outcome.status } : {}) };
  }
  // A deleted submission removes its delivery record; never recreate it.
  const written = await getStore().compareAndUpdateDoc<StoredDelivery>(path,
    (saved) => saved.lease_owner === owner, { ...patch, ...release, updated_at: at });
  return { written: Boolean(written), next: written ? next : null };
}

/** Index the delivery's next background attempt. */
async function scheduleRetry(source: string, due: number): Promise<void> {
  const work: ScheduledWork = {
    kind: 'form_webhook_retry', source, due_at: due, payload: {},
    generation: crypto.randomUUID(), lease_until: 0, lease_owner: null,
  };
  const path = workPath(source, 'form_webhook_retry');
  await getStore().setDoc(path, work as unknown as Record<string, unknown>);
  await notifyScheduledWrites([{ path, data: work }]);
}

/**
 * Deliver one allowlisted, signed webhook and persist its operational status.
 *
 * Makes at most one short attempt now, or none when the run's synchronous
 * budget (`ctx.syncWebhooks`) is spent. A transient failure leaves the
 * delivery `pending` with a scheduled background retry and resolves; only a
 * permanent failure (configuration, non-retryable HTTP status) throws.
 */
export async function deliverFormWebhook(action: FormAction, ctx: ActionContext): Promise<void> {
  const config = action.config as unknown as StoredWebhookConfig;
  if (!ctx.formId || !ctx.subject?.id) throw new Error('Webhook action needs form and submission ids');
  const url = parseWebhookUrl(String(config.url ?? ''));
  const id = eventId(ctx, config);
  const store = getStore();
  const deliveryPath = `${paths.formWebhookDeliveries(ctx.orgId, ctx.siteId)}/${id}`;
  const now = Date.now();
  const owner = crypto.randomUUID();

  const budget = ctx.syncWebhooks;
  const timeoutMs = Math.min(SYNC_TIMEOUT_MS, budget ? budget.deadline - now : SYNC_TIMEOUT_MS);
  const attemptNow = !budget || (budget.remaining > 0 && timeoutMs >= MIN_SYNC_MS);
  if (attemptNow && budget) budget.remaining -= 1;

  const selected: Record<string, unknown> = {};
  for (const field of config.fields ?? []) {
    if (Object.prototype.hasOwnProperty.call(ctx.data, field)) selected[field] = ctx.data[field];
  }
  const body = (createdAt: string) => JSON.stringify({
    id,
    type: 'form.submission.completed',
    created_at: createdAt,
    site_id: ctx.siteId,
    form_id: ctx.formId,
    submission_id: ctx.subject!.id,
    data: selected,
  });
  const at = new Date(now).toISOString();
  const record: StoredDelivery = {
    event_id: id,
    form_id: ctx.formId,
    submission_id: ctx.subject.id,
    webhook_id: config.webhook_id,
    url: url.href,
    status: 'pending',
    attempts: 0,
    created_at: at,
    updated_at: at,
    next_attempt_at: attemptNow ? null : at,
    payload: body(at),
    lease_until: attemptNow ? now + ATTEMPT_LEASE_MS : 0,
    lease_owner: attemptNow ? owner : null,
  };

  let payload = record.payload!;
  if (!(await store.createDocIfMissing(deliveryPath, record))) {
    // The same event again (a repeated Extension `after` call). Delivered,
    // in progress or already scheduled: nothing to add. A failed delivery
    // starts a new cycle with the same event id and creation time.
    const previous = await store.getDoc<StoredDelivery>(deliveryPath);
    if (!previous || previous.status !== 'failed') return;
    payload = body(previous.created_at);
    const restarted = await store.compareAndUpdateDoc<StoredDelivery>(deliveryPath,
      (saved) => saved.status === 'failed' && saved.updated_at === previous.updated_at,
      { ...record, created_at: previous.created_at, payload, response_status: null, last_error: null });
    if (!restarted) return;
  }

  if (!attemptNow) {
    await scheduleRetry(deliveryPath, now);
    return;
  }

  const outcome = await attemptDelivery(url, String(config.secret_enc ?? ''), id, payload, timeoutMs);
  const { written, next } = await recordOutcome(deliveryPath, owner, 1, outcome, Date.now());
  if (outcome.kind === 'delivered') return;
  if (written && next !== null) {
    await scheduleRetry(deliveryPath, next);
    console.warn(`[form webhook] ${id} attempt 1 failed (${outcome.error}); retry scheduled`);
    return;
  }
  throw new Error(outcome.error);
}

/**
 * Background attempt for one pending delivery (scheduled-work kind
 * `form_webhook_retry`). Idempotent: the attempt is leased on the delivery
 * record first. Returns when the next attempt is due, or null when none
 * remains (delivered, given up, removed, or owned by another attempt).
 */
export async function retryFormWebhookDelivery(source: string, now = Date.now()): Promise<number | null> {
  const match = DELIVERY_SOURCE_RE.exec(source);
  if (!match) return null;
  const [, orgId, siteId] = match;
  const store = getStore();
  const delivery = await store.getDoc<StoredDelivery>(source);
  if (!delivery || delivery.status !== 'pending' || typeof delivery.payload !== 'string') return null;
  const due = Date.parse(delivery.next_attempt_at ?? '');
  if (Number.isFinite(due) && due > now) return due;

  const owner = crypto.randomUUID();
  const claimed = await store.compareAndUpdateDoc<StoredDelivery>(source,
    (saved) => saved.status === 'pending' && saved.attempts === delivery.attempts && (saved.lease_until ?? 0) <= now,
    { lease_until: now + ATTEMPT_LEASE_MS, lease_owner: owner });
  if (!claimed) return null;

  // The form's current configuration decides where and how to sign, so a
  // rotated secret or corrected URL applies to pending retries; a removed
  // webhook ends them.
  const form = await store.getDoc<Form>(`${paths.forms(orgId, siteId)}/${delivery.form_id}`);
  const action = (form?.actions ?? []).find((candidate) => candidate.type === 'webhook'
    && (candidate.config as Partial<StoredWebhookConfig> | undefined)?.webhook_id === delivery.webhook_id);
  let outcome: AttemptOutcome;
  if (!action) {
    outcome = { kind: 'failed', error: 'Webhook is no longer configured on this form' };
  } else {
    const config = action.config as unknown as StoredWebhookConfig;
    let url: URL | null = null;
    try { url = parseWebhookUrl(String(config.url ?? '')); }
    catch (error) { outcome = { kind: 'failed', error: message(error, 'Webhook URL is invalid') }; }
    if (url) {
      if (url.href !== delivery.url) await store.compareAndUpdateDoc<StoredDelivery>(source, (saved) => saved.lease_owner === owner, { url: url.href });
      outcome = await attemptDelivery(url, String(config.secret_enc ?? ''), delivery.event_id, delivery.payload, RETRY_TIMEOUT_MS);
    }
  }
  const { next } = await recordOutcome(source, owner, delivery.attempts + 1, outcome!, now);
  return next;
}
