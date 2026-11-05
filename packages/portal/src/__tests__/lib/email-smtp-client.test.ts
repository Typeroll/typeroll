import { afterEach, describe, expect, it, vi } from 'vitest';
import dns from 'node:dns/promises';
import { dotStuff, sendSmtpMessage, SmtpError } from '../../lib/email/smtp-client';
import { composeMessage, encodeHeaderValue, quotedPrintable } from '../../lib/email/mime';
import { sendViaSmtp, smtpTransport } from '../../lib/email/providers/smtp';
import { fakeSmtp, type FakeSmtpOptions } from '../helpers/fake-smtp';

const settings = { host: 'smtp.example.test', port: 587, secure: false, user: 'user', password: 'secret' };
const send = (options: FakeSmtpOptions = {}, overrides: Partial<typeof settings> = {}, message = 'Subject: x\r\n\r\nbody\r\n') => {
  const server = fakeSmtp(options);
  return { server, result: sendSmtpMessage({ ...settings, ...overrides, connect: server.connect, timeouts: { commandMs: 200, greetingMs: 200 } },
    { from: 'site@example.com', to: ['a@example.net', 'b@example.net'] }, message) };
};
const decodeQp = (text: string) => new TextDecoder().decode(new Uint8Array([...text.replace(/=\r\n/g, '')
  .replace(/=([0-9A-F]{2})|[\s\S]/g, (match, hex) => String.fromCharCode(hex ? parseInt(hex, 16) : match.charCodeAt(0)))].map((c) => c.charCodeAt(0))));

afterEach(() => { smtpTransport.connect = null; vi.restoreAllMocks(); });

describe('SMTP client', () => {
  it('upgrades with STARTTLS before AUTH PLAIN and sends one dot-stuffed message', async () => {
    const { server, result } = send({}, {}, 'Subject: x\r\n\r\n.leading dot\r\n..two\r\nend\r\n');
    await result;
    expect(server.state.commands).toEqual(['EHLO localhost', 'STARTTLS', 'EHLO localhost', `AUTH PLAIN ${btoa('\0user\0secret')}`,
      'MAIL FROM:<site@example.com>', 'RCPT TO:<a@example.net>', 'RCPT TO:<b@example.net>', 'DATA', 'QUIT']);
    expect(server.state).toMatchObject({ tls: true, tlsHostname: 'smtp.example.test', authenticated: true, closed: true });
    expect(server.state.data).toBe('Subject: x\r\n\r\n..leading dot\r\n...two\r\nend');
  });

  it('falls back to AUTH LOGIN', async () => {
    const { server, result } = send({ extensions: ['STARTTLS', 'AUTH LOGIN'] });
    await result;
    expect(server.state.commands.slice(3, 6)).toEqual(['AUTH LOGIN', btoa('user'), btoa('secret')]);
    expect(server.state.authenticated).toBe(true);
  });

  it('never sends credentials without TLS', async () => {
    const { server, result } = send({ extensions: ['AUTH PLAIN'] });
    await expect(result).rejects.toMatchObject({ code: 'ETLS' });
    expect(server.state.commands.some((command) => command.startsWith('AUTH'))).toBe(false);
    expect(server.state.closed).toBe(true);
  });

  it('sends without TLS only when no credentials are configured', async () => {
    const { server, result } = send({ extensions: [] }, { user: '' });
    await result;
    expect(server.state.tls).toBe(false);
    expect(server.state.recipients).toEqual(['a@example.net', 'b@example.net']);
  });

  it('uses implicit TLS without STARTTLS', async () => {
    const { server, result } = send({}, { port: 465, secure: true });
    await result;
    expect(server.state.connects[0]).toMatchObject({ secureTransport: 'on' });
    expect(server.state.commands).not.toContain('STARTTLS');
  });

  it.each([
    ['a rejected password', { password: { user: 'user', password: 'other' } }, 'EAUTH', 535],
    ['a rejected recipient', { reply: (line: string) => line === 'RCPT TO:<b@example.net>' ? '550 5.1.1 No such user here\r\n' : null }, 'EENVELOPE', 550],
    ['a rejected message', { reply: (line: string) => line === '.' ? '554 5.7.1 Spam\r\n' : null }, 'EMESSAGE', 554],
    ['a temporary failure', { reply: (line: string) => line.startsWith('MAIL') ? '451 4.7.1 Try later\r\n' : null }, 'EENVELOPE', 451],
    ['a non-SMTP service', { reply: (line: string) => line.startsWith('EHLO') ? 'SSH-2.0-OpenSSH\r\n' : null }, 'EPROTOCOL', undefined],
    ['a refused connection', { refuse: true }, 'ECONNECTION', undefined],
    ['no supported sign-in method', { extensions: ['STARTTLS', 'AUTH CRAM-MD5'] }, 'EAUTH_UNSUPPORTED', undefined],
  ])('reports %s with a stable code', async (_label, options, code, responseCode) => {
    const { server, result } = send(options as FakeSmtpOptions);
    const error = await result.catch((value) => value);
    expect(error).toBeInstanceOf(SmtpError);
    expect(error).toMatchObject({ code, responseCode });
    expect(error.message).not.toMatch(/Spam|No such user|OpenSSH/);
    expect(server.state.closed).toBe(true);
  });

  it('marks a connection lost after the message as unconfirmed', async () => {
    const { result } = send({ dropAfterData: true });
    await expect(result).rejects.toMatchObject({ code: 'EUNCONFIRMED' });
  });

  it('times out a silent server', async () => {
    // A reply without a line ending never completes.
    const silent = fakeSmtp({ reply: (line) => line.startsWith('EHLO') ? ' ' : null });
    await expect(sendSmtpMessage({ ...settings, connect: silent.connect, timeouts: { commandMs: 50, greetingMs: 50 } },
      { from: 'site@example.com', to: ['a@example.net'] }, 'x')).rejects.toMatchObject({ code: 'ETIMEDOUT' });
  });

  it('dot-stuffs and normalizes line endings', () => {
    expect(dotStuff('.a\n.b\r\nc.\n..d')).toBe('..a\r\n..b\r\nc.\r\n...d');
  });
});

