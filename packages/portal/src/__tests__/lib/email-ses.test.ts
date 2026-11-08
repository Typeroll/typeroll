import { afterEach, describe, expect, it, vi } from 'vitest';
import { sesProvider } from '../../lib/email/providers/ses';

const config = { from: 'sender@example.com', values: { region: 'eu-west-1', access_key_id: 'synthetic', secret_access_key: 'synthetic', configuration_set: 'transactional' } };

/** Answers SES's JSON API and records each signed request. */
function ses(answer: () => Response | Promise<Response>) {
  const requests: Array<{ url: string; method: string; authorization: string | null; body: any }> = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push({ url: request.url, method: request.method, authorization: request.headers.get('authorization'), body: JSON.parse(await request.text()) });
    return answer();
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, requests };
}
afterEach(() => vi.unstubAllGlobals());

describe('SES transport', () => {
  it('sends one signed SendEmail request with the fixed sender and a correlation tag', async () => {
    const { requests } = ses(() => Response.json({ MessageId: 'ses-id' }));
    expect(await sesProvider.send(config, { from: config.from, to: 'owner@example.com', text: 'body', subject: 'subject', deliveryId: 'id' })).toEqual({ ok: true, id: 'ses-id' });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ url: 'https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails', method: 'POST' });
    expect(requests[0]!.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=synthetic\/\d{8}\/eu-west-1\/ses\/aws4_request/);
    expect(requests[0]!.body).toMatchObject({ FromEmailAddress: config.from, ConfigurationSetName: 'transactional', EmailTags: [{ Name: 'typeroll_delivery', Value: 'id' }] });
  });

  it.each([
    ['TooManyRequestsException', 'retryable_rejection'], ['MessageRejected', 'rejected'], ['InternalFailure', 'unknown'],
  ])('classifies %s without automatic retries', async (name, failure) => {
    const { fetch } = ses(() => new Response(JSON.stringify({ message: 'private provider payload' }), { status: 400, headers: { 'x-amzn-ErrorType': `${name}:http://internal.amazon.com/coral/` } }));
    const result = await sesProvider.send(config, { from: config.from, to: 'owner@example.com', text: 'body', subject: 'subject' });
    expect(result).toMatchObject({ ok: false, failure });
    expect(result.error).not.toContain('private provider payload');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('treats a timeout as an unknown outcome', async () => {
    ses(() => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); });
    expect(await sesProvider.send(config, { from: config.from, to: 'owner@example.com', text: 'body', subject: 'subject' })).toMatchObject({ ok: false, failure: 'unknown' });
  });

  it('sends a calendar attachment as base64', async () => {
    const { requests } = ses(() => Response.json({ MessageId: 'cal' }));
    await sesProvider.send(config, { from: config.from, to: 'owner@example.com', text: 'body', subject: 'subject', calendar: { filename: 'invite.ics', content: 'BEGIN:VCALENDAR' } } as never);
    expect(requests[0]!.body.Content.Simple.Attachments[0]).toMatchObject({ FileName: 'invite.ics', RawContent: Buffer.from('BEGIN:VCALENDAR').toString('base64') });
  });
});

it('marks forwarded mail to prevent automatic replies without copying original headers', async () => {
  const { requests } = ses(() => Response.json({ MessageId: 'forward' }));
  await sesProvider.send(config, { from: config.from, to: 'owner@example.com', replyTo: 'sender@example.net', subject: 'Fwd: subject', text: 'body', forwarded: true });
  expect(requests[0]!.body).toMatchObject({
    FromEmailAddress: config.from, ReplyToAddresses: ['sender@example.net'],
    Content: { Simple: { Headers: [
      { Name: 'Auto-Submitted', Value: 'auto-generated' },
      { Name: 'X-Auto-Response-Suppress', Value: 'All' },
      { Name: 'X-Typeroll-Forwarded', Value: '1' },
    ] } },
  });
});
