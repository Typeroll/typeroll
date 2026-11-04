// Cloudflare Turnstile for a site's forms.
//
// The site administrator creates a Turnstile widget in their own Cloudflare
// account (with the site's hostnames) and stores its site key and secret here.
// Published forms then render the widget and the submit endpoint verifies its
// answer with Cloudflare. The secret is encrypted at rest and never returned.
//
// Pages published before the key was saved carry no widget. A form therefore
// starts in monitor mode: answers are verified when present, and the first
// valid answer proves its pages now carry the widget. From then on that form
// requires an answer. A new site key starts over in monitor mode.

import { paths, type Site } from '@typeroll/shared';
import { getStore } from '../datastore';
import { decryptSecret, encryptSecret, isSecretCryptoConfigured } from '../secret-crypto';

export const TURNSTILE_RESPONSE_FIELD = 'cf-turnstile-response';
export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const KEY_PATTERN = /^[0-9A-Za-z_-]{10,128}$/;
const MAX_RESPONSE_CHARS = 2048;

export interface SiteTurnstile {
  site_key: string;
  secret_encrypted: string;
  updated_at: string;
}

interface FormProtection {
  site_key: string;
  enforced_at: string;
}

export class FormSpamProtectionError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'invalid_spam_protection') { super(message); }
}

const protectionPath = (orgId: string, siteId: string, formId: string) => `${paths.site(orgId, siteId)}/form_protection/${formId}`;

/** The public site key that published forms render, or null when Turnstile is off. */
export function publicTurnstileSiteKey(site: Pick<Site, 'form_turnstile'> | null | undefined): string | null {
  const key = site?.form_turnstile?.site_key;
  return typeof key === 'string' && KEY_PATTERN.test(key) ? key : null;
}

export async function readFormSpamProtection(orgId: string, siteId: string) {
  const store = getStore();
  const site = await store.getDoc<Site>(paths.site(orgId, siteId));
  const config = site?.form_turnstile ?? null;
  const enforced = config
    ? (await store.listDocs<FormProtection & { id: string }>(`${paths.site(orgId, siteId)}/form_protection`))
      .filter(entry => entry.site_key === config.site_key)
      .map(entry => ({ form_id: entry.id, enforced_at: entry.enforced_at }))
    : [];
  return {
    provider: config ? 'turnstile' as const : null,
    site_key: config?.site_key ?? null,
    secret_key: config ? { set: true } : null,
    updated_at: config?.updated_at ?? null,
    crypto_configured: isSecretCryptoConfigured(),
    // Forms whose published pages have returned a valid Turnstile answer. Every
    // other form accepts submissions without one until its pages are republished.
    enforced_forms: enforced,
  };
}

type Verify = 'ok' | 'invalid' | 'unavailable';

/** Ask Cloudflare whether a widget answer is valid. Network or provider failure is 'unavailable', never 'invalid'. */
export async function verifyTurnstileResponse(secret: string, response: string, remoteIp: string | null, fetchImpl: typeof fetch = fetch): Promise<{ result: Verify; codes: string[] }> {
  if (!response || response.length > MAX_RESPONSE_CHARS) return { result: 'invalid', codes: ['invalid-input-response'] };
  const body = new URLSearchParams({ secret, response });
  if (remoteIp) body.set('remoteip', remoteIp);
  try {
    const reply = await fetchImpl(TURNSTILE_VERIFY_URL, { method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(8000) });
    if (!reply.ok) return { result: 'unavailable', codes: [`http_${reply.status}`] };
    const json = await reply.json() as { success?: boolean; 'error-codes'?: unknown };
    const codes = Array.isArray(json['error-codes']) ? json['error-codes'].filter((code): code is string => typeof code === 'string') : [];
    if (json.success === true) return { result: 'ok', codes };
    // Cloudflare's own failure says nothing about the visitor.
    if (codes.includes('internal-error')) return { result: 'unavailable', codes };
    return { result: 'invalid', codes };
  } catch {
    return { result: 'unavailable', codes: ['network'] };
  }
}

