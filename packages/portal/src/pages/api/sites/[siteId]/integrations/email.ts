// Cookie-auth, admin-only: the per-site email connector.
//
// Provider-agnostic: the connector's provider-specific settings live in
// `config`, and encryption / masking / validation are driven by the provider's
// declared field schema (lib/email/providers). Adding a provider needs no
// change here. Secrets are encrypted at rest with INTEGRATIONS_SECRET_KEY and
// never returned in plaintext — GET masks them. This route is the only writer
// of the connector and is NOT exposed on any AI/MCP surface.

import type { APIRoute } from 'astro';
import { requireSiteAccess, requirePermission, json } from '../../../../../lib/access';
import { getStore } from '../../../../../lib/datastore';
import { paths } from '@typeroll/shared';
import type { SiteIntegrations } from '@typeroll/shared';
import { isSecretCryptoConfigured } from '../../../../../lib/secret-crypto';
import { sendViaConnector, providerDescriptors } from '../../../../../lib/email';
import { buildConnector, maskConnector } from '../../../../../lib/email/connector-config';

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const adminCheck = requirePermission(guard.value, 'admin');
  if (!adminCheck.ok) return adminCheck.response;
  const { site, owner_org_id } = guard.value;
  const doc = await getStore().getDoc<SiteIntegrations>(paths.integrations(owner_org_id, site.id));
  return json({
    email: maskConnector(doc?.email),
    providers: providerDescriptors(),
    crypto_configured: isSecretCryptoConfigured(),
  });
};

interface PutBody {
  type?: string;
  from?: string;
  reply_to?: string;
  config?: Record<string, unknown>;
}

export const PUT: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const adminCheck = requirePermission(guard.value, 'admin');
  if (!adminCheck.ok) return adminCheck.response;
  const { site, owner_org_id } = guard.value;

  if (!isSecretCryptoConfigured()) {
    return json({ error: 'Email secrets cannot be saved: INTEGRATIONS_SECRET_KEY is not configured on the server.' }, 503);
  }

  const body = (await request.json().catch(() => null)) as PutBody | null;
  if (!body) return json({ error: 'Invalid JSON body' }, 400);

  const store = getStore();
  const existing = await store.getDoc<SiteIntegrations>(paths.integrations(owner_org_id, site.id));
  let connector;
  try {
    connector = buildConnector(
      String(body.type ?? ''),
      String(body.from ?? ''),
      body.reply_to != null ? String(body.reply_to) : undefined,
      body.config ?? {},
      existing?.email,
    );
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Failed to encrypt secret' }, 500);
  }
  if (typeof connector === 'string') return json({ error: connector }, 400);

  await store.setDoc(paths.integrations(owner_org_id, site.id), {
    ...(existing ?? {}),
    email: connector,
    updated_at: new Date().toISOString(),
  } satisfies SiteIntegrations);
  return json({ email: maskConnector(connector) });
};

// POST ?test=1 → send a test email to `to` using the stored connector.
export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const adminCheck = requirePermission(guard.value, 'admin');
  if (!adminCheck.ok) return adminCheck.response;
  const { site, owner_org_id } = guard.value;

  const body = (await request.json().catch(() => null)) as { to?: string } | null;
  const to = String(body?.to ?? '').trim();
  if (!to) return json({ error: 'A recipient "to" is required for the test' }, 400);

  const doc = await getStore().getDoc<SiteIntegrations>(paths.integrations(owner_org_id, site.id));
  if (!doc?.email) return json({ error: 'No email connector configured yet' }, 400);

  try {
    const res = await sendViaConnector(doc.email, {
      from: doc.email.from,
      to,
      subject: `Test email from ${site.name}`,
      html: `<p>This is a test email from your Typeroll site <strong>${site.name}</strong>.</p><p>If you received it, your email connector is working.</p>`,
      text: `Test email from your Typeroll site ${site.name}. If you received it, your email connector is working.`,
    });
    if (!res.ok) return json({ error: res.error ?? 'Send failed' }, 502);
    return json({ ok: true, id: res.id });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Send failed' }, 502);
  }
};
