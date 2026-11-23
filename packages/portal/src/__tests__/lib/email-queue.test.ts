import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { encryptSecret, decryptSecret } from '../../lib/secret-crypto';
import type { DeliveryReceipt } from '../../lib/email/delivery';
import { ApplicationEmailQueues, EmailQueueError, applicationDeliveryId, emailQueuePath, publicEmailQueue, type QueueDependencies } from '../../lib/email/queue';
import { scheduledIndexWrites } from '../../lib/scheduling';

vi.mock('../../lib/scheduling/transport', () => ({ deliverCommitted: vi.fn() }));
const scope = { orgId: 'test-org', siteId: 'test-site', installationId: 'installed-app' };
const recipient = (i: number) => ({ id: `company-${i}`, to: `owner${i}@example.test`, subject: `Review Company ${i}`,
  text: 'Review: {{link}}. Expires {{expires}}. Opt out: {{unsubscribe_url}}', preparation: { path: '/prepare', reference: `profile-${i}` } });
beforeEach(async () => { makeTmpFixtures(); await resetDatastore(); vi.stubEnv('INTEGRATIONS_SECRET_KEY', 'synthetic-queue-test-key-at-least-thirty-two-characters'); });
afterEach(() => vi.unstubAllEnvs());
function setup() {
  let now = Date.parse('2026-11-23T08:00:00Z');
  const receipts = new Map<string, DeliveryReceipt>();
  const send = vi.fn(async (s, intent) => {
    const id = applicationDeliveryId(s, intent.idempotency_key);
    const receipt: DeliveryReceipt = { ...s, id, fingerprint: '', recipient_digest: '', provider: 'synthetic', status: 'accepted', attempts: 1,
      created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(), events: [] };
    receipts.set(id, receipt); return receipt;
  });
  const deps: QueueDependencies = { store: getStore(), now: () => now, seal: encryptSecret, open: decryptSecret,
    authorize: vi.fn(async () => {}), preflight: vi.fn(async () => 'ready' as const),
    prepare: vi.fn(async () => ({ values: { link: 'https://synthetic.example.test/edit?t=private-token', expires: 'tomorrow' } })),
    acknowledge: vi.fn(async () => {}), unsubscribe: vi.fn(async () => 'https://synthetic.example.test/optout?t=private-optout'),
    send, receipt: vi.fn(async (_s, id) => receipts.get(id) ?? null) };
  const queue = new ApplicationEmailQueues(deps);
  const create = (count = 1, extra = {}) => queue.create(scope, { id: 'reviewed-campaign-request-01', group: 'profile-invitations', entries: Array.from({ length: count }, (_, i) => recipient(i)), ...extra });
  const start = async (count = 1, extra = {}) => { const draft = await create(count, extra); return queue.control(scope, draft.id, 'start', draft.fingerprint); };
  return { queue, deps, send, receipts, create, start, advance: (ms: number) => { now += ms; }, setTime: (value: string) => { now = Date.parse(value); } };
}
describe('shared application email queues', () => {
  it('previews without preparing links, sending or scheduling and survives a new service instance', async () => {
    const ctx = setup(), draft = await ctx.create();
    expect(draft.status).toBe('draft'); expect(ctx.deps.prepare).not.toHaveBeenCalled(); expect(ctx.send).not.toHaveBeenCalled();
    expect((await new ApplicationEmailQueues(ctx.deps).read(scope, draft.id)).fingerprint).toBe(draft.fingerprint);
    expect(scheduledIndexWrites(emailQueuePath(scope, draft.id), undefined, draft)[0]?.data).toBeNull();
    expect((await ctx.create()).id).toBe(draft.id);
  });
  it('schedules the exact reviewed queue atomically and isolates installations', async () => {
    const ctx = setup(), q = await ctx.start();
    expect(scheduledIndexWrites(emailQueuePath(scope, q.id), undefined, q)[0]?.data).toMatchObject({ kind: 'application_email_queue', source: emailQueuePath(scope, q.id) });
    const { id: _derivedId, ...storedData } = q;
    expect(scheduledIndexWrites(emailQueuePath(scope, q.id), undefined, storedData)[0]?.data?.payload).toMatchObject({ queue_id: q.id, installation_id: scope.installationId });
    await expect(ctx.queue.control(scope, q.id, 'start', 'wrong')).rejects.toMatchObject({ status: 409 });
    await expect(ctx.queue.read({ ...scope, installationId: 'other-app' }, q.id)).rejects.toMatchObject({ status: 404 });
    await expect(ctx.create(1, { entries: [{ ...recipient(0), text: 'different' }] })).rejects.toMatchObject({ status: 409 });
  });
  it('continues with no browser, spaces deliveries and shares the rate gate across campaigns', async () => {
    const ctx = setup(), q = await ctx.start(2);
    await new ApplicationEmailQueues(ctx.deps).run(scope, q.id);
    await ctx.queue.run(scope, q.id); expect(ctx.send).toHaveBeenCalledTimes(1);
    ctx.advance(15 * 60_000); await ctx.queue.run(scope, q.id);
    expect(ctx.send).toHaveBeenCalledTimes(2); expect((await ctx.queue.read(scope, q.id)).status).toBe('completed');
  });
  it('stops at the daily cap and resumes on the next UTC day', async () => {
    const ctx = setup(), q = await ctx.start(3, { daily_limit: 2 });
    await ctx.queue.run(scope, q.id); ctx.advance(15 * 60_000); await ctx.queue.run(scope, q.id);
    ctx.advance(15 * 60_000); await ctx.queue.run(scope, q.id); expect(ctx.send).toHaveBeenCalledTimes(2);
    ctx.setTime('2026-11-24T00:00:01Z'); await ctx.queue.run(scope, q.id); expect(ctx.send).toHaveBeenCalledTimes(3);
  });
  it('deduplicates simultaneous workers', async () => {
    const ctx = setup(), q = await ctx.start();
    await Promise.allSettled(Array.from({ length: 5 }, () => ctx.queue.run(scope, q.id)));
    expect(ctx.send).toHaveBeenCalledTimes(1); expect(ctx.deps.prepare).toHaveBeenCalledTimes(1);
  });
  it('pauses, resumes and cancels without sending waiting entries', async () => {
    const ctx = setup(), q = await ctx.start(3);
    await ctx.queue.control(scope, q.id, 'pause', q.fingerprint); await ctx.queue.run(scope, q.id); expect(ctx.send).not.toHaveBeenCalled();
    await ctx.queue.control(scope, q.id, 'resume', q.fingerprint); await ctx.queue.run(scope, q.id);
    await ctx.queue.control(scope, q.id, 'cancel', q.fingerprint); ctx.advance(86_400_000); await ctx.queue.run(scope, q.id);
    expect(ctx.send).toHaveBeenCalledTimes(1); expect((await ctx.queue.read(scope, q.id)).entries.slice(1).map(e => e.status)).toEqual(['cancelled', 'cancelled']);
  });
  it('honors a pause during preparation before any sender request', async () => {
    const ctx = setup(), q = await ctx.start();
    ctx.deps.prepare = async () => { await ctx.queue.control(scope, q.id, 'pause', q.fingerprint); return { values: { link: 'https://synthetic.example.test/edit', expires: 'tomorrow' } }; };
    await ctx.queue.run(scope, q.id); expect(ctx.send).not.toHaveBeenCalled(); expect((await ctx.queue.read(scope, q.id)).status).toBe('paused');
  });
  it('keeps an ambiguous payload encrypted and reconciles acceptance without another POST', async () => {
    const ctx = setup(), q = await ctx.start(), normal = ctx.send.getMockImplementation()!;
    ctx.send.mockImplementation(async (s, intent) => { await normal(s, intent); throw Error('response lost after acceptance'); });
    await ctx.queue.run(scope, q.id);
    const unknown = await ctx.queue.read(scope, q.id);
    expect(unknown.entries[0]?.status).toBe('delivery_unknown');
    expect(unknown.entries[0]?.intent_enc).toBeTruthy(); expect(JSON.stringify(unknown)).not.toContain('private-token');
    expect(JSON.stringify(publicEmailQueue(unknown))).not.toContain('intent_enc');
    await ctx.queue.reconcile(scope, q.id); await ctx.queue.run(scope, q.id);
    expect(ctx.send).toHaveBeenCalledTimes(1); expect((await ctx.queue.read(scope, q.id)).entries[0]?.status).toBe('accepted');
    expect(ctx.deps.acknowledge).toHaveBeenCalledTimes(1);
  });
  it('never replaces a message with an unknown or missing receipt', async () => {
    const ctx = setup(), q = await ctx.start(); ctx.send.mockRejectedValue(Error('timeout'));
    await ctx.queue.run(scope, q.id); const first = await ctx.queue.read(scope, q.id);
    ctx.advance(86_400_000); await ctx.queue.reconcile(scope, q.id); await ctx.queue.run(scope, q.id);
    expect(ctx.send).toHaveBeenCalledTimes(1); expect(ctx.deps.prepare).toHaveBeenCalledTimes(1);
    expect((await ctx.queue.read(scope, q.id)).entries[0]?.intent_enc).toBe(first.entries[0]?.intent_enc);
  });
  it('checks suppression and both shared quotas before creating private links', async () => {
    const ctx = setup(), q = await ctx.start(); ctx.deps.preflight = async () => 'suppressed';
    await ctx.queue.run(scope, q.id); expect(ctx.deps.prepare).not.toHaveBeenCalled(); expect(ctx.send).not.toHaveBeenCalled();
    expect((await ctx.queue.read(scope, q.id)).entries[0]?.status).toBe('suppressed');
    const next = await ctx.start(1, { id: 'another-reviewed-campaign-02' }); ctx.deps.preflight = async () => 'quota';
    await ctx.queue.run(scope, next.id); expect(ctx.deps.prepare).not.toHaveBeenCalled(); expect(ctx.send).not.toHaveBeenCalled();
  });
  it('does not use a removed installation', async () => {
    const ctx = setup(), q = await ctx.start(); ctx.deps.authorize = async () => { throw Error('disabled'); };
    await expect(ctx.queue.run(scope, q.id)).rejects.toThrow('disabled'); expect(ctx.send).not.toHaveBeenCalled();
  });
  it('keeps acknowledgement durable after provider acceptance, including a paused campaign', async () => {
    const ctx = setup(), q = await ctx.start(); ctx.deps.acknowledge = vi.fn(async () => { throw Error('app temporarily offline'); });
    await ctx.queue.run(scope, q.id);
    const accepted = await ctx.queue.read(scope, q.id);
    expect(accepted.entries[0]?.status).toBe('accepted'); expect(accepted.next_at).not.toBeNull();
    ctx.deps.acknowledge = vi.fn(async () => {}); ctx.advance(60_000); await ctx.queue.run(scope, q.id);
    expect(ctx.send).toHaveBeenCalledTimes(1); expect((await ctx.queue.read(scope, q.id)).entries[0]?.acknowledged_status).toBe('accepted');
    expect((await ctx.queue.read(scope, q.id)).next_at).toBeNull();
  });
  it('reuses an exact protected message after a known quota refusal without a fresh private link', async () => {
    const ctx = setup(), q = await ctx.start(); ctx.send.mockRejectedValueOnce(new EmailQueueError('site quota', 429, 'quota'));
    await ctx.queue.run(scope, q.id); const before = (await ctx.queue.read(scope, q.id)).entries[0]?.intent_enc;
    ctx.advance(86_400_000); await ctx.queue.run(scope, q.id);
    expect(ctx.send).toHaveBeenCalledTimes(2); expect(ctx.send.mock.calls[1]![1]).toEqual(ctx.send.mock.calls[0]![1]);
    expect(before).toBeTruthy(); expect(ctx.deps.unsubscribe).toHaveBeenCalledTimes(1);
  });
  it('refuses changed prepared values after a delay instead of replacing the reviewed dispatch', async () => {
    const ctx = setup(), q = await ctx.start(); ctx.send.mockRejectedValueOnce(new EmailQueueError('site quota', 429, 'quota'));
    await ctx.queue.run(scope, q.id); ctx.advance(86_400_000);
    ctx.deps.prepare = async () => ({ values: { link: 'https://synthetic.example.test/edit?t=replacement', expires: 'tomorrow' } });
    await ctx.queue.run(scope, q.id);
    expect(ctx.send).toHaveBeenCalledTimes(1); expect((await ctx.queue.read(scope, q.id)).entries[0]?.status).toBe('excluded');
  });
  it('fences an expired preparation lease before a sender can run', async () => {
    const ctx = setup(), q = await ctx.start();
    ctx.deps.prepare = async () => { ctx.advance(300_001); return { values: { link: 'https://synthetic.example.test/edit?t=stable', expires: 'tomorrow' } }; };
    await ctx.queue.run(scope, q.id); expect(ctx.send).not.toHaveBeenCalled();
  });
  it('cancels a recipient while its app is preparing without submitting the provider request', async () => {
    const ctx = setup(), q = await ctx.start();
    ctx.deps.prepare = async () => { await ctx.queue.cancelEntry(scope, q.id, 'company-0', q.fingerprint); return { values: { link: 'https://synthetic.example.test/edit?t=stable', expires: 'tomorrow' } }; };
    await ctx.queue.run(scope, q.id); expect(ctx.send).not.toHaveBeenCalled(); expect((await ctx.queue.read(scope, q.id)).entries[0]?.status).toBe('cancelled');
  });
});
