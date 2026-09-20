import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ verify: vi.fn(), receive: vi.fn() }));
vi.mock('../../lib/email/ses-events', async importOriginal => ({ ...await importOriginal<object>(), verifySesEnvelope: mocks.verify }));
vi.mock('../../lib/email/inbound', () => ({ inboundRoutes: () => [{ topic: 'approved-topic' }], receiveSesEmail: mocks.receive }));
import { POST } from '../../pages/api/webhooks/email/inbound-ses';
import { DeliveryError } from '../../lib/email/delivery';
import { extensionScopeForApiRequest } from '../../lib/api-auth';
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('EMAIL_SES_INBOUND_ROUTES', 'configured'); });
afterEach(() => vi.unstubAllEnvs());
const post = (body: unknown) => POST({ request: new Request('https://cms.example.test/api/webhooks/email/inbound-ses', { method: 'POST', body: JSON.stringify(body) }) } as never);
describe('incoming webhook trust boundary', () => {
  it('authenticates the envelope before parsing or processing its mail content', async () => {
    mocks.verify.mockRejectedValue(new DeliveryError('Untrusted mail event', 403));
    expect((await post({ Type: 'Notification', Message: 'not json' })).status).toBe(403);
    expect(mocks.receive).not.toHaveBeenCalled();
    expect(mocks.verify).toHaveBeenCalledWith(expect.anything(), ['approved-topic']);
  });
  it('passes only the verified topic and does not leak routing results to a public caller', async () => {
    mocks.verify.mockResolvedValue({ topic: 'approved-topic' });
    mocks.receive.mockResolvedValue({ status: 'forwarded', receipt_id: 'private-receipt', target: 'private@example.test' });
    const response = await post({ Type: 'Notification', TopicArn: 'untrusted-field', Message: '{"notificationType":"Received"}' });
    expect(mocks.receive).toHaveBeenCalledWith('approved-topic', { notificationType: 'Received' });
    expect(await response.json()).toEqual({ received: true });
  });
  it('returns retryable storage failure without acknowledging success', async () => {
    mocks.verify.mockResolvedValue({ topic: 'approved-topic' });
    mocks.receive.mockRejectedValue(new DeliveryError('Reservation busy', 503));
    expect((await post({ Type: 'Notification', Message: '{}' })).status).toBe(503);
  });
  it('has a separate read-only app status scope and no app configuration mutation scope', () => {
    expect(extensionScopeForApiRequest('/api/v1/sites/site/delivery/inbound', 'GET')).toBe('email:inbound:status');
    expect(extensionScopeForApiRequest(`/api/v1/sites/site/delivery/inbound/${'a'.repeat(64)}`, 'GET')).toBe('email:inbound:status');
    expect(extensionScopeForApiRequest('/api/v1/sites/site/delivery/inbound', 'PUT')).toBeNull();
  });
});
