// Email provider abstraction + registry.
//
// A provider is self-describing: it declares the config fields it needs (which
// drives encryption, masking, validation, AND the admin UI form) and a send().
// Adding Resend, SES, Mailgun, … later is one file under providers/ plus one
// registration line in providers/index.ts — no changes to the connector data
// model, the dispatch in index.ts, the admin route, or the React form.

import type { EmailMessage, SendResult } from './types';

export type EmailFieldType = 'text' | 'number' | 'boolean' | 'password';

export interface EmailProviderField {
  /** Config key. Secret fields persist as `${key}_enc` (ciphertext). */
  key: string;
  label: string;
  type: EmailFieldType;
  /** Stored encrypted, masked on read, write-only in the UI. */
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  default?: string | number | boolean;
  help?: string;
}

/** Decrypted, ready-to-use config handed to a provider's send(). */
export interface ResolvedEmailConfig {
  from: string;
  replyTo?: string;
  /** Field key → resolved value (secrets decrypted, others as stored). */
  values: Record<string, unknown>;
}

export interface EmailProvider {
  /** Provider id, stored as EmailConnector.type. */
  type: string;
  label: string;
  fields: EmailProviderField[];
  send(config: ResolvedEmailConfig, msg: EmailMessage): Promise<SendResult>;
}

const registry = new Map<string, EmailProvider>();

export function registerProvider(p: EmailProvider): void {
  registry.set(p.type, p);
}
export function getProvider(type: string): EmailProvider | undefined {
  return registry.get(type);
}
export function listProviders(): EmailProvider[] {
  return [...registry.values()];
}

/** UI-safe provider descriptor (schema only, no send fn). */
export interface ProviderDescriptor {
  type: string;
  label: string;
  fields: EmailProviderField[];
}
export function providerDescriptors(): ProviderDescriptor[] {
  return listProviders().map(({ type, label, fields }) => ({ type, label, fields }));
}
