import { getStore } from './datastore';
import { decideOwnerProposal, ownerFieldDescriptor, ownerEditorFields, readOwnerProposal, proposalCollection, proposalPath, reviewSettingsPath,
  validateReviewSettings, checkedPatch, ProposalError, type ProposalScope, type OwnerProposal, type ReviewSettings } from './owner-proposals';
import { notifyOwnerReviewer } from './owner-review-notifications';
import { decryptSecret, encryptSecret } from './secret-crypto';
import { vstore, PageWriteConflict } from './version-store';
import { randomBytes, createHash } from 'node:crypto';

export const REVIEW_HEADERS = { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: REVIEW_HEADERS });
export async function proposalView(scope: ProposalScope, id: string, token?: string) {
  const proposal = await readOwnerProposal(scope, id, token);
  const { fields, page } = await ownerFieldDescriptor(scope, proposal.page_id);
  return { proposal_id: id, title: proposal.title, page_id: proposal.page_id, version_id: proposal.version_id,
    status: proposal.status, before: proposal.before, changes: proposal.changes, created_at: proposal.created_at,
    expires_at: proposal.review.expires_at, fields: await ownerEditorFields(scope, page, fields), notification: proposal.notification,
    decision: proposal.decision ? { action: proposal.decision.action, at: proposal.decision.at, adjustments: proposal.decision.adjustments } : null };
}
export async function handleOwnerReviewAdmin(scope: ProposalScope, actorId: string, request: Request) {
  try {
    const url = new URL(request.url), store = getStore();
    if (request.method === 'GET') {
      const proposals = await store.listDocs<OwnerProposal>(proposalCollection(scope), { filters: [{ field: 'version_id', op: '==', value: scope.versionId }], limit: 100, startAfterId: url.searchParams.get('cursor') ?? '' });
      return json({ settings: await store.getDoc<ReviewSettings>(reviewSettingsPath(scope)),
        proposals: proposals.map(({ id, title, page_id, status, created_at, notification }) => ({ id, title, page_id, status, created_at, notification })),
        next_cursor: proposals.length === 100 ? proposals.at(-1)!.id : null });
    }
    const input = await request.json();
    if (input.action === 'settings') {
      const settings = validateReviewSettings(input.settings);
      await store.setDoc(reviewSettingsPath(scope), settings);
      return json({ settings });
    }
    if (input.action === 'answers') {
      const { page, fields, revision } = await ownerFieldDescriptor(scope, String(input.page_id ?? ''));
      return json({ page_id: page.id, revision, fields: await ownerEditorFields(scope, page, fields) });
    }
    if (input.action === 'override') {
      if (typeof input.reason !== 'string' || !input.reason.trim()) throw new ProposalError('An administrative override reason is required');
      const { page, revision, type } = await ownerFieldDescriptor(scope, String(input.page_id ?? ''));
      if (revision !== input.base_revision) throw new ProposalError('The profile changed. Reload before overriding.', 409);
      const fields = checkedPatch(type, type.fields, input.fields);
      await vstore.writePage(scope.orgId, scope.siteId, scope.versionId, page.id, { fields },
        { actor: 'portal', actorId, expected: page, overrideReason: input.reason });
      return json({ updated: true });
    }
    const id = String(input.proposal_id ?? '');
    if (input.action === 'view') return json(await proposalView(scope, id));
    if (input.action === 'notify') return json({ notification: await notifyOwnerReviewer(scope, id, process.env.PORTAL_PUBLIC_URL || url.origin, true) });
    if (['approve', 'reject'].includes(input.action)) return json(await decideOwnerProposal(scope, id, { adminId: actorId }, input));
    const proposal = await readOwnerProposal(scope, id);
    if (proposal.status !== 'pending') throw new ProposalError('This proposal has already been decided', 409);
    if (input.action === 'recover-notification') {
      if (proposal.notification.status !== 'sending') throw new ProposalError('No interrupted notification to recover');
      if (typeof input.reason !== 'string' || !input.reason.trim()) throw new ProposalError('Explain why the interrupted notification can be retried');
      const saved = await store.compareAndReplaceDoc(proposalPath(scope, id), proposal, { ...proposal,
        notification: { ...proposal.notification, status: 'failed' }, notification_recovery: { actor_id: actorId, reason: input.reason, at: new Date().toISOString() } });
      if (!saved) throw new ProposalError('Notification changed. Refresh its status.', 409);
      return json({ recovered: true });
    }
    if (input.action === 'revoke') {
      const saved = await store.compareAndReplaceDoc(proposalPath(scope, id), proposal, { ...proposal, status: 'revoked',
        review: { ...proposal.review, revoked_at: new Date().toISOString() }, revoked_by: actorId });
      if (!saved) throw new ProposalError('Proposal changed. Refresh before revoking.', 409);
      return json({ status: 'revoked' });
    }
    if (input.action === 'review-link') {
      // Expired links are rotated only by an authenticated admin action.
      let token = decryptSecret(proposal.review.encrypted_token);
      if (proposal.review.expires_at <= Date.now() || proposal.review.revoked_at) {
        token = randomBytes(32).toString('base64url');
        const settings = await store.getDoc<ReviewSettings>(reviewSettingsPath(scope));
        const saved = await store.compareAndReplaceDoc(proposalPath(scope, id), proposal, { ...proposal,
          review: { hash: createHash('sha256').update(token).digest('hex'), encrypted_token: encryptSecret(token), expires_at: Date.now() + (settings?.link_ttl_hours ?? 24) * 3_600_000 } });
        if (!saved) throw new ProposalError('Review link changed. Refresh before creating a new one.', 409);
      }
      const link = new URL('/review/owner-changes', process.env.PORTAL_PUBLIC_URL || url.origin);
      for (const [key, value] of Object.entries({ org: scope.orgId, site: scope.siteId, version: scope.versionId, proposal: id })) link.searchParams.set(key, value);
      link.hash = token;
      return json({ review_url: link.href });
    }
    throw new ProposalError('Unknown review action');
  } catch (error) { if (error instanceof ProposalError || error instanceof PageWriteConflict) return json({ error: error.message }, error.status); throw error; }
}
