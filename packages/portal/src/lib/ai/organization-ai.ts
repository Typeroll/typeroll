// The Organization's own AI key and which of its Sites may use it.
//
// There is no platform-level AI key. An organization owner or admin adds an
// Anthropic API key and chooses its Sites: every Site, including future ones,
// or a list (none until chosen). Everything that calls the model on a Site's
// behalf — the built-in AI assistant and the AI workflows — resolves its
// client here for that Site's OWNER organization. A Site shared into another
// organization therefore uses its owner's key and allowlist.
//
// Never gated on this: MCP, the public API, OAuth connections and API keys.
// External agents use their own model and change content through those.
//
// The key is write-only. It is verified with Anthropic before it is stored,
// sealed with the portal's secret encryption (secret-crypto.ts, bound to the
// organization id like publishing credentials), and only its last four
// characters ever leave the server. Errors and logs never carry it.

import Anthropic from '@anthropic-ai/sdk';
import { paths } from '@typeroll/shared';
import type { AiSiteAccess, OrganizationAiSettings, Site } from '@typeroll/shared';
import { getStore } from '../datastore';
import { decryptSecret, encryptSecret, isSecretCryptoConfigured } from '../secret-crypto';

/** Portal page where an organization owner or admin manages the key. */
export const AI_SETTINGS_PATH = '/app/settings/ai-assistant';

/** Structured refusal code for AI features on a Site without access. */
export const AI_NOT_ENABLED_CODE = 'ai_not_enabled';

export const AI_NOT_ENABLED_MESSAGE =
  'The AI assistant is not enabled for this site. An organization owner or admin can add an Anthropic API key '
  + 'and allow this site under Organization settings → AI assistant. Your own AI agent can still edit the site '
  + 'through MCP or the API.';

const PROVIDER = 'anthropic' as const;
const ANTHROPIC_VERSION = '2023-06-01';
const VERIFY_TIMEOUT_MS = 10_000;
const MAX_SELECTED_SITES = 1000;

export interface AiScope {
  /** Organization that OWNS the Site — never the viewer's organization. */
  orgId: string;
  siteId: string;
}

export interface AiActor {
  /** User id, or `api-key:<prefix>` for an API key. */
  userId: string;
  email?: string;
}

export class AiSettingsError extends Error {
  constructor(message: string, public status = 400, public code?: string) {
    super(message);
    this.name = 'AiSettingsError';
  }
}

/** Thrown by AI helpers when the Site has no AI access. */
export class AiNotEnabledError extends Error {
  readonly code = AI_NOT_ENABLED_CODE;
  constructor() {
    super(AI_NOT_ENABLED_MESSAGE);
    this.name = 'AiNotEnabledError';
  }
}

function anthropicBaseUrl(): string {
  // The Anthropic SDK honours the same variable, so verification and use
  // always talk to the same endpoint (for example a compatible gateway).
  return (process.env.ANTHROPIC_BASE_URL?.trim() || 'https://api.anthropic.com').replace(/\/+$/, '');
}

function seal(orgId: string, apiKey: string): string {
  return encryptSecret(JSON.stringify({ org_id: orgId, provider: PROVIDER, api_key: apiKey }));
}

function open(orgId: string, sealed: string): string | null {
  try {
    const payload = JSON.parse(decryptSecret(sealed)) as { org_id?: string; provider?: string; api_key?: string };
    if (payload.org_id !== orgId || payload.provider !== PROVIDER || typeof payload.api_key !== 'string') return null;
    return payload.api_key;
  } catch {
    return null;
  }
}

function emptySettings(now: string, actor: AiActor): OrganizationAiSettings {
  return {
    provider: PROVIDER,
    encrypted_api_key: null,
    key_last4: null,
    key_set_by: null,
    key_set_by_email: null,
    key_set_at: null,
    key_verified_at: null,
    site_access: { mode: 'selected', site_ids: [] },
    updated_at: now,
    updated_by: actor.userId,
  };
}

export async function readAiSettings(orgId: string): Promise<OrganizationAiSettings | null> {
  return getStore().getDoc<OrganizationAiSettings>(paths.organizationAiSettings(orgId));
}

function normalizedAccess(access: AiSiteAccess | undefined): AiSiteAccess {
  if (access?.mode === 'all') return { mode: 'all', site_ids: [] };
  return { mode: 'selected', site_ids: Array.isArray(access?.site_ids) ? access!.site_ids.filter((id) => typeof id === 'string') : [] };
}

/** Pure check: a stored key, and the Site is covered by the access choice. */
export function settingsAllowSite(settings: OrganizationAiSettings | null, siteId: string): boolean {
  if (!settings?.encrypted_api_key || !siteId) return false;
  const access = normalizedAccess(settings.site_access);
  return access.mode === 'all' || access.site_ids.includes(siteId);
}

