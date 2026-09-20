import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { inboundRoutes, receiveSesEmail, setInboundRoute, siteInboundRoutes, readInboundReceipt } from '../../lib/email/inbound';
import { applyDeliveryEvent } from '../../lib/email/delivery';
const route = { id: 'replies', orgId: 'org', siteId: 'site', installationId: 'core-forwarding',
  alias: 'replies@mail.example.com', target: 'owner@example.net', from: 'notifications@mail.example.com',
  bucket: 'private-inbound', prefix: 'site-replies/', region: 'eu-central-1',
  topic: 'arn:aws:sns:eu-central-1:123456789012:inbound' };
const raw = 'From: Sender <sender@example.org>\r\nTo: replies@mail.example.com\r\nSubject: Private reply\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nPrivate body.';
const event = (content = raw, id = 'ses-one') => ({ notificationType: 'Received', content,
  mail: { messageId: id, timestamp: new Date().toISOString() }, receipt: { recipients: [route.alias], action: { type: 'S3', bucketName: route.bucket, objectKey: `${route.prefix}${id}`, topicArn: route.topic },
    spamVerdict: { status: 'PASS' }, virusVerdict: { status: 'PASS' }, dmarcVerdict: { status: 'PASS' } } });
const remove = vi.fn().mockResolvedValue(undefined);
const send = vi.fn().mockResolvedValue({ ok: true, id: 'outbound-one' });
async function enable() { const [configured] = await siteInboundRoutes(route.orgId, route.siteId); await setInboundRoute(route.orgId, route.siteId, { route_id: route.id, revision: configured!.revision, enabled: true }); }
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore(); send.mockClear(); remove.mockClear(); vi.spyOn(console, 'error').mockImplementation(() => {}); send.mockResolvedValue({ ok: true, id: 'outbound-one' });
  process.env.EMAIL_SES_INBOUND_ROUTES = JSON.stringify([route]);
  await getStore().setDoc(paths.integrations(route.orgId, route.siteId), { email: { type: 'ses', from: `Site <${route.from}>`, config: {} } });
  await enable();
});
afterEach(() => { delete process.env.EMAIL_SES_INBOUND_ROUTES; vi.restoreAllMocks(); });
const receive = (message = event(), topic = route.topic) => receiveSesEmail(topic, message, { send, sleep: async () => {}, load: async (_, event) => Buffer.from(event.content), remove });
describe('approved incoming email forwarding', () => {
  it('forwards text from the site identity with safe reply semantics and exposes delivery events', async () => {
    const result = await receive();
    expect(result.status).toBe('forwarded');
    expect(send).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ to: route.target, from: '', replyTo: 'sender@example.org', forwarded: true, subject: 'Fwd: Private reply', text: expect.stringContaining('Private body.') }));
    const receipt = await readInboundReceipt(route, result.receipt_id!);
    expect(receipt).toMatchObject({ status: 'forwarded', delivery: { status: 'accepted', delivered: false } });
    await applyDeliveryEvent({ id: 'delivery-event', deliveryId: receipt!.delivery!.message_id, providerId: 'outbound-one', provider: 'ses', type: 'delivered', at: new Date().toISOString() });
    expect((await readInboundReceipt(route, result.receipt_id!))!.delivery!.delivered).toBe(true);
    const deliveries = await getStore().listDocs(`${paths.site(route.orgId, route.siteId)}/mail_deliveries`);
    for (const privateValue of [route.alias, route.target, route.from]) expect(JSON.stringify(deliveries)).not.toContain(privateValue);
    expect(remove).not.toHaveBeenCalled(); // Preserve accepted-but-not-delivered mail until lifecycle expiry.
    const stored = await getStore().getDoc(`${paths.site(route.orgId, route.siteId)}/mail_inbound_receipts/${result.receipt_id}`);
    for (const secret of ['Private body.', 'Private reply', 'sender@example.org']) expect(JSON.stringify(stored)).not.toContain(secret);
    expect((await siteInboundRoutes(route.orgId, route.siteId))[0]!.last_receipt).toMatchObject({ receipt_id: result.receipt_id });
  });
  it('sends only once for duplicate and concurrent notifications', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => receive()));
    expect(send).toHaveBeenCalledTimes(1);
    expect(new Set(results.map(r => r.receipt_id)).size).toBe(1);
    expect((await receive()).status).toBe('forwarded');
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('does not acknowledge a distinct notification lost to a quota race', async () => {
    const results = await Promise.allSettled([receive(event(raw, 'one')), receive(event(raw, 'two'))]);
    const rejected = results.filter(r => r.status === 'rejected');
    for (const result of rejected) expect((result as PromiseRejectedResult).reason).toMatchObject({ status: 503 });
    // A provider redelivery can process the message that did not reserve.
    await receive(event(raw, 'one')); await receive(event(raw, 'two'));
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('does not redirect retries when host-approved destinations change', async () => {
    const result = await receive();
    process.env.EMAIL_SES_INBOUND_ROUTES = JSON.stringify([{ ...route, target: 'other@example.net' }]);
    expect((await receive()).status).toBe('disabled');
    await enable();
    expect((await receive()).receipt_id).toBe(result.receipt_id);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('reports unapproved envelope recipients without forwarding their content', async () => {
    expect((await receive(event(), 'arn:aws:sns:eu-central-1:123456789012:other')).status).toBe('ignored');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('incoming_email_unmatched_route'));
    for (const recipients of [['other@example.com'], ['replies+label@mail.example.com'], [route.alias, 'other@example.com']]) {
      const message = event(raw, `recipient-${recipients.length}-${recipients[0]!.startsWith('replies+')}`); message.receipt.recipients = recipients;
      const result = await receive(message);
      expect(result).toMatchObject({ status: 'blocked', reason: 'recipient_not_approved' });
      expect(await readInboundReceipt(route, result.receipt_id!)).toMatchObject({ status: 'blocked', reason: 'recipient_not_approved' });
      await receive(message); // The attention notice is deduplicated too.
    }
    expect(send).toHaveBeenCalledTimes(3);
    for (const [, mail] of send.mock.calls) {
      expect(mail.to).toBe(route.target);
      expect(mail.subject).toBe('Incoming email needs attention');
      expect(mail.text).not.toContain('Private body.');
    }
  });
  it.each(['spamVerdict', 'virusVerdict', 'dmarcVerdict'] as const)('fails closed on a missing or failing %s', async key => {
    const message = event(); message.receipt[key].status = 'FAIL';
    expect(['blocked', 'held']).toContain((await receive(message)).status); expect(send.mock.calls.filter(call => call[1].subject.startsWith('Fwd:'))).toHaveLength(0);
  });
  it.each(['Auto-Submitted: auto-replied', 'X-Typeroll-Forwarded: 1', 'List-Id: list.example.org'])('blocks automatic message %s', async header => {
    expect((await receive(event(`${header}\r\n${raw}`))).status).toBe('blocked'); expect(send.mock.calls.filter(call => call[1].subject.startsWith('Fwd:'))).toHaveLength(0);
  });
  it('does not copy the inbound Reply-To or use a configured alias as sender', async () => {
    await receive(event(`Reply-To: attacker@example.net\r\n${raw}`));
    expect(send.mock.calls[0]![1].replyTo).toBe('sender@example.org');
    send.mockClear();
    expect((await receive(event(raw.replace('sender@example.org', route.alias), 'second'))).status).toBe('blocked');
    expect(send.mock.calls.filter(call => call[1].subject.startsWith('Fwd:'))).toHaveLength(0);
  });
  it('omits attachments and sends no HTML or arbitrary headers', async () => {
    const content = `From: sender@example.org\r\nTo: ${route.alias}\r\nSubject: With attachment\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="parts"\r\n\r\n--parts\r\nContent-Type: text/plain\r\n\r\nSafe text\r\n--parts\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="file.exe"\r\nContent-Transfer-Encoding: base64\r\n\r\nc2VjcmV0\r\n--parts--`;
    expect((await receive(event(content))).status).toBe('forwarded');
    expect(send.mock.calls[0]![1].text).toContain('Attachments were omitted');
    expect(send.mock.calls[0]![1]).not.toHaveProperty('html');
    expect(JSON.stringify(send.mock.calls)).not.toContain('c2VjcmV0');
  });
  it('limits message size and drops stale provider events before storage', async () => {
    expect((await receive(event(raw + 'x'.repeat(11 * 1024 * 1024)))).status).toBe('held');
    const message = event(); message.mail.timestamp = '2020-01-01T00:00:00Z';
    await expect(receive(message)).rejects.toMatchObject({ status: 400 }); expect(send.mock.calls.filter(call => call[1].subject.startsWith('Fwd:'))).toHaveLength(0);
  });
  it('isolates sites and installations and blocks a disabled app', async () => {
    process.env.EMAIL_SES_INBOUND_ROUTES = JSON.stringify([{ ...route, installationId: 'app-one' }]); await enable();
    expect((await receive()).status).toBe('disabled');
    await getStore().setDoc(paths.extensionInstallation(route.orgId, route.siteId, 'app-one'), { status: 'enabled' });
    const result = await receive();
    expect(await readInboundReceipt(route, result.receipt_id!)).toBeNull();
    expect(await siteInboundRoutes(route.orgId, 'other')).toEqual([]);
    expect(await siteInboundRoutes(route.orgId, route.siteId, 'other')).toEqual([]);
    expect((await siteInboundRoutes(route.orgId, route.siteId, 'app-one'))[0]).not.toHaveProperty('target');
  });
  it('does not automatically retry an uncertain forward', async () => {
    send.mockRejectedValue(new Error('untrusted raw secret payload'));
    expect((await receive()).status).toBe('unknown');
    await receive(); expect(send).toHaveBeenCalledTimes(2); // Original attempt and one failure notice, neither replayed.
  });
  it('requires current site consent and rejects cross-site configuration writes', async () => {
    await expect(setInboundRoute(route.orgId, 'other', { route_id: route.id, enabled: true })).rejects.toMatchObject({ status: 404 });
    await expect(setInboundRoute(route.orgId, route.siteId, { route_id: route.id, revision: 'stale', enabled: true })).rejects.toMatchObject({ status: 409 });
  });
  it('rejects host aliases that form a cycle or duplicate route IDs', () => {
    expect(() => inboundRoutes(JSON.stringify([{ ...route, target: route.alias }]))).toThrow('loops');
    expect(() => inboundRoutes(JSON.stringify([route, { ...route, alias: 'other@mail.example.com' }]))).toThrow();
  });
});


it('holds uncertain DMARC without classifying it as malicious and alerts only the approved target', async () => {
  const message = event(); message.receipt.dmarcVerdict.status = 'GRAY';
  const result = await receive(message);
  expect(result).toMatchObject({ status: 'held', reason: 'sender_authentication_unconfirmed' });
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]![1]).toMatchObject({ to: route.target, subject: 'Incoming email needs attention' });
  expect(send.mock.calls[0]![1].text).not.toContain('Private body.');
  expect(remove).not.toHaveBeenCalled();
  expect((await readInboundReceipt(route, result.receipt_id!))!.alert_delivery).toMatchObject({ status: 'accepted' });
});
it('forwards a normal message larger than the former SNS body limit', async () => {
  const content = `From: sender@example.org\r\nSubject: Larger reply\r\nContent-Type: multipart/mixed; boundary="parts"\r\n\r\n--parts\r\nContent-Type: text/plain\r\n\r\nA normal reply.\r\n--parts\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="document.bin"\r\n\r\n${'x'.repeat(250_000)}\r\n--parts--`;
  expect((await receive(event(content))).status).toBe('forwarded');
  expect(send.mock.calls[0]![1].text).toContain('Attachments were omitted');
});
it('rejects an object reference outside the exact site prefix before fetching mail', async () => {
  const message = event(); message.receipt.action.objectKey = 'other-site/secret';
  await expect(receive(message)).rejects.toMatchObject({ status: 403 });
  expect(send).not.toHaveBeenCalled();
});


