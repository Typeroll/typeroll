import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { applyDeliveryEvent, publicReceipt, readDelivery, sendApplicationEmail } from '../../lib/email/delivery';

const scope = { orgId: 'one', siteId: 'site', installationId: 'app-one' };
const input = { idempotency_key: 'request-0000000001', to: 'owner@example.com', subject: 'Your link', text: 'Private token content' };
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore();
  await getStore().setDoc(paths.integrations(scope.orgId, scope.siteId), { email: { type: 'ses', from: 'Approved <mail@example.com>', config: {} } });
});

describe('application mail delivery', () => {
  it('reserves once under concurrency, separates acceptance from delivery and never stores the body', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, id: 'ses-1' });
    const receipts = await Promise.all(Array.from({ length: 8 }, () => sendApplicationEmail(scope, input, { send })));
    expect(send).toHaveBeenCalledTimes(1);
    expect(new Set(receipts.map(receipt => receipt.id)).size).toBe(1);
    const receipt = (await readDelivery(scope, receipts[0]!.id))!;
    expect(publicReceipt(receipt)).toMatchObject({ accepted: true, delivered: false, status: 'accepted' });
    expect(send.mock.calls[0]![1]).toMatchObject({ from: '', deliveryId: receipt.id });
    expect(JSON.stringify(receipt)).not.toContain(input.text);
    expect(JSON.stringify(receipt)).not.toContain(input.to);
    await expect(sendApplicationEmail(scope, { ...input, text: 'Changed' }, { send })).rejects.toMatchObject({ status: 409 });
  });

  it('does not resend an uncertain dispatch and caps retries for explicit rejections', async () => {
    const send = vi.fn().mockRejectedValue(new Error('connection reset after send'));
    const first = await sendApplicationEmail(scope, input, { send });
    expect(first.status).toBe('unknown');
    await sendApplicationEmail(scope, input, { send });
    expect(send).toHaveBeenCalledTimes(1);
    const rejected = vi.fn().mockResolvedValue({ ok: false, failure: 'retryable_rejection' });
    const receipt = await sendApplicationEmail(scope, { ...input, idempotency_key: 'request-0000000002' }, { send: rejected, sleep: async () => {} });
    expect(rejected).toHaveBeenCalledTimes(3);
    expect(receipt).toMatchObject({ status: 'failed', attempts: 3 });
  });

  it('keeps quotas and receipt reads scoped to the site and installation', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, id: 'ses-1' });
    const receipt = await sendApplicationEmail(scope, input, { send });
    expect(await readDelivery({ ...scope, installationId: 'app-two' }, receipt.id)).toBeNull();
    expect(await readDelivery({ ...scope, siteId: 'other' }, receipt.id)).toBeNull();
    const key = createHash('sha256').update(scope.installationId).digest('hex');
    await getStore().setDoc(`${paths.site(scope.orgId, scope.siteId)}/mail_quotas/${new Date().toISOString().slice(0,10)}`, { total: 100, installations: { [key]: 100 } });
    await expect(sendApplicationEmail(scope, { ...input, idempotency_key: 'request-0000000002' }, { send })).rejects.toMatchObject({ status: 429 });
    expect((await sendApplicationEmail({ ...scope, installationId: 'app-two' }, input, { send })).status).toBe('accepted');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('correlates events, deduplicates and suppresses permanent failures across apps on the same site', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, id: 'ses-1' });
    const receipt = await sendApplicationEmail(scope, input, { send });
    const event = { id: 'event-1', deliveryId: receipt.id, providerId: 'ses-1', provider: 'ses', type: 'delivered' as const, at: new Date().toISOString() };
    expect(await applyDeliveryEvent({ ...event, providerId: 'wrong' })).toBe(false);
    await applyDeliveryEvent(event); await applyDeliveryEvent(event);
    expect((await readDelivery(scope, receipt.id))!.events).toHaveLength(1);
    expect((await readDelivery(scope, receipt.id))!.status).toBe('delivered');
    await applyDeliveryEvent({ ...event, id: 'event-2', type: 'complained', suppress: true });
    await applyDeliveryEvent({ ...event, id: 'event-3' });
    expect((await readDelivery(scope, receipt.id))!.status).toBe('complained');
    await expect(sendApplicationEmail({ ...scope, installationId: 'app-two' }, input, { send })).rejects.toMatchObject({ status: 409 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('keeps a provider event that arrives before the send response', async () => {
    const receipt = await sendApplicationEmail(scope, input, { send: async (_, message) => {
      await applyDeliveryEvent({ id: 'early', deliveryId: message.deliveryId!, providerId: 'ses-1', provider: 'ses', type: 'delivered', at: new Date().toISOString() });
      return { ok: true, id: 'ses-1' };
    } });
    expect(receipt.status).toBe('delivered');
  });
});
