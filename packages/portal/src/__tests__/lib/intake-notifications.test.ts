import { describe, expect, it, vi } from 'vitest';
import { isDeepStrictEqual } from 'node:util';
import { paths } from '@typeroll/shared';
import type { ReadWriteStore } from '../../lib/datastore';
import { DeliveryError } from '../../lib/email/delivery';
import { dispatchIntakeNotifications, intakeNotificationPlan } from '../../lib/forms/intake-notifications';
const scope = { orgId: 'o', siteId: 's', installationId: 'i' }, id = 'a'.repeat(64), path = `${paths.submissions('o', 's')}/${id}`;
function setup() {
  let row: any = { form_id: 'survey', installation_id: 'i', data: { interest: false }, intake: { notifications: { recipient: 'admin@example.invalid', first_answer_field: 'interest' } },
    notifications: { first_answer: { event: 'first_answer', status: 'pending', attempts: 0, subject: 'Private answer', text: 'Interest: No', answer_digest: 'x', created_at: 'test' } } };
  const store = { getDoc: async (key: string) => key === path ? structuredClone(row) : null,
    compareAndReplaceDoc: async (key: string, expected: any, value: any) => { if (key !== path || !isDeepStrictEqual(row, expected)) return false; row = structuredClone(value); return true; },
  } as unknown as ReadWriteStore;
  return { store, read: () => row };
}
describe('private intake notification outbox', () => {
  it('reserves once under concurrency and never sends an accepted milestone again', async () => {
    const ctx = setup(), send = vi.fn(async () => ({ id: 'receipt', status: 'accepted' } as any));
    await Promise.all([1, 2, 3].map(() => dispatchIntakeNotifications(ctx.store, scope, id, { send })));
    await dispatchIntakeNotifications(ctx.store, scope, id, { send, retry: true });
    expect(send).toHaveBeenCalledOnce(); expect(send.mock.calls[0]).toMatchObject([scope, { to: 'admin@example.invalid', text: 'Interest: No' }]);
    expect(ctx.read().notifications.first_answer).toMatchObject({ status: 'accepted', attempts: 1 });
  });
  it('permits an explicit retry only after definite rejection, preserving the saved answer', async () => {
    const ctx = setup(), send = vi.fn().mockRejectedValueOnce(new DeliveryError('not configured', 409)).mockResolvedValue({ id: 'receipt', status: 'accepted' });
    await dispatchIntakeNotifications(ctx.store, scope, id, { send });
    expect(ctx.read().notifications.first_answer.status).toBe('failed');
    await dispatchIntakeNotifications(ctx.store, scope, id, { send }); expect(send).toHaveBeenCalledTimes(1);
    await dispatchIntakeNotifications(ctx.store, scope, id, { send, retry: true });
    expect(send).toHaveBeenCalledTimes(2); expect(ctx.read().data).toEqual({ interest: false });
    expect(send.mock.calls[0]![1].idempotency_key).not.toEqual(send.mock.calls[1]![1].idempotency_key);
  });
  it('does not resend uncertain provider outcomes or reclaim an in-flight send by time', async () => {
    const ctx = setup(), send = vi.fn().mockRejectedValue(new Error('timeout with private details'));
    await dispatchIntakeNotifications(ctx.store, scope, id, { send });
    expect(ctx.read().notifications.first_answer.status).toBe('unknown');
    await dispatchIntakeNotifications(ctx.store, scope, id, { send, retry: true }); expect(send).toHaveBeenCalledOnce();
    ctx.read().notifications.first_answer.status = 'sending';
    ctx.read().notifications.first_answer.updated_at = '2000-01-01';
    await dispatchIntakeNotifications(ctx.store, scope, id, { send, retry: true }); expect(send).toHaveBeenCalledOnce();
    expect(JSON.stringify(ctx.read())).not.toContain('private details');
  });
  it('binds dispatch to the installation and validates private recipient settings', async () => {
    const ctx = setup(), send = vi.fn();
    await expect(dispatchIntakeNotifications(ctx.store, { ...scope, installationId: 'other' }, id, { send })).rejects.toMatchObject({ status: 404 });
    expect(send).not.toHaveBeenCalled();
    expect(() => intakeNotificationPlan({ recipient: 'a@example.invalid\nBcc: b@example.invalid', first_answer_field: 'interest' })).toThrow();
    expect(() => intakeNotificationPlan({ recipient: 'a@example.invalid', first_answer_field: '__proto__' })).toThrow();
  });
});