/** Whether the built-in AI features are available on a Site. */
export async function isAiEnabledForSite(scope: AiScope): Promise<boolean> {
  return settingsAllowSite(await readAiSettings(scope.orgId), scope.siteId);
}

/** The owner organization's key when this Site may use it; otherwise null. */
export async function resolveAnthropicKey(scope: AiScope): Promise<string | null> {
  const settings = await readAiSettings(scope.orgId);
  if (!settingsAllowSite(settings, scope.siteId)) return null;
  const key = open(scope.orgId, settings!.encrypted_api_key!);
  if (!key) {
    // Typically a changed INTEGRATIONS_SECRET_KEY. The admin re-enters the key.
    console.warn(`[ai] The stored AI key for organization ${scope.orgId} could not be opened; AI stays off until it is saved again.`);
    return null;
  }
  return key;
}

/** Anthropic client for a Site, or null when the Site has no AI access. */
export async function getAnthropicForSite(scope: AiScope): Promise<Anthropic | null> {
  const key = await resolveAnthropicKey(scope);
  return key ? new Anthropic({ apiKey: key }) : null;
}

/** Owner-org check usable when a caller only knows the owner and the Site. */
export async function canUseAiChat(scope: AiScope, permission: 'read' | 'write' | 'admin'): Promise<boolean> {
  if (permission === 'read') return false;
  return isAiEnabledForSite(scope);
}

// ─── Verification ────────────────────────────────────────────────────────

export type KeyVerification =
  | { ok: true }
  | { ok: false; reason: 'rejected' | 'unreachable'; status?: number };

/**
 * Ask Anthropic whether the key authenticates, with the cheapest
 * authenticated request (list one model). 401/403 means the key is wrong;
 * anything else that is not a success means it could not be verified.
 */
