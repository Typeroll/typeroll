import { createHash, randomBytes } from 'node:crypto';
import { paths, isArchivedSite, type Site, type Extension, type ExtensionInstallation } from '@typeroll/shared';
import { getStore } from '../datastore';
import { readOrganizationAccess } from '../organization-access';
import { decryptSecret, encryptSecret, isSecretCryptoConfigured } from '../secret-crypto';
import { resolveExtensionVersion } from '../extensions/resolution';
import { callContractApp } from '../extensions/contract-calls';
import { extensionIssuer } from '../extensions/auth';
import { DeliveryError, readDelivery, sendApplicationEmail, type MailScope } from './delivery';
import { ApplicationEmailQueues, EmailQueueError, emailQueuePath, type QueueDependencies, type ApplicationEmailQueue } from './queue';
import { queueOptoutPath, queueRecipientDigest } from './optouts';
import { readSiteEmailConfiguration } from './configuration';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

async function provider(scope: MailScope) {
  const store = getStore();
  const site = await store.getDoc<Site>(paths.site(scope.orgId, scope.siteId));
  if (!site || isArchivedSite(site)) throw new EmailQueueError('This site is no longer active', 403);
  const installation = await store.getDoc<ExtensionInstallation>(paths.extensionInstallation(scope.orgId, scope.siteId, scope.installationId));
  if (!installation || installation.owner_org_id !== scope.orgId || installation.site_id !== scope.siteId || installation.status !== 'enabled' || !installation.granted_scopes.includes('email:send'))
    throw new EmailQueueError('An enabled email-authorized installation is required', 403);
  const release = (await resolveExtensionVersion(installation)).version;
  const extension = await store.getDoc<Extension>(paths.extension(installation.developer_org_id, installation.extension_id));
  if (!release || !extension || extension.status !== 'active' || release.manifest.api && !extension.trusted_origins.includes(new URL(release.manifest.api.base_url).origin))
    throw new EmailQueueError('The installed email app is unavailable', 409);
  return { installation, release };
}

