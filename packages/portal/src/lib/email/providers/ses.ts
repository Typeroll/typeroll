import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
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
    const client = new SESv2Client({ region, maxAttempts: 1, credentials: {
      accessKeyId: String(config.values.access_key_id ?? ''),
      secretAccessKey: String(config.values.secret_access_key ?? ''),
    } });
    try {
      const result = await client.send(new SendEmailCommand({
        FromEmailAddress: msg.from,
        Destination: { ToAddresses: [msg.to], ...(msg.cc ? { CcAddresses: msg.cc.split(',').map(s => s.trim()) } : {}),
          ...(msg.bcc ? { BccAddresses: msg.bcc.split(',').map(s => s.trim()) } : {}) },
        ...(msg.replyTo ? { ReplyToAddresses: [msg.replyTo] } : {}),
        ConfigurationSetName: String(config.values.configuration_set ?? ''),
        ...(msg.deliveryId ? { EmailTags: [{ Name: 'typeroll_delivery', Value: msg.deliveryId }] } : {}),
        Content: { Simple: { Subject: { Data: msg.subject, Charset: 'UTF-8' }, Body: {
          ...(msg.text ? { Text: { Data: msg.text, Charset: 'UTF-8' } } : {}),
          ...(msg.html ? { Html: { Data: msg.html, Charset: 'UTF-8' } } : {}),
        } } },
      }), { abortSignal: AbortSignal.timeout(15_000) });
      return result.MessageId ? { ok: true, id: result.MessageId } : { ok: false, failure: 'unknown', error: 'SES acceptance is unknown' };
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'TooManyRequestsException') return { ok: false, failure: 'retryable_rejection', error: 'SES rate limit' };
      const rejected = ['MessageRejected', 'BadRequestException', 'MailFromDomainNotVerifiedException', 'NotFoundException',
        'AccountSuspendedException', 'SendingPausedException', 'AccessDeniedException', 'LimitExceededException'].includes(name);
      return { ok: false, failure: rejected ? 'rejected' : 'unknown', error: rejected ? 'SES rejected the message; check the sender and configuration' : 'SES acceptance is unknown' };
    } finally { client.destroy(); }
  },
};
