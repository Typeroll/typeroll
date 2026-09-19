import { ownerReviewMessage } from './owner-review-message';
import { createHash } from 'node:crypto';
import { getStore } from './datastore';
import { decryptSecret } from './secret-crypto';
import { DeliveryError, readDelivery, sendApplicationEmail } from './email/delivery';
import { readOwnerProposal, ownerFieldDescriptor, proposalPath, reviewSettingsPath, ProposalError, type ProposalScope, type ReviewSettings, type OwnerProposal } from './owner-proposals';

/** Explicit, bounded outbox dispatch. Ambiguous in-flight delivery is not timed out and resent. */
export async function notifyOwnerReviewer(scope: ProposalScope, id: string, issuer: string, retry = false) {
  const store = getStore();
  const proposal = await readOwnerProposal(scope, id);
  if (proposal.status !== 'pending' || proposal.notification.status === 'accepted') return proposal.notification;
  if (proposal.review.revoked_at || proposal.review.expires_at <= Date.now()) throw new ProposalError('Renew the private review link in the review queue before sending its notification.', 409);
  if (proposal.notification.status === 'sending') throw new ProposalError('Notification delivery is in progress or needs administrator recovery. It has not been sent again.', 409);
  if (proposal.notification.attempts >= 3 || (proposal.notification.status === 'failed' && !retry)) return proposal.notification;
  const settings = await store.getDoc<ReviewSettings>(reviewSettingsPath(scope));
  if (!settings?.enabled) throw new ProposalError('Review notifications are not configured', 409);
  const notification: OwnerProposal['notification'] = { status: 'sending', attempts: proposal.notification.attempts + 1, last_attempt_at: new Date().toISOString() };
  const reserved = { ...proposal, notification };
  if (!await store.compareAndReplaceDoc(proposalPath(scope, id), proposal, reserved)) throw new ProposalError('Notification changed. Refresh its status.', 409);
  let status: OwnerProposal['notification']['status'] = 'sending';
  let messageId: string | undefined;
  let deliveryStatus: string | undefined;
  try {
    const url = new URL('/review/owner-changes', issuer);
    for (const [key, value] of Object.entries({ org: scope.orgId, site: scope.siteId, version: scope.versionId, proposal: id })) url.searchParams.set(key, value);
    url.hash = decryptSecret(proposal.review.encrypted_token);
    const { fields } = await ownerFieldDescriptor(scope, proposal.page_id);
    const message = ownerReviewMessage({ title: proposal.title, before: proposal.before, changes: proposal.changes,
      labels: Object.fromEntries(fields.map(field => [field.name, field.label || field.name])), url: url.href, expiresAt: proposal.review.expires_at });
    const result = await sendApplicationEmail({ ...scope, installationId: 'core-owner-review' }, {
      idempotency_key: createHash('sha256').update(`${scope.versionId}:${id}:${proposal.review.hash}:${notification.attempts}`).digest('hex'),
      to: settings.recipient, ...message,
    });
    messageId = result.id; deliveryStatus = result.status;
    status = ['accepted', 'delivered'].includes(result.status) ? 'accepted' : ['unknown', 'dispatching'].includes(result.status) ? 'sending' : 'failed';
  } catch (error) {
    // Failure to persist an acceptance is ambiguous too. Only a definitive
    // pre-dispatch refusal may expose the ordinary retry action.
    if (error instanceof DeliveryError && [400, 409, 429].includes(error.status)) status = 'failed';
  }
  const final: OwnerProposal['notification'] = { ...notification, status, ...(messageId ? { message_id: messageId, delivery_status: deliveryStatus } : {}), ...(status === 'accepted' ? { accepted_at: new Date().toISOString() } : {}) };
  // A concurrent review decision may have changed the proposal; preserve it.
  await store.compareAndUpdateDoc<OwnerProposal>(proposalPath(scope, id), current =>
    current.notification.status === 'sending' && current.notification.last_attempt_at === notification.last_attempt_at,
    { notification: final });
  return final;
}


export async function ownerNotificationStatus(scope: ProposalScope, notification: OwnerProposal['notification']) {
  if (!notification.message_id) return notification;
  const receipt = await readDelivery({ ...scope, installationId: 'core-owner-review' }, notification.message_id);
  return receipt ? { ...notification, delivery_status: receipt.status } : notification;
}
