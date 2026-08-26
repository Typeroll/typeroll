import crypto from 'node:crypto';
import {
  paths,
  type ExtensionInstallation,
  type ExtensionEventDelivery,
  type ExtensionLifecycleEvent,
  type ExtensionVersion,
} from '@typeroll/shared';
import { getStore } from '../datastore';
import { decryptSecret } from '../secret-crypto';
import { assertPublicDestination, parsePublicHttpsUrl } from './public-http';

const MAX_ATTEMPTS = 3;

export async function deliverExtensionLifecycleEvent(args: {
  installation: ExtensionInstallation;
  eventType: ExtensionLifecycleEvent;
  metadata?: Record<string, string | number | boolean | null>;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const store = getStore();
  const version = await store.getDoc<ExtensionVersion>(
    paths.extensionVersion(args.installation.developer_org_id, args.installation.extension_id, args.installation.version),
  );
  const events = version?.manifest.events;
  if (!events?.subscriptions.includes(args.eventType) || !events.webhook_url) return;
  const eventId = `evt_${crypto.randomUUID()}`;
  const deliveryId = eventId;
  const deliveryPath = `${paths.extensionEventDeliveries(args.installation.owner_org_id, args.installation.site_id)}/${deliveryId}`;
  const now = new Date().toISOString();
  const base: Omit<ExtensionEventDelivery, 'id'> = {
    event_id: eventId,
    installation_id: args.installation.id,
    event_type: args.eventType,
    attempt: 0,
    status: 'pending',
    created_at: now,
    updated_at: now,
  };
  await store.setDoc(deliveryPath, base);
  const secretKey = events.secret_config_key ?? 'event_webhook_secret';
  const encryptedSecret = args.installation.secret_config_enc?.[secretKey];
  if (!encryptedSecret) {
    await store.updateDoc(deliveryPath, { status: 'failed', response_class: 'missing_secret', updated_at: new Date().toISOString() });
    return;
  }
  let secret: string;
  let url: URL;
  try {
    secret = decryptSecret(encryptedSecret);
    url = parsePublicHttpsUrl(events.webhook_url, 'Extension event webhook URL');
    await assertPublicDestination(url);
  } catch {
    await store.updateDoc(deliveryPath, { status: 'failed', response_class: 'configuration_error', updated_at: new Date().toISOString() });
    return;
  }
  const payload = JSON.stringify({
    id: eventId,
    type: args.eventType,
    schema_version: 1,
    created_at: now,
    extension_id: args.installation.extension_id,
    installation_id: args.installation.id,
    site_id: args.installation.site_id,
    version: args.installation.version,
    metadata: args.metadata ?? {},
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  let responseClass = 'network_error';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await (args.fetchImpl ?? fetch)(url, {
        method: 'POST',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Typeroll-Extension-Events/1.0',
          'Idempotency-Key': eventId,
          'X-Typeroll-Event': args.eventType,
          'X-Typeroll-Event-Id': eventId,
          'X-Typeroll-Timestamp': timestamp,
          'X-Typeroll-Signature': `v1=${signature}`,
        },
        body: payload,
      });
      responseClass = `http_${Math.floor(response.status / 100)}xx`;
      if (response.ok) {
        await store.updateDoc(deliveryPath, { attempt, status: 'delivered', response_class: responseClass, updated_at: new Date().toISOString() });
        return;
      }
      if (response.status < 500 && response.status !== 408 && response.status !== 429) break;
    } catch {
      responseClass = 'network_error';
    } finally {
      clearTimeout(timeout);
    }
    await store.updateDoc(deliveryPath, {
      attempt,
      status: attempt < MAX_ATTEMPTS ? 'retrying' : 'failed',
      response_class: responseClass,
      next_attempt_at: attempt < MAX_ATTEMPTS ? new Date(Date.now() + attempt * 1000).toISOString() : undefined,
      updated_at: new Date().toISOString(),
    });
  }
  await store.updateDoc(deliveryPath, { status: 'failed', response_class: responseClass, updated_at: new Date().toISOString() });
}

/** Event delivery is operationally best-effort and never rolls back control-plane state. */
export async function notifyExtensionLifecycle(args: Parameters<typeof deliverExtensionLifecycleEvent>[0]): Promise<void> {
  try { await deliverExtensionLifecycleEvent(args); } catch { /* delivery status is diagnostic, not transaction authority */ }
}
