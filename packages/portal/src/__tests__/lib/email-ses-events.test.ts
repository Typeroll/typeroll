import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sign } from 'node:crypto';
import { verifySesEnvelope } from '../../lib/email/ses-events';

let dir: string, pem: string, key: string;
const topic = 'arn:aws:sns:eu-west-1:123456789012:transactional';
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'typeroll-sns-test-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=synthetic-sns'], { stdio: 'ignore' });
  key = readFileSync(join(dir, 'key.pem'), 'utf8'); pem = readFileSync(join(dir, 'cert.pem'), 'utf8');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
function envelope() {
  const body: Record<string, string> = { Type: 'Notification', Message: '{"eventType":"Delivery"}', MessageId: 'event-1',
    Timestamp: new Date().toISOString(), TopicArn: topic, SignatureVersion: '2',
    SigningCertURL: 'https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-test.pem' };
  const bytes = ['Message', 'MessageId', 'Timestamp', 'TopicArn', 'Type'].map(k => `${k}\n${body[k]}\n`).join('');
  body.Signature = sign('RSA-SHA256', Buffer.from(bytes), key).toString('base64');
  return body;
}
describe('SNS event authentication', () => {
  it('verifies a real signature and rejects a changed payload', async () => {
    const body = envelope();
    await expect(verifySesEnvelope(body, [topic], async () => pem)).resolves.toMatchObject({ topic });
    await expect(verifySesEnvelope({ ...body, Message: 'changed' }, [topic], async () => pem)).rejects.toMatchObject({ status: 403 });
  });
  it.each(['http://sns.eu-west-1.amazonaws.com/SimpleNotificationService-test.pem',
    'https://sns.eu-west-1.amazonaws.com.attacker.example/SimpleNotificationService-test.pem',
    'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-test.pem',
    'https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-test.pem?redirect=evil',
    'https://127.0.0.1/SimpleNotificationService-test.pem'])('rejects %s before fetching a key', async url => {
    const load = vi.fn();
    await expect(verifySesEnvelope({ ...envelope(), SigningCertURL: url }, [topic], load)).rejects.toMatchObject({ status: 403 });
    expect(load).not.toHaveBeenCalled();
  });
  it('rejects an unconfigured topic and subscription type before certificate access', async () => {
    const load = vi.fn();
    await expect(verifySesEnvelope(envelope(), [], load)).rejects.toMatchObject({ status: 403 });
    await expect(verifySesEnvelope({ ...envelope(), Type: 'UnsubscribeConfirmation' }, [topic], load)).rejects.toMatchObject({ status: 403 });
    expect(load).not.toHaveBeenCalled();
  });
});

it('bounds streamed UTF-8 event bytes without trusting Content-Length', async () => {
  const { readMailPayload } = await import('../../lib/email/ses-events');
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('å'.repeat(10))); }, cancel });
  await expect(readMailPayload(new Response(stream), 12)).rejects.toMatchObject({ status: 413 });
  expect(cancel).toHaveBeenCalledOnce();
  expect(await readMailPayload(new Response('å'), 2)).toBe('å');
  await expect(readMailPayload(new Response('a',{headers:{'content-length':'200'}}), 12)).rejects.toMatchObject({status:413});
});
