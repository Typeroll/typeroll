import { createHash } from 'node:crypto';
import { paths, type Organization, type Member } from '@typeroll/shared';
import { getStore } from './datastore';
import { organizationAccessPolicy } from './organization-access';
import { sendApplicationEmail, type MailScope } from './email/delivery';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Host-owned transactional sender, independent of a customer's Forms connector. */
export function accessNoticeSender(raw = process.env.TYPEROLL_ACCESS_NOTICE_SENDER): MailScope | null {
  if (!raw) return null;
  const value = JSON.parse(raw);
  if (!value || !['orgId', 'siteId'].every(k => typeof value[k] === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value[k]))) throw new Error('Invalid access notice sender');
  return { orgId: value.orgId, siteId: value.siteId, installationId: 'core-access-notices' };
}

/** Stable event and recipient identity: a retry never manufactures a second mail. */
export async function deliverAccessNotice(orgId: string, endsAt: string, daysBefore: number, now = Date.now(), send = sendApplicationEmail) {
  if (![7, 1, 0].includes(daysBefore)) throw new Error('Invalid access notice offset');
  const policy = organizationAccessPolicy();
  if (!policy) return;
  const store = getStore();
  const org = await store.getDoc<Organization>(paths.org(orgId));
  if (!org?.service_access?.initial_period || org.service_access.override || org.service_access.initial_period.ends_at !== endsAt) return;
  const due = Date.parse(endsAt) - daysBefore * 86400000;
  if (now < due) return;
  // After an outage, deliver the current stage, not all historical reminders.
  const nextStage = daysBefore === 7 ? Date.parse(endsAt) - 86400000 : daysBefore === 1 ? Date.parse(endsAt) : Infinity;
  if (now >= nextStage) return;
  const scope = accessNoticeSender();
  if (!scope) throw new Error('Organization access notice sender is not configured');
  const members = await store.listDocs<Member>(paths.members(orgId));
  for (const member of members) {
    if (!['owner', 'admin'].includes(member.role) || !member.email || !Number.isFinite(Date.parse(member.joined_at)) || Date.parse(member.joined_at) > due) continue;
    const id = hash(JSON.stringify([orgId, endsAt, daysBefore, member.id]));
    const path = `${paths.org(orgId)}/service_access_notices/${id}`;
    const subject = daysBefore ? `Your Typeroll trial ends in ${daysBefore === 1 ? 'one day' : 'seven days'}` : 'Your Typeroll trial has ended';
    const text = `Organization: ${orgId}\n\nEditing, previews, publishing and new form submissions ${daysBefore ? 'stop' : 'stopped'} at ${endsAt}. No payment is taken automatically.\n\nYour published static websites remain online on your hosting account. Read and export your content until ${org.service_access.initial_period.read_until}.\n\nView access: ${new URL('/app/settings/access', process.env.PORTAL_PUBLIC_URL || policy.contact_url).href}\nSubscription contact: ${policy.contact_url}`;
    await store.createDocIfMissing(path, { to: member.email, subject, text, status: 'pending', created_at: new Date(now).toISOString() });
    const notice = await store.getDoc<{ to: string; subject: string; text: string; status: string }>(path);
    if (!notice || notice.status !== 'pending') continue;
    // The delivery layer reserves before sending and retains uncertain outcomes.
    // It does not resend a dispatching/unknown receipt after a timeout.
    const receipt = await send({ ...scope, installationId: `core-access-${hash(orgId).slice(0, 24)}` }, { idempotency_key: id, to: notice.to, subject: notice.subject, text: notice.text });
    await store.updateDoc(path, { status: receipt.status, message_id: receipt.id, updated_at: new Date(now).toISOString() });
  }
}
