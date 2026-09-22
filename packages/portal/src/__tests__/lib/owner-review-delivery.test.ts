import { beforeEach, describe, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { answerRevision, submitOwnerProposal, readOwnerProposal, proposalPath, reviewSettingsPath } from '../../lib/owner-proposals';
import { notifyOwnerReviewer } from '../../lib/owner-review-notifications';
import { displayAnswer, ownerReviewMessage } from '../../lib/owner-review-message';
import { handleOwnerReviewAdmin } from '../../lib/owner-review-http';
import { decryptSecret } from '../../lib/secret-crypto';
import { GET, POST } from '../../pages/api/owner-review';
const send = vi.hoisted(() => vi.fn());
vi.mock('../../lib/email', () => ({ sendViaConnector: send }));
const scope = { orgId: 'test-org', siteId: 'test-site', versionId: 'main' };
let id: string, token: string;
const pagePath = paths.page(scope.orgId, scope.siteId, 'sample');
const request = (method = 'GET', body?: unknown, supplied = token) => new Request(`https://cms.example.test/api/owner-review?org=${scope.orgId}&site=${scope.siteId}&version=main&proposal=${id}`, {
  method, headers: { Authorization: `Bearer ${supplied}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
});
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore(); send.mockReset(); send.mockResolvedValue({ ok: true });
  process.env.INTEGRATIONS_SECRET_KEY = 'synthetic-test-only-not-a-secret';
  const store = getStore();
  await store.setDoc(paths.contentType(scope.orgId, scope.siteId, 'company'), { name: 'company', fields: [{ name: 'online', type: 'boolean', writable_by: ['owner', 'portal', 'import'] }] });
  await store.setDoc(pagePath, { title: 'Synthetic company', content_type: 'company', fields: { online: null } });
  await store.setDoc(reviewSettingsPath(scope), { enabled: true, recipient: 'reviewer@example.test', link_ttl_hours: 24 });
  await store.setDoc(paths.integrations(scope.orgId, scope.siteId), { email: { type: 'synthetic', from: 'sender@example.test', config: {} } });
  ({ proposal_id: id } = await submitOwnerProposal(scope, 'sample', { installationId: 'test', subjectId: 'a'.repeat(64) }, {
    changes: { online: false }, base_revision: answerRevision(await store.getDoc(pagePath)), request_id: 'submission-test-00001',
  }));
  token = decryptSecret((await readOwnerProposal(scope, id)).review.encrypted_token);
});
describe('private review delivery and HTTP contract', () => {
  it('makes scanner GETs harmless and keeps tokens, subjects and actors out of responses', async () => {
    for (let i = 0; i < 2; i++) {
      const response = await GET({ request: request() } as never);
      expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toContain('no-store');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer'); expect(response.headers.get('x-robots-tag')).toContain('noindex');
      const text = await response.text(); expect(text).not.toContain(token); expect(text).not.toContain('subject_id'); expect(text).not.toContain('actor_id');
    }
    expect((await readOwnerProposal(scope, id)).status).toBe('pending'); expect(send).not.toHaveBeenCalled();
    const bad = await GET({ request: request('GET', undefined, 'invalid') } as never); expect(bad.status).toBe(401);
    const approval = await POST({ request: request('POST', { action: 'approve', request_id: 'review-action-00001' }) } as never);
    expect(approval.status).toBe(200); expect((await getStore().getDoc<any>(pagePath))?.fields.online).toBe(false);
  });
  it('reserves one dispatch across concurrent callers and puts the token only in the URL fragment', async () => {
    const results = await Promise.allSettled([notifyOwnerReviewer(scope, id, 'https://cms.example.test'), notifyOwnerReviewer(scope, id, 'https://cms.example.test')]);
    expect(results.some(result => result.status === 'fulfilled')).toBe(true); expect(send).toHaveBeenCalledTimes(1);
    const message = send.mock.calls[0][1]; expect(message.to).toBe('reviewer@example.test');
    const link = new URL(message.text.match(/https:\/\/cms\.example\.test\/review\/[^\s]+/)[0]);
    expect(link.hash).toBe(`#${token}`); expect(link.search).not.toContain(token);
    expect(message.text).toContain('Before: Unanswered'); expect(message.text).toContain('Proposed: No');
    await notifyOwnerReviewer(scope, id, 'https://cms.example.test', true); expect(send).toHaveBeenCalledTimes(1);
  });
  it('preserves pending proposals on failure and caps explicit retries at three attempts', async () => {
    send.mockResolvedValue({ ok: false, failure: 'rejected' });
    expect((await notifyOwnerReviewer(scope, id, 'https://cms.example.test')).status).toBe('failed');
    await notifyOwnerReviewer(scope, id, 'https://cms.example.test'); expect(send).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 5; i++) await notifyOwnerReviewer(scope, id, 'https://cms.example.test', true);
    expect(send).toHaveBeenCalledTimes(3); expect((await readOwnerProposal(scope, id)).status).toBe('pending');
    expect((await getStore().getDoc<any>(pagePath))?.fields.online).toBeNull();
  });
  it('keeps uncertain mail pending administrator recovery and exposes its durable receipt', async () => {
    send.mockRejectedValue(new Error('Unknown acceptance'));
    const result = await notifyOwnerReviewer(scope, id, 'https://cms.example.test');
    expect(result).toMatchObject({ status: 'sending', delivery_status: 'unknown', message_id: expect.any(String) });
    await expect(notifyOwnerReviewer(scope, id, 'https://cms.example.test', true)).rejects.toThrow('administrator recovery');
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('never resends a timed-out sending record; recovery requires an explicit audit reason', async () => {
    await getStore().updateDoc(proposalPath(scope, id), { notification: { status: 'sending', attempts: 1, last_attempt_at: '2000-01-01' } });
    await expect(notifyOwnerReviewer(scope, id, 'https://cms.example.test', true)).rejects.toThrow('administrator recovery');
    const admin = (reason?: string) => handleOwnerReviewAdmin(scope, 'synthetic-admin', new Request('https://cms.example.test/api', { method: 'POST', body: JSON.stringify({ action: 'recover-notification', proposal_id: id, reason }) }));
    expect((await admin()).status).toBe(400); expect(send).not.toHaveBeenCalled();
    expect((await admin('Provider confirmed the earlier dispatch failed')).status).toBe(200);
    expect((await getStore().getDoc<any>(proposalPath(scope, id)))?.notification_recovery.actor_id).toBe('synthetic-admin');
    await notifyOwnerReviewer(scope, id, 'https://cms.example.test', true); expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('reviewer-readable answers', () => {
  it('renders a multi-option answer as prose, not as storage shape', () => {
    // A reviewer reading on a phone should learn that the company offers
    // training and does not send catalogues, without parsing JSON.
    const message = ownerReviewMessage({
      title: 'Sarris Candies', labels: { sales_support_answers: 'Sales support offered' },
      before: {}, changes: { sales_support_answers: { printed_catalog: false, training: true } },
      url: 'https://example.test/review#t', expiresAt: 0,
    });
    expect(message.text).toContain('Printed catalog: No');
    expect(message.text).toContain('Training: Yes');
    expect(message.text).not.toContain('{');
  });

  it('distinguishes unanswered from asserting no facts', () => {
    expect(displayAnswer(null)).toBe('Unanswered');
    expect(displayAnswer({})).toBe('None specified');
    expect(displayAnswer([])).toBe('None');
    // An owner's explicit clear inside an answer object stays unknown.
    expect(displayAnswer({ training: null })).toContain('Training: Unanswered');
  });

  it('stops recursing before a reviewer stops reading', () => {
    expect(displayAnswer({ a: { b: { c: { d: 1 } } } })).toContain('[see review]');
  });
});