describe('MIME composition', () => {
  const boundary = (index: number) => `b${index}`;

  it('writes multipart text and HTML with UTF-8 headers and no Bcc header', () => {
    const message = composeMessage({ from: 'Åsa Site <site@example.com>', to: 'a@example.net', cc: 'c@example.net, d@example.net', bcc: 'hidden@example.net',
      replyTo: 'reply@example.com', subject: 'Hej på dig', text: 'Hej på dig — välkommen\n.line', html: '<p>Hej</p>' }, { messageId: '<id@example.com>', boundary, date: new Date('2026-01-02T03:04:05Z') });
    expect(message).toContain('From: =?UTF-8?B?w4VzYSBTaXRl?= <site@example.com>\r\n');
    expect(message).toContain('Cc: c@example.net, d@example.net\r\n');
    expect(message).not.toMatch(/hidden@example\.net/);
    expect(message).toContain('Subject: =?UTF-8?B?SGVqIHDDpSBkaWc=?=\r\n');
    expect(message).toContain('Date: Fri, 02 Jan 2026 03:04:05 +0000\r\n');
    expect(message).toContain('Content-Type: multipart/alternative; boundary="b1"');
    expect(message).not.toMatch(/[^\x00-\x7f]/);
    expect(message.split('\r\n').every((line) => line.length <= 998)).toBe(true);
    const text = message.split('Content-Transfer-Encoding: quoted-printable\r\n\r\n')[1]!.split('\r\n--b1')[0]!;
    expect(decodeQp(text)).toBe('Hej på dig — välkommen\r\n.line');
  });

  it('attaches the calendar and marks forwarded mail as automatic', () => {
    const content = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n';
    const message = composeMessage({ from: 'site@example.com', to: 'a@example.net', subject: 'Event', text: 'See attached',
      calendar: { filename: 'event.ics', content }, forwarded: true }, { messageId: '<id@example.com>', boundary });
    expect(message).toContain('Content-Type: multipart/mixed; boundary="b0"');
    expect(message).toContain('Content-Type: text/calendar; charset=utf-8; method=PUBLISH; name="event.ics"');
    expect(message).toContain('Content-Disposition: attachment; filename="event.ics"');
    expect(message).toContain(btoa(content).slice(0, 40));
    expect(message).toContain('Auto-Submitted: auto-generated\r\nX-Auto-Response-Suppress: All\r\nX-Typeroll-Forwarded: 1\r\n');
  });

  it('cannot inject headers through addresses or the subject', () => {
    const message = composeMessage({ from: 'site@example.com', to: 'a@example.net', replyTo: 'x@example.com\r\nBcc: evil@example.org',
      subject: 'Hi\r\nBcc: evil@example.org', text: 't' }, { messageId: '<id@example.com>', boundary });
    expect(message).not.toMatch(/\r\nBcc:/);
  });

  it('keeps quoted-printable lines short and trailing spaces visible', () => {
    const encoded = quotedPrintable(`${'x'.repeat(200)} \nend`);
    expect(encoded.split('\r\n').every((line) => line.length <= 76)).toBe(true);
    expect(encoded).toContain('=20\r\nend');
    expect(encodeHeaderValue('plain')).toBe('plain');
  });
});

describe('SMTP provider', () => {
  it('validates envelope addresses and records the delivered recipients', async () => {
    vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '203.0.113.25', family: 4 }] as never);
    const server = fakeSmtp(); smtpTransport.connect = server.connect;
    const result = await sendViaSmtp(settings, { from: 'Site <site@example.com>', to: 'a@example.net', bcc: 'b@example.net', subject: 's', text: 't' });
    expect(result).toMatchObject({ ok: true });
    expect(server.state.recipients).toEqual(['a@example.net', 'b@example.net']);
    expect(server.state.commands[0]).toBe('EHLO example.com');
    const invalid = await sendViaSmtp(settings, { from: 'site@example.com', to: 'a@example.net>\r\nDATA', subject: 's', text: 't' });
    expect(invalid).toMatchObject({ ok: false, failure: 'rejected' });
  });

  it('classifies failures for delivery retries', async () => {
    vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '203.0.113.25', family: 4 }] as never);
    const message = { from: 'site@example.com', to: 'a@example.net', subject: 's', text: 't' };
    smtpTransport.connect = fakeSmtp({ reply: (line) => line.startsWith('MAIL') ? '421 4.7.0 Busy\r\n' : null }).connect;
    expect(await sendViaSmtp(settings, message)).toMatchObject({ ok: false, failure: 'retryable_rejection' });
    smtpTransport.connect = fakeSmtp({ dropAfterData: true }).connect;
    expect(await sendViaSmtp(settings, message)).toMatchObject({ ok: false, failure: 'unknown' });
    smtpTransport.connect = fakeSmtp({ password: { user: 'user', password: 'other' } }).connect;
    expect(await sendViaSmtp(settings, message)).toMatchObject({ ok: false, failure: 'rejected', error: 'The SMTP server rejected the username or password' });
  });
});
