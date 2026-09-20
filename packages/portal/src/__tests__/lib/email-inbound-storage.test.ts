import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ send: vi.fn(), options: vi.fn(), destroy: vi.fn() }));
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class { constructor(options: unknown) { mocks.options(options); } send = mocks.send; destroy = mocks.destroy; },
  GetObjectCommand: class { constructor(public input: unknown) {} },
  DeleteObjectCommand: class { constructor(public input: unknown) {} },
}));
import { deleteInboundObject, INBOUND_MAX_BYTES, loadInboundObject } from '../../lib/email/inbound-storage';
const route = { id: 'replies', orgId: 'org', siteId: 'site', installationId: 'core-forwarding', alias: 'replies@mail.example.com',
  target: 'owner@example.net', from: 'notifications@mail.example.com', topic: 'arn:aws:sns:eu-central-1:123456789012:inbound',
  region: 'eu-central-1', bucket: 'private-mail', prefix: 'replies/' };
const event = { mail: { messageId: 'message-1' }, receipt: { action: { type: 'S3', topicArn: route.topic, bucketName: route.bucket, objectKey: 'replies/message-1' } } };
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('EMAIL_SES_INBOUND_STORAGE', JSON.stringify({ access_key_id: 'synthetic', secret_access_key: 'synthetic' })); });
afterEach(() => vi.unstubAllEnvs());
describe('private receiving object adapter', () => {
  it('reads only the approved owner/bucket/key and retains binary MIME bytes', async () => {
    const bytes = Buffer.from([0xff, 0x01, 0x02]); const body = Readable.from([bytes]);
    mocks.send.mockResolvedValue({ ContentLength: 3, Body: body });
    expect(await loadInboundObject(route, event)).toEqual(bytes);
    expect(mocks.send.mock.calls[0]![0].input).toEqual({ Bucket: route.bucket, Key: 'replies/message-1', ExpectedBucketOwner: '123456789012' });
    expect(mocks.options).toHaveBeenCalledWith(expect.objectContaining({ region: 'eu-central-1', credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' } }));
    expect(body.destroyed).toBe(true); expect(mocks.destroy).toHaveBeenCalled();
  });
  it.each(['bucketName', 'objectKey', 'topicArn', 'type'])('rejects an unapproved %s without network access', async field => {
    await expect(loadInboundObject(route, { ...event, receipt: { action: { ...event.receipt.action, [field]: 'wrong' } } })).rejects.toMatchObject({ status: 403 });
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it('enforces advertised and actual stream size limits and closes the stream', async () => {
    const large = Readable.from([Buffer.from('small')]);
    mocks.send.mockResolvedValue({ ContentLength: INBOUND_MAX_BYTES + 1, Body: large });
    await expect(loadInboundObject(route, event)).rejects.toMatchObject({ status: 413 }); expect(large.destroyed).toBe(true);
    const unbounded = Readable.from([Buffer.alloc(INBOUND_MAX_BYTES), Buffer.alloc(1)]);
    mocks.send.mockResolvedValue({ Body: unbounded });
    await expect(loadInboundObject(route, event)).rejects.toMatchObject({ status: 413 }); expect(unbounded.destroyed).toBe(true);
  });
  it('requires a dedicated storage credential instead of falling back to ambient AWS credentials', async () => {
    vi.stubEnv('EMAIL_SES_INBOUND_STORAGE', '{}');
    await expect(loadInboundObject(route, event)).rejects.toMatchObject({ status: 503 }); expect(mocks.send).not.toHaveBeenCalled();
  });
  it('deletes only the same approved object', async () => {
    mocks.send.mockResolvedValue({}); await deleteInboundObject(route, event);
    expect(mocks.send.mock.calls[0]![0].input).toEqual({ Bucket: route.bucket, Key: 'replies/message-1', ExpectedBucketOwner: '123456789012' });
  });
});
