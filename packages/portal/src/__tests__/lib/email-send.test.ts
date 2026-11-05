import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EmailConnector } from '@typeroll/shared';
import dns from 'node:dns/promises';

import { sendViaConnector } from '../../lib/email';
import { smtpTransport } from '../../lib/email/providers/smtp';
import { encryptSecret } from '../../lib/secret-crypto';
import { fakeSmtp, type FakeSmtpOptions } from '../helpers/fake-smtp';

let server: ReturnType<typeof fakeSmtp>;
const useServer = (options: FakeSmtpOptions = {}) => { server = fakeSmtp(options); smtpTransport.connect = server.connect; return server.state; };

const KEY = 'unit-test-integrations-key-please-change-32+chars';
const msg = { from: 'Site <a@b.com>', to: 'x@y.com', subject: 'Hi', html: '<p>Hi</p>' };

describe('sendViaConnector', () => {
  beforeEach(() => {
    process.env.INTEGRATIONS_SECRET_KEY = KEY;
    useServer();
    vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '203.0.113.25', family: 4 }] as never);
  });
  afterEach(() => {
    delete process.env.INTEGRATIONS_SECRET_KEY;
    smtpTransport.connect = null;
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
    const state = useServer({ password: { user: 'u', password: 'pw' } });
    const res = await sendViaConnector(connector, msg);
    expect(res.ok).toBe(true);
    expect(res.id).toMatch(/^<[0-9a-f-]{36}@b\.com>$/);
    expect(state).toMatchObject({ tls: true, authenticated: true, from: 'a@b.com', recipients: ['x@y.com'], closed: true });
    expect(state.data).toContain('To: x@y.com');
  });

  it('falls back to the connector From and reply_to', async () => {
    const connector: EmailConnector = {
      type: 'smtp',
      from: 'Default <d@b.com>',
      reply_to: 'reply@b.com',
      config: { host: 'smtp.x.com', port: 587, secure: false, user: '', password_enc: '' },
    };
    const state = useServer({ extensions: ['STARTTLS'] });
    await sendViaConnector(connector, { from: '', to: 'x@y.com', subject: 's', text: 't' });
    expect(state.from).toBe('d@b.com');
    expect(state.data).toMatch(/^From: Default <d@b\.com>\r\n/);
    expect(state.data).toContain('\r\nReply-To: reply@b.com\r\n');
    expect(state.authenticated).toBe(false);
  });

  it('connects to the validated host name and verifies TLS against it', async () => {
    const connector: EmailConnector = { type: 'smtp', from: 'a@b.com', config: { host: 'smtp.x.com', port: 587, secure: false, user: '', password_enc: '' } };
    const state = useServer();
    await sendViaConnector(connector, msg);
    expect(state.connects).toEqual([{ hostname: 'smtp.x.com', port: 587, secureTransport: 'starttls' }]);
    expect(state.tlsHostname).toBe('smtp.x.com');
    const implicit = useServer();
    await sendViaConnector({ ...connector, config: { ...connector.config, port: 465, secure: true } }, msg);
    expect(implicit.connects).toEqual([{ hostname: 'smtp.x.com', port: 465, secureTransport: 'on' }]);
    expect(implicit.commands).not.toContain('STARTTLS');
  });

  it.each([
    ['an internal host name', { host: 'smtp.x.com' }, '10.0.0.5', /public address/],
    ['a mapped metadata address', { host: 'smtp.x.com' }, '::ffff:a9fe:a9fe', /public address/],
    ['a loopback literal', { host: '127.0.0.1' }, '203.0.113.25', /public address/],
    ['a non-SMTP port', { host: 'smtp.x.com', port: 6379 }, '203.0.113.25', /port must be one of/],
    ['port 25, which Workers sockets cannot open', { host: 'smtp.x.com', port: 25 }, '203.0.113.25', /port must be one of/],
  ])('refuses %s without connecting', async (_label, config, resolved, error) => {
    vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: resolved, family: resolved.includes(':') ? 6 : 4 }] as never);
    const connector: EmailConnector = { type: 'smtp', from: 'a@b.com', config: { port: 587, secure: false, user: '', password_enc: '', ...config } };
    const res = await sendViaConnector(connector, msg);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(error);
    expect(server.state.connects).toEqual([]);
  });

  it('returns a fixed message instead of the SMTP server reply', async () => {
    useServer({ reply: (command) => command.startsWith('EHLO') ? 'SSH-2.0-OpenSSH_9.6 internal-db-01\r\n' : null });
    const connector: EmailConnector = { type: 'smtp', from: 'a@b.com', config: { host: 'smtp.x.com', port: 587, secure: false, user: '', password_enc: '' } };
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
