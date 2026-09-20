import { createHash } from 'node:crypto';
import { simpleParser } from 'mailparser';
import { paths, type ExtensionInstallation, type SiteIntegrations } from '@typeroll/shared';
import { getStore } from '../datastore';
import { INBOUND_MAX_BYTES, inboundObject, loadInboundObject, deleteInboundObject } from './inbound-storage';
import { DeliveryError, publicReceipt, readDelivery, sendApplicationEmail, type MailScope } from './delivery';

/** Approved by the host after DNS/target ownership verification, never supplied by an app. */
export interface InboundRoute extends MailScope {
  id: string; alias: string; target: string; from: string; topic: string; bucket: string; prefix: string; region: string;
}
interface RouteSetting { revision: string; enabled: boolean; last_receipt_id?: string }
interface InboundReceipt {
  id: string; route_id: string; installation_id: string; revision: string;
  status: 'processing' | 'held' | 'blocked' | 'forwarded' | 'failed' | 'unknown';
  reason?: string; delivery_id?: string; alert_delivery_id?: string; created_at: string; expires_at_iso: string;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const address = (value: unknown): value is string => typeof value === 'string' && value.length <= 254 &&
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(value);
const routeRevision = (route: InboundRoute) => hash(JSON.stringify(route));
const settingPath = (route: InboundRoute) => `${paths.site(route.orgId, route.siteId)}/mail_inbound_settings/${route.id}`;
const receiptPath = (route: InboundRoute, id: string) => `${paths.site(route.orgId, route.siteId)}/mail_inbound_receipts/${id}`;

export function inboundRoutes(raw = process.env.EMAIL_SES_INBOUND_ROUTES ?? '[]'): InboundRoute[] {
  let values: unknown;
  try { values = JSON.parse(raw); } catch { throw new DeliveryError('Incoming email host configuration is invalid', 503); }
  if (!Array.isArray(values) || values.length > 1000) throw new DeliveryError('Incoming email host configuration is invalid', 503);
  const result: InboundRoute[] = [];
  for (const value of values) {
    if (!value || typeof value !== 'object' || ['id', 'orgId', 'siteId', 'installationId'].some(key =>
      typeof value[key] !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value[key])) ||
      typeof value.bucket !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value.bucket) ||
      typeof value.prefix !== 'string' || !/^[A-Za-z0-9_-]{1,100}\/$/.test(value.prefix) ||
      typeof value.region !== 'string' || !/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(value.region) ||
      !address(value.alias) || !address(value.target) || !address(value.from) ||
      typeof value.topic !== 'string' || !/^arn:aws:sns:[a-z]{2}(?:-[a-z]+)+-\d:\d{12}:[A-Za-z0-9_-]+$/.test(value.topic))
      throw new DeliveryError('Incoming email host configuration is invalid', 503);
    result.push({ id: value.id, orgId: value.orgId, siteId: value.siteId, installationId: value.installationId,
      alias: value.alias, target: value.target, from: value.from, topic: value.topic, bucket: value.bucket, prefix: value.prefix, region: value.region });
    if (value.topic.split(':')[3] !== value.region) throw new DeliveryError('Incoming email region does not match its SNS topic', 503);
  }
  if (new Set(result.map(r => r.alias)).size !== result.length || new Set(result.map(r => r.id)).size !== result.length ||
      new Set(result.map(r => `${r.region}/${r.bucket}/${r.prefix}`)).size !== result.length ||
      result.some(r => r.target === r.from || result.some(other => other.alias === r.target || other.alias === r.from)))
    throw new DeliveryError('Incoming email aliases and targets must be unique and cannot form forwarding loops', 503);
  return result;
}

