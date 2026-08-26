import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { paths } from '@typeroll/shared';
import type { FormAction, FormWebhookDelivery } from '@typeroll/shared';
import { getStore } from '../datastore';
import { decryptSecret } from '../secret-crypto';
import type { ActionContext } from './actions';

const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 8_000;

interface StoredWebhookConfig {
  url: string;
  fields: string[];
  secret_enc: string;
  webhook_id: string;
}

function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 ||
      (a === 100 && b! >= 64 && b! <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a! >= 224;
  }
  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase();
    return normalized === '::' || normalized === '::1' ||
      normalized.startsWith('fc') || normalized.startsWith('fd') ||
      /^fe[89ab]/.test(normalized) || normalized.startsWith('::ffff:127.');
  }
  return true;
}

export function parseWebhookUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Webhook URL is invalid'); }
  if (url.protocol !== 'https:') throw new Error('Webhook URL must use HTTPS');
  if (url.username || url.password) throw new Error('Webhook URL must not contain credentials');
  if (url.hash) throw new Error('Webhook URL must not contain a fragment');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error('Webhook URL must use a public host');
  }
  if (net.isIP(host) && isPrivateAddress(host)) throw new Error('Webhook URL must use a public host');
  return url;
}

async function assertPublicDestination(url: URL): Promise<void> {
  if (net.isIP(url.hostname)) return;
  const addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: 'POST',
        redirect: 'manual',
        signal: controller.signal,
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
      });
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
    } finally {
      clearTimeout(timer);
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
