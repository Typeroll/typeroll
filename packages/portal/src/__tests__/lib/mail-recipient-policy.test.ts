import { afterEach, expect, it, vi } from 'vitest';
import type { EmailConnector } from '@typeroll/shared';
import { allowedRecipientDomains, restrictRecipients } from '../../lib/email/recipient-policy';
import { sendViaConnector } from '../../lib/email';
import { sendAccountMail, passwordResetMail, _setAccountMailSenderForTests } from '../../lib/identity/account-mail';
import { encryptSecret } from '../../lib/secret-crypto';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); _setAccountMailSenderForTests(null); });

it('reads the allowed recipient domains, and none means no restriction', () => {
  expect(allowedRecipientDomains({})).toBeNull();
  expect(allowedRecipientDomains({ MAIL_ALLOWED_RECIPIENT_DOMAINS: ' Example.com, @example.org ,' })).toEqual(['example.com', 'example.org']);
  const message = { to: 'anyone@elsewhere.test' };
  expect(restrictRecipients(message, {})).toEqual({ message, withheld: 0 });
});

it('keeps only recipients in the allowed domains and drops a message without one', () => {
  const env = { MAIL_ALLOWED_RECIPIENT_DOMAINS: 'example.com' };
  expect(restrictRecipients({ to: 'A <a@example.com>, b@elsewhere.test', cc: 'c@elsewhere.test', bcc: 'd@EXAMPLE.com' }, env))
    .toEqual({ message: { to: 'A <a@example.com>', bcc: 'd@EXAMPLE.com' }, withheld: 2 });
  // A subdomain or a look-alike is not the allowed domain.
  expect(restrictRecipients({ to: 'a@mail.example.com, b@example.com.evil.test', cc: 'c@example.com' }, env)).toEqual({ message: null, withheld: 2 });
});

it('does not send site mail to a recipient outside the allowed domains', async () => {
  vi.stubEnv('MAIL_ALLOWED_RECIPIENT_DOMAINS', 'example.com');
  vi.stubEnv('INTEGRATIONS_SECRET_KEY', 'unit-test-integrations-key-please-change-32+chars');
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ MessageID: 'pm-1', ErrorCode: 0 }) });
  vi.stubGlobal('fetch', fetchMock);
  const connector: EmailConnector = { type: 'postmark', from: 'Site <site@example.org>', config: { server_token_enc: encryptSecret('secret-token') } };
  const refused = await sendViaConnector(connector, { from: '', to: 'visitor@elsewhere.test', subject: 'Hi', text: 'Hi' });
  expect(refused).toMatchObject({ ok: false, failure: 'rejected' });
  expect(fetchMock).not.toHaveBeenCalled();
  const sent = await sendViaConnector(connector, { from: '', to: 'team@example.com', cc: 'visitor@elsewhere.test', subject: 'Hi', text: 'Hi' });
  expect(sent.ok).toBe(true);
  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(body.To).toBe('team@example.com');
  expect(JSON.stringify(body)).not.toContain('elsewhere.test');
});

it('withholds account mail outside the allowed domains without failing the account flow or logging its link', async () => {
  vi.stubEnv('MAIL_ALLOWED_RECIPIENT_DOMAINS', 'example.com');
  const sent: string[] = [];
  _setAccountMailSenderForTests(async mail => { sent.push(mail.to); });
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  await sendAccountMail(passwordResetMail('person@elsewhere.test', 'https://portal.example.com/reset?token=secret-reset-token'));
  await sendAccountMail(passwordResetMail('person@example.com', 'https://portal.example.com/reset?token=allowed'));
  expect(sent).toEqual(['person@example.com']);
  expect(JSON.stringify(info.mock.calls)).not.toContain('secret-reset-token');
  expect(JSON.stringify(info.mock.calls)).not.toContain('elsewhere.test');
});
