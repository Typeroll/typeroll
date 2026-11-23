import { readOrganizationAccess } from '../organization-access';
// Site email settings shared by the portal (Settings → Email & notifications), the v1 API and
// MCP: the outgoing email connector used for form notifications, its test
// send, and incoming email forwarding. Each surface checks admin permission
// itself and then calls these functions, so validation, secret handling and
// masking cannot drift between them.
//
// Secrets are encrypted at rest with INTEGRATIONS_SECRET_KEY and never
// returned: reads mask them as `{ set: boolean }`. A write keeps a stored
// secret when the field is omitted or carries the mask.

import { escapeHtml, paths, type SiteIntegrations } from '@typeroll/shared';
import { getStore } from '../datastore';
import { isSecretCryptoConfigured } from '../secret-crypto';
import { providerDescriptors, sendViaConnector } from './index';
import { buildConnector, maskConnector } from './connector-config';
import { DeliveryError } from './delivery';
import { setInboundRoute, siteInboundRoutes } from './inbound';
import { resolveSmtpHost, SmtpConfigError } from './providers/smtp';
import { bulkEmailPolicy, readSiteEmailConfiguration, resolveSiteEmailConnector } from './configuration';

/** A refusal with the HTTP status every surface reports it with. */
export class EmailSettingsError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** The connector (secrets masked), the available providers and whether secrets can be saved. */
export async function readEmailSettings(orgId: string, siteId: string) {
  const configuration = await readSiteEmailConfiguration(orgId, siteId);
  const doc = configuration.document;
  const access = await readOrganizationAccess(orgId);
  return {
    own_smtp_required: access.own_smtp,
    email: configuration.source === 'organization' && configuration.connector ? { type: configuration.connector.type, from: configuration.connector.from, reply_to: configuration.connector.reply_to ?? '', config: {} } : maskConnector(configuration.connector ?? undefined),
    source: configuration.source,
    site_email: maskConnector(doc?.email),
    organization_email: { available: configuration.organization_available, from: configuration.organization_from },
    bulk_email: configuration.policy,
    providers: providerDescriptors().filter(provider => !access.own_smtp || provider.type === 'smtp'),
    crypto_configured: isSecretCryptoConfigured(),
  };
}

export interface EmailSettingsInput {
  source?: unknown;
  bulk_email?: unknown;
  type?: unknown;
  from?: unknown;
  reply_to?: unknown;
  config?: unknown;
}

/** Validate and store the connector; returns it masked. */
export async function saveEmailSettings(orgId: string, siteId: string, body: EmailSettingsInput | null) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new EmailSettingsError('Invalid JSON body', 400);
  if (body.type === undefined && [body.from, body.reply_to, body.config].some(value => value !== undefined)) throw new EmailSettingsError('Supply the provider type when changing account details', 400);
  const store = getStore(), path = paths.integrations(orgId, siteId), existing = await store.getDoc<SiteIntegrations>(path);
  let policy = existing?.bulk_email;
  if (body.bulk_email !== undefined) {
    const input = body.bulk_email as Record<string, unknown> | null;
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['daily_limit', 'minimum_interval_minutes'].includes(key)) ||
        input.daily_limit !== undefined && (!Number.isSafeInteger(input.daily_limit) || Number(input.daily_limit) < 0 || Number(input.daily_limit) > 10000) ||
        input.minimum_interval_minutes !== undefined && (!Number.isSafeInteger(input.minimum_interval_minutes) || Number(input.minimum_interval_minutes) < 1 || Number(input.minimum_interval_minutes) > 1440)) throw new EmailSettingsError('Use a daily campaign limit from 0 to 10000 and a sending interval from 1 to 1440 minutes', 400);
    policy = { ...bulkEmailPolicy(existing?.bulk_email), ...input } as NonNullable<SiteIntegrations['bulk_email']>;
  }
  const source = body.source ?? (body.type === undefined ? existing?.email_source ?? 'site' : 'site');
  if (!['site', 'organization', 'none'].includes(String(source))) throw new EmailSettingsError('Choose a site account or an authorized organization account', 400);
  if (body.source === 'organization' && !(await readSiteEmailConfiguration(orgId, siteId)).organization_available) throw new EmailSettingsError('The organization owner has not allowed this site to use the shared email account', 403);
  if (body.type === undefined) {
    if (body.bulk_email === undefined && body.source === undefined) throw new EmailSettingsError('Supply an email source or campaign sending policy', 400);
    if (!await store.compareAndReplaceDoc(path, existing, { ...(existing ?? {}), email_source: source, ...(policy ? { bulk_email: policy } : {}), updated_at: new Date().toISOString() })) throw new EmailSettingsError('Email settings changed. Reload before saving.', 409);
    return readEmailSettings(orgId, siteId);
  }
  if (source !== 'site') throw new EmailSettingsError('Shared account credentials can only be changed in Organization email settings', 400);
  if (!isSecretCryptoConfigured()) throw new EmailSettingsError('Email secrets cannot be saved: INTEGRATIONS_SECRET_KEY is not configured on the server.', 503);
  if ((await readOrganizationAccess(orgId)).own_smtp && body.type !== 'smtp') throw new EmailSettingsError('During the trial, use your own SMTP account. Form submissions and webhooks work without email.', 400);
  const config = body.config ?? {};
  if (typeof config !== 'object' || Array.isArray(config) || config === null) {
    throw new EmailSettingsError('config must be an object of provider fields', 400);
  }
  let connector;
  try {
    connector = buildConnector(
      String(body.type ?? ''),
      String(body.from ?? ''),
      body.reply_to != null ? String(body.reply_to) : undefined,
      config as Record<string, unknown>,
      existing?.email,
    );
  } catch (error) {
    throw new EmailSettingsError(error instanceof Error ? error.message : 'Failed to encrypt secret', 500);
  }
  if (typeof connector === 'string') throw new EmailSettingsError(connector, 400);
  if (connector.type === 'smtp') {
    // Refuse internal relays up front; sending re-resolves and pins the address.
    try { await resolveSmtpHost(String(connector.config.host ?? '')); } catch (error) {
      throw new EmailSettingsError(error instanceof SmtpConfigError ? error.message : 'SMTP host is not allowed', 400);
    }
  }
  if (!await store.compareAndReplaceDoc(path, existing, {
    ...(existing ?? {}),
    email: connector,
    email_source: 'site',
    ...(policy ? { bulk_email: policy } : {}),
    updated_at: new Date().toISOString(),
  } satisfies SiteIntegrations)) throw new EmailSettingsError('Email settings changed. Reload before saving.', 409);
  return readEmailSettings(orgId, siteId);
}