it.each([true, false])('ignores authenticated SES setup notifications without side effects when enabled=%s', async enabled => {
  const [configured] = await siteInboundRoutes(route.orgId, route.siteId);
  await setInboundRoute(route.orgId, route.siteId, { route_id: route.id, revision: configured!.revision, enabled });
  const message = event('', 'AMAZON_SES_SETUP_NOTIFICATION');
  message.receipt.recipients = ['recipient@example.com'];
  const before = await siteInboundRoutes(route.orgId, route.siteId);
  const load = vi.fn();
  expect(await receiveSesEmail(route.topic, message, { send, load, remove })).toEqual({ status: 'ignored', reason: 'provider_setup_notification' });
  expect(send).not.toHaveBeenCalled(); expect(load).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
  expect(console.error).not.toHaveBeenCalled();
  expect(await siteInboundRoutes(route.orgId, route.siteId)).toEqual(before);
  expect(await getStore().listDocs(`${paths.site(route.orgId, route.siteId)}/mail_inbound_receipts`)).toHaveLength(0);
  expect(await getStore().listDocs(`${paths.site(route.orgId, route.siteId)}/mail_inbound_quotas`)).toHaveLength(0);
});
it('keeps storage isolation and exact message identity for SES setup notifications', async () => {
  const invalid = event('', 'AMAZON_SES_SETUP_NOTIFICATION');
  invalid.receipt.action.objectKey = 'another-route/AMAZON_SES_SETUP_NOTIFICATION';
  await expect(receive(invalid)).rejects.toMatchObject({ status: 403 });
  expect(send).not.toHaveBeenCalled();
  const lookalike = event('', 'AMAZON_SES_SETUP_NOTIFICATION-extra');
  lookalike.receipt.recipients = ['recipient@example.com'];
  expect(await receive(lookalike)).toMatchObject({ status: 'blocked', reason: 'recipient_not_approved' });
  expect(send).toHaveBeenCalledOnce();
});