export async function siteInboundRoutes(orgId: string, siteId: string, installationId?: string) {
  const routes = inboundRoutes().filter(r => r.orgId === orgId && r.siteId === siteId && (!installationId || r.installationId === installationId));
  return Promise.all(routes.map(async route => {
    const revision = routeRevision(route);
    const state = await getStore().getDoc<RouteSetting>(settingPath(route));
    return { route_id: route.id, alias: route.alias, ...(installationId ? {} : { target: route.target }), revision,
      enabled: state?.enabled === true && state.revision === revision,
      last_receipt: state?.last_receipt_id ? await readInboundReceipt(route, state.last_receipt_id) : null,
      installation_id: route.installationId, max_bytes: INBOUND_MAX_BYTES, attachments: 'omitted', body_storage: 'private_s3_short_lived' };
  }));
}

export async function setInboundRoute(orgId: string, siteId: string, input: { route_id?: unknown; revision?: unknown; enabled?: unknown }) {
  const route = inboundRoutes().find(r => r.orgId === orgId && r.siteId === siteId && r.id === input.route_id);
  if (!route) throw new DeliveryError('Approved incoming email route not found', 404);
  if (input.revision !== routeRevision(route)) throw new DeliveryError('Incoming email route changed. Reload before confirming.', 409);
  if (typeof input.enabled !== 'boolean') throw new DeliveryError('enabled must be a boolean', 400);
  await getStore().setDoc(settingPath(route), { revision: input.revision, enabled: input.enabled });
}

export async function readInboundReceipt(scope: MailScope, id: string) {
  if (!/^[a-f0-9]{64}$/.test(id)) return null;
  const receipt = await getStore().getDoc<InboundReceipt>(`${paths.site(scope.orgId, scope.siteId)}/mail_inbound_receipts/${id}`);
  if (!receipt || receipt.installation_id !== scope.installationId || Date.parse(receipt.expires_at_iso) <= Date.now()) return null;
  const delivery = receipt.delivery_id ? await readDelivery(scope, receipt.delivery_id) : null;
  const alert = receipt.alert_delivery_id ? await readDelivery(scope, receipt.alert_delivery_id) : null;
  return { receipt_id: receipt.id, route_id: receipt.route_id, status: receipt.status, reason: receipt.reason,
    created_at: receipt.created_at, ...(delivery ? { delivery: publicReceipt(delivery) } : {}), ...(alert ? { alert_delivery: publicReceipt(alert) } : {}) };
}

