import { ownerReviewMessage } from './owner-review-message';
import { paths, type SiteIntegrations } from '@typeroll/shared';
import { getStore } from './datastore';
import { decryptSecret } from './secret-crypto';
import { sendViaConnector } from './email';
import { readOwnerProposal, ownerFieldDescriptor, proposalPath, reviewSettingsPath, ProposalError, type ProposalScope, type ReviewSettings, type OwnerProposal } from './owner-proposals';

/** Explicit, bounded outbox dispatch. Ambiguous in-flight delivery is not timed out and resent. */
export async function notifyOwnerReviewer(scope: ProposalScope, id: string, issuer: string, retry = false) {
  const store = getStore();
  const proposal = await readOwnerProposal(scope, id);
  if (proposal.status !== 'pending' || proposal.notification.status === 'sent') return proposal.notification;
  if (proposal.review.revoked_at || proposal.review.expires_at <= Date.now()) throw new ProposalError('Renew the private review link in the review queue before sending its notification.', 409);
  if (proposal.notification.status === 'sending') throw new ProposalError('Notification delivery is in progress or needs administrator recovery. It has not been sent again.', 409);
  if (proposal.notification.attempts >= 3 || (proposal.notification.status === 'failed' && !retry)) return proposal.notification;
  const settings = await store.getDoc<ReviewSettings>(reviewSettingsPath(scope));
  if (!settings?.enabled) throw new ProposalError('Review notifications are not configured', 409);
  const notification: OwnerProposal['notification'] = { status: 'sending', attempts: proposal.notification.attempts + 1, last_attempt_at: new Date().toISOString() };
  const reserved = { ...proposal, notification };
  if (!await store.compareAndReplaceDoc(proposalPath(scope, id), proposal, reserved)) throw new ProposalError('Notification changed. Refresh its status.', 409);
  let delivered = false;
  try {
    const url = new URL('/review/owner-changes', issuer);
    for (const [key, value] of Object.entries({ org: scope.orgId, site: scope.siteId, version: scope.versionId, proposal: id })) url.searchParams.set(key, value);
    url.hash = decryptSecret(proposal.review.encrypted_token);
    const integrations = await store.getDoc<SiteIntegrations>(paths.integrations(scope.orgId, scope.siteId));
    if (!integrations?.email) throw new Error('Email not configured');
    const { fields } = await ownerFieldDescriptor(scope, proposal.page_id);
    const message = ownerReviewMessage({ title: proposal.title, before: proposal.before, changes: proposal.changes,
      labels: Object.fromEntries(fields.map(field => [field.name, field.label || field.name])), url: url.href, expiresAt: proposal.review.expires_at });
    const result = await sendViaConnector(integrations.email, { from: '', to: settings.recipient, ...message });
    delivered = result.ok;
  } catch { /* Only delivery state, never tokens or addresses, leaves this function. */ }
  const final: OwnerProposal['notification'] = { ...notification, status: delivered ? 'sent' : 'failed', ...(delivered ? { sent_at: new Date().toISOString() } : {}) };
  // A concurrent review decision may have changed the proposal; preserve it.
  await store.compareAndUpdateDoc<OwnerProposal>(proposalPath(scope, id), current =>
    current.notification.status === 'sending' && current.notification.last_attempt_at === notification.last_attempt_at,
    { notification: final });
  return final;
}
