import { createHash } from 'node:crypto';
import { paths } from '@typeroll/shared';
import type { ReadWriteStore } from '../datastore';
import { DeliveryError, sendApplicationEmail, type MailScope } from '../email/delivery';
import { IntakeError, type IntakeRecord } from './extension-intake';

export interface IntakeNotificationConfig { recipient: string; first_answer_field: string }
export interface IntakeNotice {
  event: 'first_answer' | 'complete'; status: 'pending' | 'sending' | 'accepted' | 'failed' | 'unknown';
  attempts: number; answer_digest: string; created_at: string; subject: string; text: string;
  updated_at?: string; message_id?: string; delivery_status?: string;
}
export function intakeNotificationPlan(value: unknown): IntakeNotificationConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new IntakeError('Invalid notification settings');
  const config = value as Record<string, unknown>;
  if (Object.keys(config).some(key => !['recipient', 'first_answer_field'].includes(key)) ||
      typeof config.recipient !== 'string' || config.recipient.length > 254 || !/^[^\s@,;\r\n]+@[^\s@,;\r\n]+\.[^\s@,;\r\n]+$/.test(config.recipient) ||
      typeof config.first_answer_field !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,100}$/.test(config.first_answer_field)) throw new IntakeError('Invalid notification recipient or first answer field');
  return { recipient: config.recipient.trim().toLowerCase(), first_answer_field: config.first_answer_field };
}
async function changeNotice(store: ReadWriteStore, path: string, event: string, change: (notice: IntakeNotice) => IntakeNotice | null) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const record = await store.getDoc<IntakeRecord>(path), previous = record?.notifications?.[event];
    if (!record || !previous) return null;
    const next = change(previous); if (!next) return null;
    if (await store.compareAndReplaceDoc(path, record, { ...record, notifications: { ...record.notifications, [event]: next } })) return next;
  }
  throw new IntakeError('Notification changed. Refresh before retrying.', 409);
}
/** At most two milestone messages. Ambiguous dispatch is never reclaimed by time. */
export async function dispatchIntakeNotifications(store: ReadWriteStore, scope: MailScope, submissionId: string,
  options: { retry?: boolean; event?: string; send?: typeof sendApplicationEmail } = {}) {
  const path = `${paths.submissions(scope.orgId, scope.siteId)}/${submissionId}`;
  const record = await store.getDoc<IntakeRecord>(path);
  if (!record || record.installation_id !== scope.installationId) throw new IntakeError('Submission not found', 404);
  const config = record.intake?.notifications;
  if (!config) return;
  for (const event of ['first_answer', 'complete']) {
    if (options.event && options.event !== event) continue;
    const reserved = await changeNotice(store, path, event, current =>
      (current.status === 'pending' || options.retry && current.status === 'failed') && current.attempts < 3
        ? { ...current, status: 'sending', attempts: current.attempts + 1, updated_at: new Date().toISOString() } : null);
    if (!reserved) continue;
    let status: IntakeNotice['status'] = 'unknown', messageId: string | undefined, deliveryStatus: string | undefined;
    try {
      const result = await (options.send ?? sendApplicationEmail)(scope, {
        idempotency_key: createHash('sha256').update(`intake:${submissionId}:${event}:${reserved.attempts}`).digest('hex'),
        to: config.recipient, subject: reserved.subject, text: reserved.text,
      });
      messageId = result.id; deliveryStatus = result.status;
      status = ['accepted', 'delivered', 'bounced', 'complained'].includes(result.status) ? 'accepted' : result.status === 'failed' ? 'failed' : 'unknown';
    } catch (error) {
      if (error instanceof DeliveryError && [400, 409, 429].includes(error.status)) status = 'failed';
    }
    await changeNotice(store, path, event, current => current.status === 'sending' && current.attempts === reserved.attempts
      ? { ...current, status, updated_at: new Date().toISOString(), ...(messageId ? { message_id: messageId, delivery_status: deliveryStatus } : {}) } : null);
  }
}

export function intakeNoticeStatus(record: IntakeRecord) {
  return Object.fromEntries(Object.entries(record.notifications ?? {}).map(([event, notice]) => [event, {
    status: notice.status, attempts: notice.attempts, delivery_status: notice.delivery_status ?? null,
    updated_at: notice.updated_at ?? notice.created_at, retryable: notice.status === 'failed' && notice.attempts < 3,
  }]));
}
