// GET   /api/v1/sites/{siteId}/settings
// PATCH /api/v1/sites/{siteId}/settings
//
// PATCH whitelists the editable fields and accepts everything the portal's
// Settings form does (/api/sites/{siteId}/settings), with the same admin
// permission. `scripts_head`, `scripts_body_end`, `custom_css` and the
// cookie-consent scripts are writable here: an authenticated API caller
// (Bearer token) takes responsibility for what they ship, exactly as a site
// admin does in the portal. The chat AI in lib/anthropic.ts does not expose
// these fields.
//
// `staging_url` is stored on the Site document, not in versioned settings, so
// a branch cannot reroute it; it is written the same way whichever `?version=`
// the request names.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../lib/api-auth';
import { vstore } from '../../../../../lib/version-store';
import { publicUrlsFor } from '../../../../../lib/site-public-urls';
import { libraryProblems, readStyles } from '../../../../../lib/site-styles-store';
import { customCssWarnings, customCssWriteError } from '../../../../../lib/custom-css-write';
import { getStore } from '../../../../../lib/datastore';
import { normalizeStagingUrl, normalizeTwitterHandle, parseOrganizationInput } from '../../../../../lib/site-settings-fields';
import { responsiveBreakpointsError, seoReviewError, normalizeIframeAllowedHosts, renderVersionStatus, isRenderVersion, LATEST_RENDER_VERSION, paths, type SiteSettings } from '@typeroll/shared';

const TOP_LEVEL = new Set([
  'responsive_breakpoints', 'site_name', 'tagline', 'logo', 'favicon', 'apple_touch_icon', 'icon_192', 'trailing_slash', 'iframe_allowed_hosts', 'default_seo_suffix',
  'default_meta_description', 'language', 'robots_txt', 'image_sizes_default',
  'sitewide_noindex', 'sitewide_nofollow', 'seo_review', 'render_version',
  // Social sharing + Organization JSON-LD, as in the portal Settings form.
  'default_og_image', 'twitter_handle', 'organization',
  // Scriptable surfaces. Trusted because the caller has an API key.
  'scripts_head', 'scripts_body_end', 'custom_css',
]);
/** Fields stored on the Site document rather than in versioned settings. */
const SITE_LEVEL = new Set(['staging_url']);
/** Optional string fields where an empty string clears the value. */
const CLEARABLE_STRINGS = ['default_og_image', 'twitter_handle'] as const;
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
  return apiResponse(ctx, { settings: s, urls: publicUrlsFor(ctx.site), render: renderVersionStatus((s as SiteSettings).render_version) });
};

export const PATCH: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  // Same role as the portal Settings form, render-version and custom-CSS routes.
  if (ctx.permission !== 'admin') return apiError('Insufficient permission (admin required)', 403, ctx);
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return apiError('Invalid JSON body');
  for (const key of CLEARABLE_STRINGS) {
    if (body[key] === undefined) continue;
    if (body[key] !== null && typeof body[key] !== 'string') return apiError(`${key} must be a string`, 400);
    const value = String(body[key] ?? '').trim();
    // An empty value clears the field, as in the portal form. null keeps the
    // key present so it is reported in updated_fields.
    body[key] = (key === 'twitter_handle' ? normalizeTwitterHandle(value) : value || undefined) ?? null;
  }
  if (body.organization !== undefined) {
    const parsed = parseOrganizationInput(body.organization);
    if (!parsed.ok) return apiError(parsed.error, 400);
    body.organization = parsed.organization ?? null;
  }
  let stagingUrl: string | null | undefined;
  if (body.staging_url !== undefined) {
    if (body.staging_url !== null && typeof body.staging_url !== 'string') {
      return apiError('staging_url must be a URL string, or null to clear it', 400);
    }
    stagingUrl = normalizeStagingUrl(String(body.staging_url ?? ''));
  }
  if (body.responsive_breakpoints !== undefined) { const error = responsiveBreakpointsError(body.responsive_breakpoints); if (error) return apiError(error, 400); }
  if (body.trailing_slash !== undefined && !['always', 'never', 'ignore'].includes(String(body.trailing_slash))) {
    return apiError('trailing_slash must be one of: always, never, ignore', 400);
  }
  if (body.sitewide_noindex !== undefined && typeof body.sitewide_noindex !== 'boolean') {
    return apiError('sitewide_noindex must be boolean', 400);
  }
  if (body.sitewide_nofollow !== undefined && typeof body.sitewide_nofollow !== 'boolean') return apiError('sitewide_nofollow must be boolean', 400);
  if (body.seo_review !== undefined) { const error = seoReviewError(body.seo_review); if (error) return apiError(error, 400); }
  if (body.render_version !== undefined && !isRenderVersion(body.render_version)) {
    return apiError(`render_version must be an integer from 1 to ${LATEST_RENDER_VERSION}`, 400);
  }
  { const error = customCssWriteError(body.custom_css); if (error) return apiError(error, 400); }
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
      // null clears an optional field; the store drops undefined values.
      update[k] = v === null && (CLEARABLE_STRINGS as readonly string[]).concat('organization').includes(k) ? undefined : v;
    } else if (SITE_LEVEL.has(k)) {
      continue;
    } else {
      unknown_keys.push(k);
    }
  }
  if (unknown_keys.length > 0 && Object.keys(update).length === 0 && stagingUrl === undefined) {
    // All keys were unknown — almost certainly a schema mistake (e.g. the
    // caller wrapped their fields in {"settings": {...}}). Return 400 so the
    // error is visible instead of silently saving nothing.
    return apiError(
      `No recognized fields in body. Unknown keys: ${unknown_keys.join(', ')}. ` +
      `Top-level fields: ${[...TOP_LEVEL, ...SITE_LEVEL].join(', ')}. ` +
      `Nested objects: ${[...NESTED].join(', ')}.`,
      400,
    );
  }
  if (Object.keys(update).length > 0) {
    await vstore.writeSettings(ctx.orgId, ctx.siteId, ctx.versionId, update as Partial<SiteSettings>);
  }
  if (stagingUrl !== undefined) {
    await getStore().updateDoc(paths.site(ctx.orgId, ctx.siteId), { staging_url: stagingUrl });
  }
  const resp: Record<string, unknown> = {
    ok: true,
    updated_fields: [...Object.keys(update), ...(stagingUrl !== undefined ? ['staging_url'] : [])],
  };
  const warnings: string[] = [];
  if (unknown_keys.length > 0) warnings.push(`Unrecognized keys were ignored: ${unknown_keys.join(', ')}`);
  // A palette change can make existing styles unreadable; say so instead of failing the palette write.
  if (update.colors) {
    const { styles, colors } = await readStyles(ctx);
    warnings.push(...libraryProblems(styles, colors).map(problem => `Style contrast with the new colours: ${problem}`));
  }
  warnings.push(...customCssWarnings(update.custom_css).map(problem => `Custom CSS line ${problem.line}: ${problem.message}`));
  if (warnings.length) resp.warnings = warnings;
  return apiResponse(ctx, resp, 200, body);
};
