import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ send: vi.fn(), options: vi.fn(), destroy: vi.fn() }));
vi.mock('@aws-sdk/client-sesv2', () => ({
  SESv2Client: class { constructor(options: unknown) { mocks.options(options); } send = mocks.send; destroy = mocks.destroy; },
  SendEmailCommand: class { constructor(public input: unknown) {} },
}));
import { sesProvider } from '../../lib/email/providers/ses';
const config = { from: 'sender@example.com', values: { region: 'eu-west-1', access_key_id: 'synthetic', secret_access_key: 'synthetic', configuration_set: 'transactional' } };
beforeEach(() => vi.clearAllMocks());
describe('SES transport', () => {
  it('uses a single SDK attempt, fixed sender and a correlation tag', async () => {
    mocks.send.mockResolvedValue({ MessageId: 'ses-id' });
    expect(await sesProvider.send(config, { from: config.from, to: 'owner@example.com', text: 'body', subject: 'subject', deliveryId: 'id' })).toEqual({ ok: true, id: 'ses-id' });
    expect(mocks.options).toHaveBeenCalledWith(expect.objectContaining({ maxAttempts: 1 }));
    expect(mocks.send.mock.calls[0]![0].input).toMatchObject({ FromEmailAddress: config.from, ConfigurationSetName: 'transactional', EmailTags: [{ Name: 'typeroll_delivery', Value: 'id' }] });
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
  });
  it.each([['TooManyRequestsException', 'retryable_rejection'], ['MessageRejected', 'rejected'], ['TimeoutError', 'unknown']])('classifies %s without automatic retries', async (name, failure) => {
    mocks.send.mockRejectedValue(Object.assign(new Error('private provider payload'), { name }));
    const result = await sesProvider.send(config, { from: config.from, to: 'owner@example.com', text: 'body', subject: 'subject' });
    expect(result).toMatchObject({ ok: false, failure });
    expect(result.error).not.toContain('private provider payload');
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
});
