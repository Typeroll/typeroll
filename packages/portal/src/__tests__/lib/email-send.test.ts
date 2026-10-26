import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EmailConnector } from '@typeroll/shared';
import dns from 'node:dns/promises';

const sendMailMock = vi.fn();
vi.mock('nodemailer', () => ({
  default: { createTransport: vi.fn(() => ({ sendMail: sendMailMock })) },
}));

import { sendViaConnector } from '../../lib/email';
import { encryptSecret } from '../../lib/secret-crypto';

const KEY = 'unit-test-integrations-key-please-change-32+chars';
const msg = { from: 'Site <a@b.com>', to: 'x@y.com', subject: 'Hi', html: '<p>Hi</p>' };

describe('sendViaConnector', () => {
  beforeEach(() => {
    process.env.INTEGRATIONS_SECRET_KEY = KEY;
    sendMailMock.mockReset();
    sendMailMock.mockResolvedValue({ messageId: 'smtp-1' });
    vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '203.0.113.25', family: 4 }] as never);
  });
  afterEach(() => {
    delete process.env.INTEGRATIONS_SECRET_KEY;
    vi.restoreAllMocks();
  });

  it('sends via Postmark with the decrypted token', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ MessageID: 'pm-1', ErrorCode: 0 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const connector: EmailConnector = {
      type: 'postmark',
      from: 'Site <a@b.com>',
      config: { server_token_enc: encryptSecret('secret-token'), message_stream: 'broadcast' },
    };
    const res = await sendViaConnector(connector, msg);
    expect(res.ok).toBe(true);
    expect(res.id).toBe('pm-1');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain('postmarkapp.com');
    expect((init.headers as Record<string, string>)['X-Postmark-Server-Token']).toBe('secret-token');
    const body = JSON.parse(init.body as string);
    expect(body.MessageStream).toBe('broadcast');
    expect(body.To).toBe('x@y.com');
  });

  it('surfaces a Postmark API error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ ErrorCode: 10, Message: 'bad token' }),
      }),
    );
    const connector: EmailConnector = {
      type: 'postmark',
      from: 'Site <a@b.com>',
      config: { server_token_enc: encryptSecret('t') },
    };
    const res = await sendViaConnector(connector, msg);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('bad token');
  });

  it('sends via SMTP with the decrypted password', async () => {
    const connector: EmailConnector = {
      type: 'smtp',
      from: 'Site <a@b.com>',
      config: { host: 'smtp.x.com', port: 587, secure: false, user: 'u', password_enc: encryptSecret('pw') },
    };
    const res = await sendViaConnector(connector, msg);
    expect(res.ok).toBe(true);
    expect(res.id).toBe('smtp-1');
    expect(sendMailMock).toHaveBeenCalledOnce();
    expect(sendMailMock.mock.calls[0]![0].to).toBe('x@y.com');
  });

  it('falls back to the connector From and reply_to', async () => {
    const connector: EmailConnector = {
      type: 'smtp',
      from: 'Default <d@b.com>',
      reply_to: 'reply@b.com',
      config: { host: 'smtp.x.com', port: 587, secure: false, user: '', password_enc: '' },
    };
    await sendViaConnector(connector, { from: '', to: 'x@y.com', subject: 's', text: 't' });
    const call = sendMailMock.mock.calls[0]![0];
    expect(call.from).toBe('Default <d@b.com>');
    expect(call.replyTo).toBe('reply@b.com');
  });

  it('pins SMTP to the validated public address and verifies TLS against the host name', async () => {
    const nodemailer = (await import('nodemailer')).default as unknown as { createTransport: ReturnType<typeof vi.fn> };
    const connector: EmailConnector = { type: 'smtp', from: 'a@b.com', config: { host: 'smtp.x.com', port: 587, secure: false, user: '', password_enc: '' } };
    await sendViaConnector(connector, msg);
    expect(nodemailer.createTransport).toHaveBeenLastCalledWith(expect.objectContaining({ host: '203.0.113.25', servername: 'smtp.x.com', port: 587 }));
  });

  it.each([
    ['an internal host name', { host: 'smtp.x.com' }, '10.0.0.5', /public address/],
    ['a mapped metadata address', { host: 'smtp.x.com' }, '::ffff:a9fe:a9fe', /public address/],
    ['a loopback literal', { host: '127.0.0.1' }, '203.0.113.25', /public address/],
    ['a non-SMTP port', { host: 'smtp.x.com', port: 6379 }, '203.0.113.25', /port must be one of/],
  ])('refuses %s without connecting', async (_label, config, resolved, error) => {
    vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: resolved, family: resolved.includes(':') ? 6 : 4 }] as never);
    const connector: EmailConnector = { type: 'smtp', from: 'a@b.com', config: { port: 587, secure: false, user: '', password_enc: '', ...config } };
    const res = await sendViaConnector(connector, msg);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(error);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it('returns a fixed message instead of the SMTP server reply', async () => {
    sendMailMock.mockRejectedValue(Object.assign(new Error('Invalid greeting. response=SSH-2.0-OpenSSH_9.6 internal-db-01'), { code: 'EPROTOCOL' }));
    const connector: EmailConnector = { type: 'smtp', from: 'a@b.com', config: { host: 'smtp.x.com', port: 25, secure: false, user: '', password_enc: '' } };
    const res = await sendViaConnector(connector, msg);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('Could not connect to the SMTP server; check the host, port and TLS setting');
    expect(res.error).not.toContain('OpenSSH');
  });

  it('refuses a message with no body', async () => {
    const connector: EmailConnector = { type: 'smtp', from: 'a@b.com', config: { host: 'h', port: 25, secure: false, user: '', password_enc: '' } };
    const res = await sendViaConnector(connector, { from: 'a@b.com', to: 'x@y.com', subject: 's' });
    expect(res.ok).toBe(false);
  });
});
