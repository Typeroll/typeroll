// GET   /api/v1/sites/{siteId}/settings
// PATCH /api/v1/sites/{siteId}/settings
//
// PATCH whitelists the editable fields. As of the agent-feedback round,
// `scripts_head`, `scripts_body_end`, and `custom_css` are writable here:
// the trust model is the same as user-authored block-type JS — an
// authenticated API caller (Bearer token) takes responsibility for what
// they ship. The chat AI in lib/anthropic.ts continues to NOT expose
// these fields, so a model conversation can't smuggle scripts in.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../lib/api-auth';
import { vstore } from '../../../../../lib/version-store';
import { publicUrlsFor } from '../../../../../lib/site-public-urls';
import { normalizeIframeAllowedHosts, type SiteSettings } from '@typeroll/shared';

const TOP_LEVEL = new Set([
  'site_name', 'tagline', 'logo', 'favicon', 'apple_touch_icon', 'icon_192', 'trailing_slash', 'iframe_allowed_hosts', 'default_seo_suffix',
  'default_meta_description', 'language', 'robots_txt', 'image_sizes_default',
  // Scriptable surfaces. Trusted because the caller has an API key.
  'scripts_head', 'scripts_body_end', 'custom_css',
]);
const NESTED = new Set(['colors', 'fonts', 'contact', 'social', 'cookie_consent']);
const COOKIE_CONSENT_FIELDS = new Set([
  'enabled', 'text', 'privacy_policy_url', 'scripts_necessary',
  'scripts_optional', 'reload_after_consent',
]);

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const s = (await vstore.settings(ctx.orgId, ctx.siteId, ctx.versionId)) ?? {};
  // Return all fields, including scripts_* and custom_css. An authenticated
  // API caller authoring CSS/JS needs to read back what they wrote.
  return apiResponse(ctx, { settings: s, urls: publicUrlsFor(ctx.site) });
};

export const PATCH: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return apiError('Invalid JSON body');
  if (body.trailing_slash !== undefined && !['always', 'never', 'ignore'].includes(String(body.trailing_slash))) {
    return apiError('trailing_slash must be one of: always, never, ignore', 400);
  }
  if (body.iframe_allowed_hosts !== undefined) {
    const checked = normalizeIframeAllowedHosts(body.iframe_allowed_hosts);
    if (checked.invalid.length) return apiError(`Invalid iframe hostnames: ${checked.invalid.join(', ')}`, 400);
    body.iframe_allowed_hosts = checked.hosts;
  }
  if (body.cookie_consent !== undefined) {
    if (!body.cookie_consent || typeof body.cookie_consent !== 'object' || Array.isArray(body.cookie_consent)) {
      return apiError('cookie_consent must be an object', 400);
    }
    const consent = body.cookie_consent as Record<string, unknown>;
    const unknownConsentFields = Object.keys(consent).filter((key) => !COOKIE_CONSENT_FIELDS.has(key));
    if (unknownConsentFields.length) {
      return apiError(`Unknown cookie_consent fields: ${unknownConsentFields.join(', ')}`, 400);
    }
    if (consent.enabled !== undefined && typeof consent.enabled !== 'boolean') {
      return apiError('cookie_consent.enabled must be boolean', 400);
    }
    if (consent.reload_after_consent !== undefined && typeof consent.reload_after_consent !== 'boolean') {
      return apiError('cookie_consent.reload_after_consent must be boolean', 400);
    }
  }

  const existing = ((await vstore.settings(ctx.orgId, ctx.siteId, ctx.versionId)) ?? {}) as Record<string, unknown>;
  const update: Record<string, unknown> = {};
  const unknown_keys: string[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined) continue;
    if (NESTED.has(k) && v && typeof v === 'object') {
      // For contact specifically, the `address` field accepts either a
      // string (legacy) or a PostalAddress object. We pass whatever the
      // caller sent — the renderer + JSON-LD generator branch on the type.
      const before = (existing[k] as Record<string, unknown> | undefined) ?? {};
      update[k] = { ...before, ...(v as Record<string, unknown>) };
    } else if (TOP_LEVEL.has(k)) {
      update[k] = v;
    } else {
      unknown_keys.push(k);
    }
  }
  if (unknown_keys.length > 0 && Object.keys(update).length === 0) {
    // All keys were unknown — almost certainly a schema mistake (e.g. the
    // caller wrapped their fields in {"settings": {...}}). Return 400 so the
    // error is visible instead of silently saving nothing.
    return apiError(
      `No recognized fields in body. Unknown keys: ${unknown_keys.join(', ')}. ` +
      `Top-level fields: ${[...TOP_LEVEL].join(', ')}. ` +
      `Nested objects: ${[...NESTED].join(', ')}.`,
      400,
    );
  }
  await vstore.writeSettings(ctx.orgId, ctx.siteId, ctx.versionId, update as Partial<SiteSettings>);
  const resp: Record<string, unknown> = { ok: true, updated_fields: Object.keys(update) };
  if (unknown_keys.length > 0) {
    resp.warnings = [`Unrecognized keys were ignored: ${unknown_keys.join(', ')}`];
  }
  return apiResponse(ctx, resp, 200, body);
};
