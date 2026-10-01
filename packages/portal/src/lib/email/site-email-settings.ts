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

/** A refusal with the HTTP status every surface reports it with. */
export class EmailSettingsError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** The connector (secrets masked), the available providers and whether secrets can be saved. */
export async function readEmailSettings(orgId: string, siteId: string) {
  const doc = await getStore().getDoc<SiteIntegrations>(paths.integrations(orgId, siteId));
  return {
    email: maskConnector(doc?.email),
    providers: providerDescriptors(),
    crypto_configured: isSecretCryptoConfigured(),
  };
}

export interface EmailSettingsInput {
  type?: unknown;
  from?: unknown;
  reply_to?: unknown;
  config?: unknown;
}

/** Validate and store the connector; returns it masked. */
export async function saveEmailSettings(orgId: string, siteId: string, body: EmailSettingsInput | null) {
  if (!isSecretCryptoConfigured()) {
    throw new EmailSettingsError('Email secrets cannot be saved: INTEGRATIONS_SECRET_KEY is not configured on the server.', 503);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new EmailSettingsError('Invalid JSON body', 400);
  const config = body.config ?? {};
  if (typeof config !== 'object' || Array.isArray(config) || config === null) {
    throw new EmailSettingsError('config must be an object of provider fields', 400);
  }
  const store = getStore();
  const path = paths.integrations(orgId, siteId);
  const existing = await store.getDoc<SiteIntegrations>(path);
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
  await store.setDoc(path, {
    ...(existing ?? {}),
    email: connector,
    updated_at: new Date().toISOString(),
  } satisfies SiteIntegrations);
  return { email: maskConnector(connector) };
}

/** Disconnect the connector. Form email actions are skipped until one is configured again. */
export async function removeEmailSettings(orgId: string, siteId: string) {
  const store = getStore();
  const path = paths.integrations(orgId, siteId);
  const existing = await store.getDoc<SiteIntegrations>(path);
  if (!existing?.email) return { removed: false, email: null };
  const { email: _removed, ...rest } = existing;
  await store.setDoc(path, { ...rest, updated_at: new Date().toISOString() } satisfies SiteIntegrations);
  return { removed: true, email: null };
}

/** Send a test message through the stored connector. */
export async function sendTestEmail(orgId: string, site: { id: string; name: string }, input: unknown) {
  const to = String((input as { to?: unknown } | null)?.to ?? '').trim();
  if (!to) throw new EmailSettingsError('A recipient "to" is required for the test', 400);
  const doc = await getStore().getDoc<SiteIntegrations>(paths.integrations(orgId, site.id));
  if (!doc?.email) throw new EmailSettingsError('No email connector configured yet', 400);
  try {
    const res = await sendViaConnector(doc.email, {
      from: doc.email.from,
      to,
      subject: `Test email from ${site.name}`,
      html: `<p>This is a test email from your Typeroll site <strong>${escapeHtml(site.name)}</strong>.</p><p>If you received it, your email connector is working.</p>`,
      text: `Test email from your Typeroll site ${site.name}. If you received it, your email connector is working.`,
    });
    if (!res.ok) throw new EmailSettingsError(res.error ?? 'Send failed', 502);
    return { ok: true as const, id: res.id };
  } catch (error) {
    if (error instanceof EmailSettingsError) throw error;
    throw new EmailSettingsError(error instanceof Error ? error.message : 'Send failed', 502);
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
