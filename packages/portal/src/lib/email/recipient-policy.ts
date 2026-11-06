// An installation can restrict every outbound mail to a few recipient domains,
// so a test environment never mails anyone outside them:
//
//   MAIL_ALLOWED_RECIPIENT_DOMAINS=example.com,example.org
//
// Unset means no restriction. Addresses outside the list are removed from
// to/cc/bcc; a message left without a To recipient is not sent at all.

import type { EmailMessage } from './types';

export function allowedRecipientDomains(env: Record<string, string | undefined> = process.env): string[] | null {
  const raw = env.MAIL_ALLOWED_RECIPIENT_DOMAINS?.trim();
  if (!raw) return null;
  return raw.split(',').map(domain => domain.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
}

const domainOf = (address: string) => {
  const bare = address.match(/<([^>]+)>/)?.[1] ?? address;
  const at = bare.lastIndexOf('@');
  return at < 0 ? '' : bare.slice(at + 1).trim().toLowerCase();
};

function keep(list: string | undefined, domains: string[]) {
  const all = (list ?? '').split(',').map(address => address.trim()).filter(Boolean);
  const kept = all.filter(address => domains.includes(domainOf(address)));
  return { kept: kept.length ? kept.join(', ') : undefined, withheld: all.length - kept.length };
}

/** The message with only allowed recipients, or null when no To recipient is allowed. */
export function restrictRecipients<T extends Pick<EmailMessage, 'to' | 'cc' | 'bcc'>>(message: T, env: Record<string, string | undefined> = process.env):
  { message: T | null; withheld: number } {
  const domains = allowedRecipientDomains(env);
  if (!domains) return { message, withheld: 0 };
  const to = keep(message.to, domains), cc = keep(message.cc, domains), bcc = keep(message.bcc, domains);
  const withheld = to.withheld + cc.withheld + bcc.withheld;
  if (!to.kept) return { message: null, withheld };
  const restricted = { ...message, to: to.kept, cc: cc.kept, bcc: bcc.kept };
  if (!cc.kept) delete restricted.cc;
  if (!bcc.kept) delete restricted.bcc;
  return { message: restricted, withheld };
}

export const RECIPIENT_WITHHELD = 'This installation only sends mail to its allowed recipient domains; the message was not sent.';