/** Disconnect the connector. Form email actions are skipped until one is configured again. */
export async function removeEmailSettings(orgId: string, siteId: string) {
  const store = getStore();
  const path = paths.integrations(orgId, siteId);
  const existing = await store.getDoc<SiteIntegrations>(path);
  if (!existing?.email && existing?.email_source !== 'organization') return { removed: false, email: null };
  if (existing.email_source === 'organization') {
    if (!await store.compareAndReplaceDoc(path, existing, { ...existing, email_source: 'none', updated_at: new Date().toISOString() })) throw new EmailSettingsError('Email settings changed. Reload before disconnecting.', 409);
    return { removed: true, email: null };
  }
  const { email: _removed, ...rest } = existing;
  if (!await store.compareAndReplaceDoc(path, existing, { ...rest, email_source: 'none', updated_at: new Date().toISOString() } satisfies SiteIntegrations)) throw new EmailSettingsError('Email settings changed. Reload before disconnecting.', 409);
  return { removed: true, email: null };
}

/** Send a test message through the stored connector. */
export async function sendTestEmail(orgId: string, site: { id: string; name: string }, input: unknown) {
  const to = String((input as { to?: unknown } | null)?.to ?? '').trim();
  if (!to) throw new EmailSettingsError('A recipient "to" is required for the test', 400);
  const connector = await resolveSiteEmailConnector(orgId, site.id);
  if (!connector) throw new EmailSettingsError('No authorized email connector configured yet', 400);
  if ((await readOrganizationAccess(orgId)).own_smtp && connector.type !== 'smtp') throw new EmailSettingsError('Configure your own SMTP account during the trial.', 400);
  try {
    const res = await sendViaConnector(connector, {
      from: connector.from,
      to,
      subject: `Test email from ${site.name}`,
      html: `<p>This is a test email from your Typeroll site <strong>${escapeHtml(site.name)}</strong>.</p><p>If you received it, your email connector is working.</p>`,
      text: `Test email from your Typeroll site ${site.name}. If you received it, your email connector is working.`,
    });
    // Provider errors are fixed, classified messages (no raw transport text).
    if (!res.ok) throw new EmailSettingsError(res.error ?? 'Send failed', 502);
    return { ok: true as const, id: res.id };
  } catch (error) {
    if (error instanceof EmailSettingsError) throw error;
    throw new EmailSettingsError('Send failed', 502);
  }
}

function inboundError(error: unknown, fallback: string): EmailSettingsError {
  return error instanceof DeliveryError
    ? new EmailSettingsError(error.message, error.status)
    : new EmailSettingsError(fallback, 503);
}

/** Host-approved incoming email routes for the site and whether forwarding is enabled. */
export async function readIncomingEmailSettings(orgId: string, siteId: string, installationId?: string) {
  try {
    return { routes: await siteInboundRoutes(orgId, siteId, installationId) };
  } catch (error) {
    throw inboundError(error, 'Incoming email configuration is unavailable');
  }
}

/** Enable or disable forwarding for one approved route revision. */
export async function saveIncomingEmailSetting(orgId: string, siteId: string, body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new EmailSettingsError('Invalid incoming email settings', 400);
  try {
    await setInboundRoute(orgId, siteId, body as Record<string, unknown>);
  } catch (error) {
    throw inboundError(error, 'Could not save incoming email settings');
  }
  return readIncomingEmailSettings(orgId, siteId);
}
