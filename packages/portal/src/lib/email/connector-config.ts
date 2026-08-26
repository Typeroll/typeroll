// Generic, provider-agnostic connector config handling. Drives encryption,
// masking, and decryption purely from a provider's declared field schema, so
// none of this needs to change when a new provider is added.

import type { EmailConnector } from '@typeroll/shared';
import { encryptSecret, decryptSecret, SECRET_MASK } from '../secret-crypto';
import { getProvider, type ResolvedEmailConfig } from './provider';
import './providers'; // ensure built-in providers are registered

/** A submitted secret is "new" only when it's a real value, not the echoed mask. */
function isNewSecret(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v !== SECRET_MASK;
}

/**
 * Build a stored EmailConnector from UI input, encrypting new secrets and
 * preserving unchanged ones (when the client re-sends the mask sentinel or
 * omits the field). Returns the connector or a validation-error string.
 */
export function buildConnector(
  type: string,
  from: string,
  replyTo: string | undefined,
  incoming: Record<string, unknown>,
  existing: EmailConnector | undefined,
): EmailConnector | string {
  const provider = getProvider(type);
  if (!provider) return `Unknown email provider "${type}"`;
  if (!from.trim()) return 'A "from" address is required';

  const config: Record<string, unknown> = {};
  for (const f of provider.fields) {
    const raw = incoming[f.key];
    if (f.secret) {
      const encKey = `${f.key}_enc`;
      if (isNewSecret(raw)) config[encKey] = encryptSecret(raw);
      else if (existing?.config?.[encKey] !== undefined) config[encKey] = existing.config[encKey];
      if (f.required && config[encKey] === undefined) return `${f.label} is required`;
    } else {
      let v: unknown = raw;
      if (f.type === 'number') v = raw === '' || raw == null ? f.default : Number(raw);
      else if (f.type === 'boolean') v = Boolean(raw);
      if (f.required && (v === undefined || v === null || v === '')) return `${f.label} is required`;
      if (v !== undefined) config[f.key] = v;
    }
  }

  const connector: EmailConnector = { type, from: from.trim(), config };
  if (replyTo && replyTo.trim()) connector.reply_to = replyTo.trim();
  return connector;
}

export interface MaskedConnector {
  type: string;
  from: string;
  reply_to: string;
  /** field key → raw value (non-secret) or { set: boolean } (secret). */
  config: Record<string, unknown>;
}

/** Connector → UI-safe shape: never includes ciphertext or plaintext secrets. */
export function maskConnector(c: EmailConnector | undefined): MaskedConnector | null {
  if (!c) return null;
  const provider = getProvider(c.type);
  const config: Record<string, unknown> = {};
  for (const f of provider?.fields ?? []) {
    if (f.secret) config[f.key] = { set: Boolean(c.config?.[`${f.key}_enc`]) };
    else config[f.key] = c.config?.[f.key] ?? '';
  }
  return { type: c.type, from: c.from, reply_to: c.reply_to ?? '', config };
}

/** Connector → decrypted config for sending. Throws if a secret can't decrypt. */
export function resolveConnector(c: EmailConnector): ResolvedEmailConfig | string {
  const provider = getProvider(c.type);
  if (!provider) return `Unknown email provider "${c.type}"`;
  const values: Record<string, unknown> = {};
  for (const f of provider.fields) {
    if (f.secret) {
      const enc = c.config?.[`${f.key}_enc`];
      values[f.key] = typeof enc === 'string' && enc ? decryptSecret(enc) : '';
    } else {
      values[f.key] = c.config?.[f.key] ?? f.default ?? '';
    }
  }
  return { from: c.from, replyTo: c.reply_to, values };
}