export async function saveFormSpamProtection(orgId: string, siteId: string, body: unknown, fetchImpl: typeof fetch = fetch) {
  const input = body as { provider?: unknown; site_key?: unknown; secret_key?: unknown } | null;
  if (!input || typeof input !== 'object') throw new FormSpamProtectionError('Send { provider: "turnstile", site_key, secret_key }.');
  if (input.provider !== 'turnstile') throw new FormSpamProtectionError('provider must be "turnstile".');
  if (typeof input.site_key !== 'string' || !KEY_PATTERN.test(input.site_key.trim())) throw new FormSpamProtectionError('site_key must be the Turnstile widget\'s site key.');
  if (!isSecretCryptoConfigured()) throw new FormSpamProtectionError('This server cannot store secrets (INTEGRATIONS_SECRET_KEY is missing).', 503, 'crypto_not_configured');
  const siteKey = input.site_key.trim();
  const store = getStore();
  const path = paths.site(orgId, siteId);
  const site = await store.getDoc<Site>(path);
  if (!site) throw new FormSpamProtectionError('Site not found.', 404, 'not_found');
  const masked = input.secret_key && typeof input.secret_key === 'object' && (input.secret_key as { set?: unknown }).set === true;
  let secretEncrypted: string;
  if (input.secret_key === undefined || masked) {
    if (!site.form_turnstile || site.form_turnstile.site_key !== siteKey) throw new FormSpamProtectionError('secret_key is required for a new site key.');
    secretEncrypted = site.form_turnstile.secret_encrypted;
  } else {
    if (typeof input.secret_key !== 'string' || !KEY_PATTERN.test(input.secret_key.trim())) throw new FormSpamProtectionError('secret_key must be the Turnstile widget\'s secret key.');
    const secret = input.secret_key.trim();
    // A made-up answer tells a wrong secret apart from a valid one without a visitor.
    const check = await verifyTurnstileResponse(secret, 'typeroll-secret-check', null, fetchImpl);
    if (check.codes.includes('invalid-input-secret')) throw new FormSpamProtectionError('Cloudflare does not recognize this secret key. Copy it again from the Turnstile widget.', 400, 'invalid_turnstile_secret');
    secretEncrypted = encryptSecret(secret);
  }
  const form_turnstile: SiteTurnstile = { site_key: siteKey, secret_encrypted: secretEncrypted, updated_at: new Date().toISOString() };
  await store.updateDoc(path, { form_turnstile });
  return {
    ...(await readFormSpamProtection(orgId, siteId)),
    next_step: 'Publish the site so its forms render the Turnstile widget. Each form starts requiring Turnstile after its first verified submission from the new pages.',
  };
}

export async function removeFormSpamProtection(orgId: string, siteId: string) {
  await getStore().updateDoc(paths.site(orgId, siteId), { form_turnstile: null });
  return readFormSpamProtection(orgId, siteId);
}

export interface SubmissionTurnstile { siteKey: string; secret: string; enforced: boolean }

/** The Turnstile check that applies to one form's submissions, or null when the site has none. */
export async function turnstileForForm(orgId: string, siteId: string, formId: string): Promise<SubmissionTurnstile | null> {
  const store = getStore();
  const site = await store.getDoc<Site>(paths.site(orgId, siteId));
  const config = site?.form_turnstile;
  if (!config?.site_key || !config.secret_encrypted) return null;
  let secret: string;
  try { secret = decryptSecret(config.secret_encrypted); }
  catch (error) {
    console.error(`[forms] Turnstile secret for site ${siteId} cannot be decrypted:`, error instanceof Error ? error.message : error);
    return null;
  }
  const protection = await store.getDoc<FormProtection>(protectionPath(orgId, siteId, formId));
  return { siteKey: config.site_key, secret, enforced: protection?.site_key === config.site_key };
}

/** Called after a valid answer: this form's published pages carry the widget, so it is required from now on. */
export async function enforceTurnstileForForm(orgId: string, siteId: string, formId: string, siteKey: string) {
  await getStore().setDoc(protectionPath(orgId, siteId, formId), { site_key: siteKey, enforced_at: new Date().toISOString() });
}
