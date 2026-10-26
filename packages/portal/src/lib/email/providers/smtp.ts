import nodemailer from 'nodemailer';
import type { EmailProvider } from '../provider';
import type { SendResult } from '../types';
import { OutboundRequestError, privateNetworkFetchAllowed, resolveOutboundAddresses, type OutboundPolicy } from '../../net/safe-fetch';
import { isIpAddressLiteral, isLocalHostname } from '@typeroll/shared';

/**
 * Submission and relay ports only; other services must not be probed through
 * SMTP settings. 2465/2587 are Amazon SES's alternatives where 465/587 are
 * blocked, and 26 is a common relay port on shared hosts.
 */
export const SMTP_ALLOWED_PORTS = [25, 26, 465, 587, 2465, 2525, 2587] as const;

// Self-hosted operators with an intranet relay use the same opt-in as
// migration (TYPEROLL_ALLOW_PRIVATE_NETWORK_FETCH=1).
const SMTP_POLICY: OutboundPolicy = { privateNetwork: 'self_hosted_opt_in', label: 'SMTP host' };

export class SmtpConfigError extends Error {}

export interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
}

/** Static checks shared by save and send: a host name or literal and an allowed port. */
export function validateSmtpSettings(values: Record<string, unknown>): string | null {
  const host = String(values.host ?? '').trim().replace(/^\[|\]$/g, '');
  const port = Number(values.port ?? 587);
  if (!host || host.length > 253 || !/^[a-z0-9.:-]+$/i.test(host)) return 'SMTP host must be a host name';
  if (!(SMTP_ALLOWED_PORTS as readonly number[]).includes(port)) return `SMTP port must be one of ${SMTP_ALLOWED_PORTS.join(', ')}`;
  if (!isIpAddressLiteral(host) && isLocalHostname(host) && !privateNetworkFetchAllowed()) return 'SMTP host must be a public host';
  return null;
}

/**
 * Resolve the SMTP host and require public addresses. Returns the address the
 * connection must use, so DNS cannot change between check and connect.
 */
export async function resolveSmtpHost(host: string): Promise<string> {
  try {
    // Every answer is already public; prefer IPv4, which every relay serves
    // and every runtime can reach.
    const addresses = await resolveOutboundAddresses(host.trim(), SMTP_POLICY);
    return (addresses.find((entry) => entry.family === 4) ?? addresses[0]!).address;
  } catch (error) {
    if (error instanceof OutboundRequestError && error.code === 'dns_failed') throw new SmtpConfigError('SMTP host could not be resolved');
    throw new SmtpConfigError('SMTP host must resolve to a public address');
  }
}

/** Fixed messages per failure class; raw server replies and banners are never returned. */
export function smtpFailureMessage(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  const responseCode = Number((error as { responseCode?: unknown })?.responseCode);
  switch (code) {
    case 'EAUTH': return 'The SMTP server rejected the username or password';
    case 'ETLS': return 'TLS negotiation with the SMTP server failed';
    case 'EENVELOPE': return 'The SMTP server rejected the sender or recipient';
    case 'ECONNECTION':
    case 'ETIMEDOUT':
    case 'ESOCKET':
    case 'EDNS':
    case 'EPROTOCOL':
    case 'EGREETING':
      return 'Could not connect to the SMTP server; check the host, port and TLS setting';
  }
  if (Number.isInteger(responseCode) && responseCode >= 400) return `The SMTP server rejected the message (reply ${responseCode})`;
  return 'SMTP delivery failed';
}

export async function sendViaPinnedSmtp(cfg: SmtpSettings, msg: Parameters<EmailProvider['send']>[1]): Promise<SendResult> {
  const invalid = validateSmtpSettings(cfg as unknown as Record<string, unknown>);
  if (invalid) return { ok: false, failure: 'rejected', error: invalid };
  const host = cfg.host.trim().replace(/^\[|\]$/g, '');
  let address: string;
  try { address = await resolveSmtpHost(host); } catch (error) {
    return { ok: false, failure: 'rejected', error: error instanceof Error ? error.message : 'SMTP host is not allowed' };
  }
  const transport = nodemailer.createTransport({
    host: address,
    port: cfg.port,
    secure: cfg.secure,
    // Certificates are verified against the configured name, not the pinned IP.
    ...(isIpAddressLiteral(host) ? {} : { servername: host }),
    auth: cfg.user ? { user: cfg.user, pass: cfg.password } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  } as Parameters<typeof nodemailer.createTransport>[0]);
  try {
    const info = await transport.sendMail({
      from: msg.from,
      to: msg.to,
      cc: msg.cc || undefined,
      bcc: msg.bcc || undefined,
      replyTo: msg.replyTo || undefined,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
    });
    return { ok: true, id: info.messageId };
  } catch (error) {
    return { ok: false, error: smtpFailureMessage(error) };
  } finally {
    transport.close?.();
  }
}

export const smtpProvider: EmailProvider & { validateConfig: typeof validateSmtpSettings } = {
  type: 'smtp',
  label: 'SMTP',
  validateConfig: validateSmtpSettings,
  fields: [
    { key: 'host', label: 'Host', type: 'text', required: true, placeholder: 'smtp.example.com' },
    { key: 'port', label: 'Port', type: 'number', default: 587, help: `One of ${SMTP_ALLOWED_PORTS.join(', ')}.` },
    { key: 'secure', label: 'TLS on connect (port 465)', type: 'boolean', default: false },
    { key: 'user', label: 'Username', type: 'text' },
    { key: 'password', label: 'Password', type: 'password', secret: true },
  ],
  send(config, msg) {
    return sendViaPinnedSmtp(
      {
        host: String(config.values.host ?? ''),
        port: Number(config.values.port ?? 587),
        secure: Boolean(config.values.secure),
        user: String(config.values.user ?? ''),
        password: String(config.values.password ?? ''),
      },
      msg,
    );
  },
};