/** Only call with the topic from a verified SNS envelope; envelope recipients own routing. */
export async function receiveSesEmail(topic: string, payload: unknown,
  dependencies: Parameters<typeof sendApplicationEmail>[2] & { load?: typeof loadInboundObject; remove?: typeof deleteInboundObject } = {}): Promise<{ status: string; receipt_id?: string; reason?: string }> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new DeliveryError('Invalid incoming email event', 400);
  const message = payload as Record<string, any>;
  if (message.notificationType !== 'Received') throw new DeliveryError('Invalid incoming email event', 400);
  const messageId = message.mail?.messageId;
  const timestamp = Date.parse(message.mail?.timestamp);
  if (typeof messageId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(messageId) || !Number.isFinite(timestamp) ||
      timestamp > Date.now() + 300_000 || timestamp < Date.now() - 86_400_000)
    throw new DeliveryError('Invalid or expired incoming email event', 400);
  const routes = inboundRoutes();
  const recipients = message.receipt?.recipients;
  // SES exact-address rules also accept plus labels. Associate their signed storage
  // reference with the approved route for an observable rejection, never forwarding.
  const singleRecipient = Array.isArray(recipients) && recipients.length === 1 && typeof recipients[0] === 'string'
    ? recipients[0].toLowerCase() : undefined;
  const action = message.receipt?.action;
  const route = routes.find(r => r.topic === topic && r.alias === singleRecipient) ??
    routes.find(r => r.topic === topic && action?.type === 'S3' && action.bucketName === r.bucket &&
      action.objectKey === `${r.prefix}${messageId}` && action.topicArn === r.topic);
  if (!route) {
    console.error(JSON.stringify({ event: 'incoming_email_unmatched_route', event_id: hash(JSON.stringify([topic, messageId])) }));
    return { status: 'ignored', reason: 'route_not_approved' };
  }
  inboundObject(route, message);
  // SES emits this reserved message when validating a receipt rule's S3/SNS
  // action. It is provider setup, not customer mail. Keep signature/topic and
  // exact storage-route verification ahead of this no-op, including when off.
  if (messageId === 'AMAZON_SES_SETUP_NOTIFICATION') return { status: 'ignored', reason: 'provider_setup_notification' };
  const revision = routeRevision(route);
  const store = getStore();
  const setting = await store.getDoc<RouteSetting>(settingPath(route));
  if (!setting?.enabled || setting.revision !== revision) {
    console.error(JSON.stringify({ event: 'incoming_email_route_disabled', route_id: route.id }));
    return { status: 'disabled' };
  }
  if (route.installationId !== 'core-forwarding') {
    const installation = await store.getDoc<ExtensionInstallation>(paths.extensionInstallation(route.orgId, route.siteId, route.installationId));
    if (!installation || installation.status !== 'enabled') {
      console.error(JSON.stringify({ event: 'incoming_email_route_disabled', route_id: route.id }));
      return { status: 'disabled' };
    }
  }
  const id = hash(JSON.stringify([topic, messageId, route.id]));
  const path = receiptPath(route, id);
  const existing = await store.getDoc<InboundReceipt>(path);
  if (existing) return { status: existing.status, receipt_id: id };
  const now = new Date();
  const quotaPath = `${paths.site(route.orgId, route.siteId)}/mail_inbound_quotas/${now.toISOString().slice(0, 10)}`;
  const quota = await store.getDoc<{ total: number }>(quotaPath);
  if ((quota?.total ?? 0) >= 1000) { console.error(JSON.stringify({ event: 'incoming_email_quota_exceeded', route_id: route.id })); return { status: 'limited' }; }
  const receipt: InboundReceipt = { id, route_id: route.id, installation_id: route.installationId, revision,
    status: 'processing', created_at: now.toISOString(), expires_at_iso: new Date(now.getTime() + 30 * 86_400_000).toISOString() };
  // TTL is a native timestamp in Firestore; raw content is never written to the CMS datastore.
  if (!await store.compareAndReplaceDoc(path, null, { ...receipt, expires_at: new Date(receipt.expires_at_iso) }, [
    { path: settingPath(route), expected: setting, data: {}, guardOnly: true },
    { path: quotaPath, expected: quota, data: { total: (quota?.total ?? 0) + 1, expires_at: new Date(now.getTime() + 30 * 86_400_000) } },
  ])) {
    const concurrent = await store.getDoc<InboundReceipt>(path);
    if (concurrent) return { status: concurrent.status, receipt_id: id };
    throw new DeliveryError('Incoming email reservation is busy; retry the same event', 503);
  }
  await store.compareAndUpdateDoc<RouteSetting>(settingPath(route), current => current.revision === revision, { last_receipt_id: id });
  const finish = async (status: InboundReceipt['status'], reason?: string, delivery_id?: string) => {
    await store.updateDoc(path, { status, ...(reason ? { reason } : {}), ...(delivery_id ? { delivery_id } : {}) });
    if (['held', 'blocked', 'failed', 'unknown'].includes(status)) {
      console.error(JSON.stringify({ event: 'incoming_email_attention', route_id: route.id, receipt_id: id, status, reason }));
      // Notify only the already approved destination, never an unverified sender.
      try {
        const alert = await sendApplicationEmail(route, { idempotency_key: hash(`${id}:attention`), to: route.target,
          subject: 'Incoming email needs attention', text: `An incoming email could not be forwarded normally.\nStatus: ${status}\nReason: ${reason ?? 'delivery_unconfirmed'}\nReceipt: ${id}\nCheck Site settings → Email & notifications. Do not resend automatically. Unprocessed mail expires from private storage under the hosting retention policy.` },
          { ...dependencies, forwarding: { replyTo: route.target } });
        await store.updateDoc(path, { alert_delivery_id: alert.id });
        if (!['accepted', 'delivered'].includes(alert.status)) console.error(JSON.stringify({ event: 'incoming_email_alert_failed', route_id: route.id, receipt_id: id }));
      } catch { console.error(JSON.stringify({ event: 'incoming_email_alert_failed', route_id: route.id, receipt_id: id })); }
    }
    // Provider acceptance can still be followed by a bounce. Preserve other originals
    // until the short S3 lifecycle expires so an operator can investigate.
    if (reason === 'virus_detected') {
      try { await (dependencies.remove ?? deleteInboundObject)(route, message); }
      catch { console.error(JSON.stringify({ event: 'incoming_email_cleanup_failed', route_id: route.id, receipt_id: id })); }
    }
    return { status, receipt_id: id, ...(reason ? { reason } : {}) };
  };
  try {
    if (message.receipt?.virusVerdict?.status === 'FAIL') return finish('blocked', 'virus_detected');
    if (singleRecipient !== route.alias) return finish('blocked', 'recipient_not_approved');
    if (message.receipt?.virusVerdict?.status !== 'PASS') return finish('held', 'virus_scan_inconclusive');
    if (message.receipt?.spamVerdict?.status !== 'PASS') return finish('held', 'spam_review_required');
    if (message.receipt?.dmarcVerdict?.status !== 'PASS') return finish('held', 'sender_authentication_unconfirmed');
    const content = await (dependencies.load ?? loadInboundObject)(route, message);
    if (content.byteLength > INBOUND_MAX_BYTES) return finish('held', 'message_size_limit');
    const parsed = await simpleParser(content, { skipImageLinks: true, skipTextToHtml: true, maxHtmlLengthToParse: INBOUND_MAX_BYTES });
    const sender = parsed.from?.value.length === 1 ? parsed.from.value[0]?.address?.toLowerCase() : undefined;
    if (parsed.headerLines.filter(h => h.key === 'from').length !== 1 || !address(sender) || routes.some(r => r.alias === sender || r.from === sender) ||
        parsed.headerLines.some(h => ['x-typeroll-forwarded', 'list-id'].includes(h.key)) ||
        (parsed.headers.has('auto-submitted') && parsed.headers.get('auto-submitted') !== 'no'))
      return finish('blocked', 'automatic_or_ambiguous_sender');
    const subject = (parsed.subject ?? '(no subject)').replace(/[\r\n\x00-\x1f\x7f]/g, ' ').slice(0, 180);
    if (!parsed.text?.trim() || parsed.text.length > 30_000) return finish('blocked', 'empty_or_oversized_text');
    const connector = (await store.getDoc<SiteIntegrations>(paths.integrations(route.orgId, route.siteId)))?.email;
    const from = connector?.from.match(/<([^<>]+)>\s*$/)?.[1] ?? connector?.from;
    if (connector?.type !== 'ses' || from?.toLowerCase() !== route.from) return finish('blocked', 'sender_configuration_changed');
    const text = `Forwarded message received at ${route.alias}\nOriginal sender: ${sender}\n${parsed.attachments.length ? 'Attachments were omitted for safety.\n' : ''}\n${parsed.text}`;
    const delivery = await sendApplicationEmail(route, { idempotency_key: id, to: route.target, subject: `Fwd: ${subject}`, text },
      { ...dependencies, forwarding: { replyTo: sender } });
    return finish(['accepted', 'delivered'].includes(delivery.status) ? 'forwarded' : delivery.status === 'failed' ? 'failed' : 'unknown', undefined, delivery.id);
  } catch (error) {
    // Do not log parser/provider errors: they may contain the original message.
    return finish(error instanceof DeliveryError && error.status === 413 ? 'held' : 'failed', error instanceof DeliveryError && error.status === 413 ? 'message_size_limit' : 'storage_or_forwarding_failed');
  }
}
