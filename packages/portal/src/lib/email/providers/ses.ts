import { AwsClient } from 'aws4fetch';
import type { EmailProvider } from '../provider';

export const sesProvider: EmailProvider = {
  type: 'ses', label: 'Amazon SES',
  fields: [
    { key: 'region', label: 'AWS region', type: 'text', required: true },
    { key: 'access_key_id', label: 'Access key ID', type: 'password', secret: true, required: true },
    { key: 'secret_access_key', label: 'Secret access key', type: 'password', secret: true, required: true },
    { key: 'configuration_set', label: 'Configuration set', type: 'text', required: true,
      help: 'Use a configuration set with delivery, bounce and complaint events enabled.' },
  ],
  async send(config, msg) {
    const region = String(config.values.region ?? '');
    if (!/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region)) return { ok: false, failure: 'rejected', error: 'Invalid SES region' };
    const client = new AwsClient({ service: 'ses', region, retries: 0,
      accessKeyId: String(config.values.access_key_id ?? ''),
      secretAccessKey: String(config.values.secret_access_key ?? ''),
    });
    try {
      // SES v2 SendEmail over its JSON API, signed with SigV4.
      const request = {
        FromEmailAddress: msg.from,
        Destination: { ToAddresses: [msg.to], ...(msg.cc ? { CcAddresses: msg.cc.split(',').map(s => s.trim()) } : {}),
          ...(msg.bcc ? { BccAddresses: msg.bcc.split(',').map(s => s.trim()) } : {}) },
        ...(msg.replyTo ? { ReplyToAddresses: [msg.replyTo] } : {}),
        ConfigurationSetName: String(config.values.configuration_set ?? ''),
        ...(msg.deliveryId ? { EmailTags: [{ Name: 'typeroll_delivery', Value: msg.deliveryId }] } : {}),
        Content: { Simple: { ...(msg.calendar?{Attachments:[{FileName:msg.calendar.filename,RawContent:Buffer.from(msg.calendar.content).toString('base64'),ContentType:'text/calendar; charset=utf-8; method=PUBLISH',ContentDisposition:'ATTACHMENT' as const}]}:{}), ...(msg.forwarded ? { Headers: [
          { Name: 'Auto-Submitted', Value: 'auto-generated' },
          { Name: 'X-Auto-Response-Suppress', Value: 'All' },
          { Name: 'X-Typeroll-Forwarded', Value: '1' },
        ] } : {}), Subject: { Data: msg.subject, Charset: 'UTF-8' }, Body: {
          ...(msg.text ? { Text: { Data: msg.text, Charset: 'UTF-8' } } : {}),
          ...(msg.html ? { Html: { Data: msg.html, Charset: 'UTF-8' } } : {}),
        } } },
      };
      const response = await client.fetch(`https://email.${region}.amazonaws.com/v2/email/outbound-emails`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(15_000),
      });
      const result = await response.json().catch(() => ({})) as { MessageId?: string; __type?: string; code?: string };
      if (!response.ok) throw Object.assign(new Error('SES error'), { name: sesErrorName(response, result) });
      return result.MessageId ? { ok: true, id: result.MessageId } : { ok: false, failure: 'unknown', error: 'SES acceptance is unknown' };
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'TooManyRequestsException') return { ok: false, failure: 'retryable_rejection', error: 'SES rate limit' };
      const rejected = ['MessageRejected', 'BadRequestException', 'MailFromDomainNotVerifiedException', 'NotFoundException',
        'AccountSuspendedException', 'SendingPausedException', 'AccessDeniedException', 'LimitExceededException'].includes(name);
      return { ok: false, failure: rejected ? 'rejected' : 'unknown', error: rejected ? 'SES rejected the message; check the sender and configuration' : 'SES acceptance is unknown' };
    }
  },
};

/** The SES error type: `x-amzn-ErrorType` ("MessageRejected:http://…") or the body's `__type`/`code`. */
function sesErrorName(response: Response, body: { __type?: string; code?: string }): string {
  const raw = response.headers.get('x-amzn-errortype') ?? body.__type ?? body.code ?? `Http${response.status}`;
  return raw.split(':')[0]!.split('#').pop()!;
}
