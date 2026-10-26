import crypto from 'node:crypto';
import { paths } from '@typeroll/shared';
import type { FormAction, FormWebhookDelivery } from '@typeroll/shared';
import { getStore } from '../datastore';
import { decryptSecret } from '../secret-crypto';
import type { ActionContext } from './actions';
import { parseOutboundUrl, resolveOutboundAddresses, safeFetch, type OutboundPolicy } from '../net/safe-fetch';

const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 8_000;

interface StoredWebhookConfig {
  url: string;
  fields: string[];
  secret_enc: string;
  webhook_id: string;
}

const WEBHOOK_POLICY: OutboundPolicy = { label: 'Webhook URL', timeoutMs: TIMEOUT_MS, maxBytes: 64 * 1024 };

export function parseWebhookUrl(raw: string): URL {
  const url = parseOutboundUrl(raw, WEBHOOK_POLICY);
  if (url.hash) throw new Error('Webhook URL must not contain a fragment');
  return url;
}

async function assertPublicDestination(url: URL): Promise<void> {
  try {
    await resolveOutboundAddresses(url.hostname, WEBHOOK_POLICY);
  } catch {
    throw new Error('Webhook URL resolved to a non-public address');
  }
}

function eventId(ctx: ActionContext, config: StoredWebhookConfig): string {
  const source = [ctx.orgId, ctx.siteId, ctx.formId, ctx.subject?.id, config.webhook_id].join(':');
  return `evt_${crypto.createHash('sha256').update(source).digest('hex').slice(0, 32)}`;
}

/** Deliver one allowlisted, signed webhook and persist its operational status. */
export async function deliverFormWebhook(action: FormAction, ctx: ActionContext): Promise<void> {
  const config = action.config as unknown as StoredWebhookConfig;
  if (!ctx.formId || !ctx.subject?.id) throw new Error('Webhook action needs form and submission ids');
  const url = parseWebhookUrl(String(config.url ?? ''));
  const id = eventId(ctx, config);
  const store = getStore();
  const deliveryPath = `${paths.formWebhookDeliveries(ctx.orgId, ctx.siteId)}/${id}`;
  const previous = await store.getDoc<FormWebhookDelivery>(deliveryPath);
  if (previous?.status === 'delivered') return;

  const createdAt = previous?.created_at ?? new Date().toISOString();
  const base: Omit<FormWebhookDelivery, 'id'> = {
    event_id: id,
    form_id: ctx.formId,
    submission_id: ctx.subject.id,
    webhook_id: config.webhook_id,
    url: url.href,
    status: 'pending',
    attempts: previous?.attempts ?? 0,
    created_at: createdAt,
    updated_at: new Date().toISOString(),
  };
  await store.setDoc(deliveryPath, base);

  let secret: string;
  try {
    await assertPublicDestination(url);
    secret = decryptSecret(String(config.secret_enc ?? ''));
  } catch (error) {
    const lastError = error instanceof Error ? error.message : 'Webhook configuration failed';
    await store.setDoc(deliveryPath, {
      ...base,
      status: 'failed',
      last_error: lastError.slice(0, 500),
      updated_at: new Date().toISOString(),
    });
    throw error;
  }

  const selected: Record<string, unknown> = {};
  for (const field of config.fields ?? []) {
    if (Object.prototype.hasOwnProperty.call(ctx.data, field)) selected[field] = ctx.data[field];
  }
  const payload = JSON.stringify({
    id,
    type: 'form.submission.completed',
    created_at: createdAt,
    site_id: ctx.siteId,
    form_id: ctx.formId,
    submission_id: ctx.subject.id,
    data: selected,
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  let lastError = 'Webhook delivery failed';
  let responseStatus: number | undefined;
  let attemptsMade = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    attemptsMade = attempt;
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
      }, WEBHOOK_POLICY);
      void response.body?.cancel().catch(() => {});
      responseStatus = response.status;
      if (response.ok) {
        const now = new Date().toISOString();
        await store.setDoc(deliveryPath, {
          ...base,
          status: 'delivered',
          attempts: (previous?.attempts ?? 0) + attempt,
          response_status: response.status,
          delivered_at: now,
          updated_at: now,
        });
        return;
      }
      lastError = `Webhook responded with HTTP ${response.status}`;
      if (response.status < 500 && response.status !== 408 && response.status !== 429) break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Webhook request failed';
    }
  }
  await store.setDoc(deliveryPath, {
    ...base,
    status: 'failed',
    attempts: (previous?.attempts ?? 0) + attemptsMade,
    ...(responseStatus !== undefined ? { response_status: responseStatus } : {}),
    last_error: lastError.slice(0, 500),
    updated_at: new Date().toISOString(),
  });
  throw new Error(lastError);
}
