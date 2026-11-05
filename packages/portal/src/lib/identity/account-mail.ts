// Account mail (email confirmation, password reset) through the platform's
// own email provider. ACCOUNT_EMAIL is a secret JSON value:
//   {"type":"postmark","from":"Typeroll <no-reply@typeroll.com>","config":{"server_token":"…"}}
// `type` is any registered provider (postmark, ses, smtp) and `config` holds
// its fields in plain text; it is never written to the store.
//
// Without ACCOUNT_EMAIL, local development prints the link instead of sending
// it; any production-mode server refuses, so a link is never lost silently.

import '../email/providers';
import { getProvider } from '../email/provider';
import type { EmailMessage } from '../email/types';

export interface AccountMail { to: string; subject: string; text: string; html: string }
export type AccountMailSender = (mail: AccountMail) => Promise<void>;

let override: AccountMailSender | null = null;

/** Test-only: capture account mail instead of sending it. */
export function _setAccountMailSenderForTests(sender: AccountMailSender | null): void {
  override = sender;
}

export function isAccountMailConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return !!env.ACCOUNT_EMAIL?.trim();
}

export async function sendAccountMail(mail: AccountMail): Promise<void> {
  if (override) return override(mail);
  const raw = process.env.ACCOUNT_EMAIL?.trim();
  if (!raw) {
    if (process.env.NODE_ENV === 'production') throw new Error('Account email is not configured');
    console.info(`[account-mail] ${mail.subject} → ${mail.to}\n${mail.text}`);
    return;
  }
  const settings = JSON.parse(raw) as { type?: unknown; from?: unknown; reply_to?: unknown; config?: Record<string, unknown> };
  const provider = typeof settings.type === 'string' ? getProvider(settings.type) : undefined;
  if (!provider || typeof settings.from !== 'string' || !settings.from) throw new Error('ACCOUNT_EMAIL needs a known provider type and a From address');
  const values: Record<string, unknown> = {};
  for (const field of provider.fields) values[field.key] = settings.config?.[field.key] ?? field.default ?? '';
  const message: EmailMessage = { from: settings.from, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html };
  const result = await provider.send({ from: settings.from, replyTo: typeof settings.reply_to === 'string' ? settings.reply_to : undefined, values }, message);
  if (!result.ok) throw new Error(`Account email was not accepted: ${result.error ?? 'unknown error'}`);
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function linkMail(to: string, subject: string, intro: string, action: string, url: string, outro: string): AccountMail {
  return {
    to, subject,
    text: `${intro}\n\n${action}: ${url}\n\n${outro}\n`,
    html: `<p>${escapeHtml(intro)}</p><p><a href="${escapeHtml(url)}">${escapeHtml(action)}</a></p><p style="color:#666">${escapeHtml(outro)}</p>`,
  };
}

export function verificationMail(to: string, url: string): AccountMail {
  return linkMail(to, 'Confirm your email address for Typeroll',
    'Confirm that this is your email address to finish setting up your Typeroll account.',
    'Confirm email address', url,
    'The link expires in one hour. If you did not create a Typeroll account, you can ignore this email.');
}

export function passwordResetMail(to: string, url: string): AccountMail {
  return linkMail(to, 'Reset your Typeroll password',
    'Someone asked to reset the password for your Typeroll account.',
    'Choose a new password', url,
    'The link expires in one hour and signs you out everywhere once used. If you did not ask for this, you can ignore this email.');
}