export function applicationEmailQueues() {
  const store = getStore();
  const call: QueueDependencies['prepare'] = async (q, entry, deliveryId) => {
    const { installation, release } = await provider(q);
    const path = entry.preparation!.path;
    if (!release.manifest.api?.routes.some(route => route.path === path && route.methods.includes('POST')))
      throw new EmailQueueError('App preparation route is not declared by its installed release', 409);
    const data = await callContractApp(installation, release, 'email_queue', path, {
      action: 'prepare', queue_id: q.id, entry_id: entry.id, reference: entry.preparation!.reference, message_id: deliveryId,
    });
    if (typeof data.exclude === 'string') return { exclude: data.exclude };
    if (Number.isInteger(data.retry_after) && Number(data.retry_after) > 0 && Number(data.retry_after) <= 86400) return { retry_after: Number(data.retry_after) };
    if (!data.values || typeof data.values !== 'object' || Array.isArray(data.values) || Object.keys(data.values).some(key => !['link', 'expires'].includes(key)) || Object.values(data.values).some(value => typeof value !== 'string'))
      throw new EmailQueueError('App returned invalid dispatch values', 409);
    return { values: data.values as Record<string, string> };
  };
  return new ApplicationEmailQueues({
    store, now: Date.now,
    seal: encryptSecret, open: decryptSecret,
    authorize: async scope => {
      if (!isSecretCryptoConfigured()) throw new EmailQueueError('Encrypted email queue storage is not configured', 503);
      if (!(await readOrganizationAccess(scope.orgId)).can_write) throw new EmailQueueError('Organization access does not permit email delivery', 403);
      await provider(scope);
    },
    preflight: async (scope, recipient, group) => {
      const configuration = await readSiteEmailConfiguration(scope.orgId, scope.siteId);
      if (!configuration.connector) throw new EmailQueueError('Configure an authorized outgoing account in Site email settings before sending', 409);
      if ((await readOrganizationAccess(scope.orgId)).own_smtp && configuration.connector.type !== 'smtp') throw new EmailQueueError('Configure your own SMTP account before sending during the trial', 409);
      if (await store.getDoc(queueOptoutPath(scope, queueRecipientDigest(scope, group, recipient)))) return 'suppressed';
      const digest = hash(`${scope.orgId}\0${scope.siteId}\0${recipient.trim().toLowerCase()}`);
      if (await store.getDoc(`${paths.site(scope.orgId, scope.siteId)}/mail_suppressions/${digest}`)) return 'suppressed';
      const quota = await store.getDoc<{ total: number }>(`${paths.site(scope.orgId, scope.siteId)}/mail_bulk_quotas/${new Date().toISOString().slice(0, 10)}`);
      if ((quota?.total ?? 0) >= configuration.policy.daily_limit) return 'quota';
      const pacing = await store.getDoc<{ next_at: number }>(`${paths.site(scope.orgId, scope.siteId)}/mail_bulk_pacing/default`);
      return pacing && pacing.next_at > Date.now() ? { retry_after: Math.ceil((pacing.next_at - Date.now()) / 1000) } : 'ready';
    },
    prepare: call,
    acknowledge: async (q, entry, receipt) => {
      if (!entry.preparation) return;
      const { installation, release } = await provider(q);
      if (!release.manifest.api?.routes.some(route => route.path === entry.preparation!.path && route.methods.includes('POST'))) throw new EmailQueueError('App receipt route is unavailable', 409);
      await callContractApp(installation, release, 'email_queue', entry.preparation.path, {
        action: 'receipt', queue_id: q.id, entry_id: entry.id, reference: entry.preparation.reference,
        message_id: receipt.id, status: receipt.status, accepted: ['accepted', 'delivered', 'bounced', 'complained'].includes(receipt.status),
      });
    },
    unsubscribe: async (scope, group, recipient) => {
      const token = randomBytes(32).toString('base64url');
      await store.setDoc(`mail_queue_unsubscribe/${hash(token)}`, { ...scope, group, recipient_digest: queueRecipientDigest(scope, group, recipient), created_at: Date.now() });
      return `${extensionIssuer()}/api/public/email/unsubscribe?t=${token}`;
    },
    send: async (scope, intent) => {
      try { return await sendApplicationEmail(scope, intent, { deliveryGroup: intent.delivery_group, category: 'bulk' }); }
      catch (error) {
        if (error instanceof DeliveryError && error.retry_after) throw new EmailQueueError('Site sending interval has not elapsed', 429, 'pacing', error.retry_after);
        if (error instanceof DeliveryError && error.status === 429) throw new EmailQueueError('Site daily campaign limit reached', 429, 'quota');
        if (error instanceof DeliveryError && ['This destination is suppressed after a bounce or complaint', 'This destination opted out of this email category'].includes(error.message)) throw new EmailQueueError('Recipient is suppressed', 409, 'suppressed');
        if (error instanceof DeliveryError && ['Site email delivery is not configured', 'Configure your own SMTP account to send email during the trial. Saved form answers and webhooks are unaffected.'].includes(error.message)) throw new EmailQueueError('Outgoing account is unavailable. Check Site email settings before resuming.', 409, 'account_unavailable');
        throw error;
      }
    },
    receipt: readDelivery,
  });
}

export async function runScheduledApplicationEmailQueue(source: string, payload: Record<string, unknown>) {
  const match = /^organizations\/([^/]+)\/sites\/([^/]+)\/mail_queues\/([a-f0-9]{64})$/.exec(source);
  if (!match || typeof payload.queue_id !== 'string' || typeof payload.installation_id !== 'string') throw new EmailQueueError('Invalid scheduled email queue');
  const scope: MailScope = { orgId: match[1]!, siteId: match[2]!, installationId: payload.installation_id };
  if (emailQueuePath(scope, payload.queue_id) !== source) throw new EmailQueueError('Email queue source does not match its installation');
  const saved = await getStore().getDoc<ApplicationEmailQueue>(source);
  if (saved?.wake_revision !== payload.wake_revision) return;
  const queues = applicationEmailQueues();
  try { await queues.run(scope, payload.queue_id); }
  catch (error) {
    if (error instanceof EmailQueueError && [403, 409].includes(error.status) && !/already running|busy|changed before dispatch|recipient changed/.test(error.message)) {
      await queues.pauseForConfiguration(scope, payload.queue_id, error.message); return;
    }
    throw error;
  }
}
