import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sign } from 'node:crypto';

const receive = vi.hoisted(() => vi.fn());
vi.mock('astro:middleware', () => ({ defineMiddleware: (handler: unknown) => handler }));
vi.mock('../../lib/load-env', () => ({}));
vi.mock('../../lib/data-schema', () => ({ requireCurrentDataSchema: vi.fn() }));
vi.mock('../../lib/auth', () => ({ getSession: vi.fn(), sessionNeedsRefresh: vi.fn(), refreshSessionForUser: vi.fn() }));
vi.mock('../../lib/email/inbound', () => ({
  inboundRoutes: () => [{ topic: 'arn:aws:sns:eu-central-1:123456789012:incoming' }], receiveSesEmail: receive,
}));
import { onRequest } from '../../middleware';
import { POST } from '../../pages/api/webhooks/email/inbound-ses';

let dir: string, pem: string, key: string;
const topic = 'arn:aws:sns:eu-central-1:123456789012:incoming';
const path = '/api/webhooks/email/inbound-ses';
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'typeroll-inbound-middleware-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=synthetic-sns'], { stdio: 'ignore' });
  key = readFileSync(join(dir, 'key.pem'), 'utf8'); pem = readFileSync(join(dir, 'cert.pem'), 'utf8');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('EMAIL_SES_INBOUND_ROUTES', 'configured');
  vi.stubEnv('SERVICE_ROLE', 'portal');
  vi.stubEnv('DEPLOY_QUEUE', 'cloud_tasks');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(pem)));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function envelope(type = 'Notification') {
  const body: Record<string, string> = { Type: type, Message: '{"notificationType":"Received"}', MessageId: 'event-1',
    Timestamp: new Date().toISOString(), TopicArn: topic, SignatureVersion: '2',
    SigningCertURL: 'https://sns.eu-central-1.amazonaws.com/SimpleNotificationService-middleware.pem' };
  const fields = type === 'Notification' ? ['Message', 'MessageId', 'Timestamp', 'TopicArn', 'Type']
    : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  if (type === 'SubscriptionConfirmation') {
    body.Token = 'synthetic-confirmation'; body.SubscribeURL = 'https://never-follow.example.test/';
  }
  body.Signature = sign('RSA-SHA256', Buffer.from(fields.map(k => `${k}\n${body[k]}\n`).join('')), key).toString('base64');
  return body;
}
async function request(body: unknown, pathname = path) {
  const url = new URL(pathname, 'https://cms.example.test');
  const context = { url, request: new Request(url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(body) }),
    cookies: { get: () => undefined }, locals: {} };
  const next = vi.fn(() => POST(context as never));
  const response = await onRequest(context as never, next as never);
  if (!(response instanceof Response)) throw new Error("Middleware did not return a response");
  return { response, next };
}
describe('incoming SNS requests through portal middleware', () => {
  it('accepts a signed notification without a browser Origin', async () => {
    const { response, next } = await request(envelope());
    expect(response.status).toBe(200); expect(next).toHaveBeenCalledOnce();
    expect(await response.json()).toEqual({ received: true });
    expect(receive).toHaveBeenCalledWith(topic, { notificationType: 'Received' });
  });
  it('confirms a signed subscription through the regional SNS endpoint without Origin', async () => {
    const { response } = await request(envelope('SubscriptionConfirmation'));
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledWith('https://sns.eu-central-1.amazonaws.com/', expect.objectContaining({ method: 'POST', redirect: 'error' }));
    expect(receive).not.toHaveBeenCalled();
  });
  it.each(['signature', 'topic'])('still rejects an invalid %s inside the route', async kind => {
    const body = envelope();
    if (kind === 'signature') body.Message = '{}'; else body.TopicArn += '-unapproved';
    const { response, next } = await request(body);
    expect(next).toHaveBeenCalledOnce(); expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: kind === 'signature' ? 'Invalid mail signature' : 'Untrusted mail event' });
    expect(receive).not.toHaveBeenCalled();
  });
  it.each([`${path}-other`, '/api/sites/site/integrations/inbound-email'])('preserves CSRF for %s', async pathname => {
    const { response, next } = await request({}, pathname);
    expect(response.status).toBe(403); expect(next).not.toHaveBeenCalled();
    expect((await response.json()).error).toContain('CSRF');
  });
});