export async function verifyAnthropicKey(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<KeyVerification> {
  let response: Response;
  try {
    response = await fetchImpl(`${anthropicBaseUrl()}/v1/models?limit=1`, {
      method: 'GET',
      headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION, accept: 'application/json' },
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
  // The body is not needed and may be large; never echo it either.
  try { await response.body?.cancel(); } catch { /* ignore */ }
  if (response.ok) return { ok: true };
  if (response.status === 401 || response.status === 403) return { ok: false, reason: 'rejected', status: response.status };
  return { ok: false, reason: 'unreachable', status: response.status };
}

function parseApiKey(input: unknown): string {
  const key = typeof input === 'string' ? input.trim() : '';
  if (!key) throw new AiSettingsError('Enter an Anthropic API key.', 400, 'api_key_required');
  if (key.length < 20 || key.length > 512 || /\s|[\x00-\x1f\x7f]/.test(key)) {
    throw new AiSettingsError('This does not look like an Anthropic API key. Copy the whole key from the Anthropic Console; it starts with sk-ant-.', 400, 'api_key_invalid_format');
  }
  return key;
}

// ─── Mutations (owner/admin authorization is the caller's job) ──────────

/**
 * Verify and store the Organization's key. Nothing is stored unless
 * Anthropic accepted the key: a rejected key is refused with
 * `ai_key_rejected`, and when Anthropic cannot be reached the save is
 * refused with `ai_key_unverified` instead of storing an unverified key.
 * Replacing a key keeps the current Site access; a first key starts with no
 * Sites selected.
 */
export async function setAiKey(orgId: string, actor: AiActor, input: unknown, fetchImpl: typeof fetch = fetch): Promise<AiSettingsSummary> {
  const apiKey = parseApiKey(input);
  if (!isSecretCryptoConfigured()) {
    throw new AiSettingsError('This server cannot store secrets yet: INTEGRATIONS_SECRET_KEY is not configured. Ask the server operator to set it.', 503, 'encryption_unavailable');
  }
  const verification = await verifyAnthropicKey(apiKey, fetchImpl);
  if (!verification.ok) {
    if (verification.reason === 'rejected') {
      throw new AiSettingsError('Anthropic rejected this API key. Check that the key is active in the Anthropic Console and copied in full. Nothing was saved.', 422, 'ai_key_rejected');
    }
    throw new AiSettingsError(
      `Anthropic could not be reached to verify the key${verification.status ? ` (HTTP ${verification.status})` : ''}. Nothing was saved. Try again in a moment.`,
      502,
      'ai_key_unverified',
    );
  }
  const now = new Date().toISOString();
  const current = await readAiSettings(orgId);
  const keepAccess = current?.encrypted_api_key ? normalizedAccess(current.site_access) : { mode: 'selected' as const, site_ids: [] };
  const next: OrganizationAiSettings = {
    ...emptySettings(now, actor),
    encrypted_api_key: seal(orgId, apiKey),
    key_last4: apiKey.slice(-4),
    key_set_by: actor.userId,
    key_set_by_email: actor.email || null,
    key_set_at: now,
    key_verified_at: now,
    site_access: keepAccess,
  };
  await getStore().setDoc(paths.organizationAiSettings(orgId), next);
  return aiSettingsSummary(orgId);
}

/** Remove the key. AI turns off on every Site; Site access starts over. */
export async function removeAiKey(orgId: string, actor: AiActor): Promise<AiSettingsSummary> {
  await getStore().setDoc(paths.organizationAiSettings(orgId), emptySettings(new Date().toISOString(), actor));
  return aiSettingsSummary(orgId);
}

/** Parse `{ mode: 'all' }` or `{ mode: 'selected', site_ids: [...] }`. */
export function parseSiteAccess(input: unknown): AiSiteAccess {
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  if (body.mode === 'all') return { mode: 'all', site_ids: [] };
  if (body.mode !== 'selected') {
    throw new AiSettingsError('site_access.mode must be "all" (every Site, including future ones) or "selected".', 400, 'invalid_site_access');
  }
  if (!Array.isArray(body.site_ids) || body.site_ids.some((id) => typeof id !== 'string' || !id.trim())) {
    throw new AiSettingsError('site_ids must be an array of Site ids when mode is "selected".', 400, 'invalid_site_access');
  }
  const ids = [...new Set((body.site_ids as string[]).map((id) => id.trim()))];
  if (ids.length > MAX_SELECTED_SITES) throw new AiSettingsError(`Select at most ${MAX_SELECTED_SITES} Sites, or choose all Sites.`, 400, 'invalid_site_access');
  return { mode: 'selected', site_ids: ids.sort() };
}

/** Choose which of the Organization's own Sites may use its key. */
export async function setAiSiteAccess(orgId: string, actor: AiActor, input: unknown): Promise<AiSettingsSummary> {
  const access = parseSiteAccess(input);
  const current = await readAiSettings(orgId);
  if (!current?.encrypted_api_key) {
    throw new AiSettingsError('Add an Anthropic API key before choosing Sites.', 409, 'ai_key_required');
  }
  if (access.mode === 'selected' && access.site_ids.length) {
    // Only Sites this Organization owns. A Site shared in uses its owner's key.
    const owned = new Set((await getStore().listDocs<Site>(paths.sites(orgId))).map((site) => site.id));
    const unknown = access.site_ids.filter((id) => !owned.has(id));
    if (unknown.length) {
      throw new AiSettingsError(`These are not Sites of this Organization: ${unknown.slice(0, 10).join(', ')}.`, 400, 'unknown_site');
    }
  }
  await getStore().updateDoc(paths.organizationAiSettings(orgId), {
    site_access: access,
    updated_at: new Date().toISOString(),
    updated_by: actor.userId,
  });
  return aiSettingsSummary(orgId);
}

// ─── Public projection ───────────────────────────────────────────────────

export interface AiSettingsSummary {
  provider: 'anthropic';
  configured: boolean;
  /** Masked key metadata. The key itself is never returned. */
  key: {
    last4: string;
    verified: true;
    verified_at: string | null;
    set_at: string | null;
    set_by: string | null;
    set_by_email: string | null;
  } | null;
  site_access: AiSiteAccess;
  /** The Organization's own Sites and whether each has the AI assistant. */
  sites: Array<{ id: string; name: string; ai_enabled: boolean }>;
  encryption_available: boolean;
  settings_path: string;
}

/** The only shape of these settings that may leave the server. */
export async function aiSettingsSummary(orgId: string): Promise<AiSettingsSummary> {
  const settings = await readAiSettings(orgId);
  const configured = Boolean(settings?.encrypted_api_key);
  const sites = await getStore().listDocs<Site>(paths.sites(orgId));
  return {
    provider: PROVIDER,
    configured,
    key: configured ? {
      last4: settings!.key_last4 ?? '',
      verified: true,
      verified_at: settings!.key_verified_at ?? null,
      set_at: settings!.key_set_at ?? null,
      set_by: settings!.key_set_by ?? null,
      set_by_email: settings!.key_set_by_email ?? null,
    } : null,
    site_access: configured ? normalizedAccess(settings!.site_access) : { mode: 'selected', site_ids: [] },
    sites: sites
      .map((site) => ({ id: site.id, name: site.name || site.id, ai_enabled: settingsAllowSite(settings, site.id) }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    encryption_available: isSecretCryptoConfigured(),
    settings_path: AI_SETTINGS_PATH,
  };
}
