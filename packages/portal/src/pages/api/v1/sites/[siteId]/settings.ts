// GET   /api/v1/sites/{siteId}/settings
// PATCH /api/v1/sites/{siteId}/settings
//
// PATCH whitelists the editable fields and accepts everything the portal's
// Settings form does (/api/sites/{siteId}/settings), with the same admin
// permission; a builder may change the design keys only. `scripts_head`, `scripts_body_end`, `custom_css` and the
// cookie-consent scripts are writable here: an authenticated API caller
// (Bearer token) takes responsibility for what they ship, exactly as a site
// admin does in the portal. The chat AI in lib/anthropic.ts does not expose
// these fields.
//
// `staging_url` is stored on the Site document, not in versioned settings, so
// a branch cannot reroute it; it is written the same way whichever `?version=`
// the request names. So is `form_submission_retention_days` (opt-in deletion
// of completed form submissions, lib/form-submissions), which only a site
// administrator may change and which applies to existing submissions at once.
//
// An Extension installation credential with `content:write` may change the
// presentational settings, but never the fields that run code on or change
// the indexing and origins of every published page: see INSTALLATION_REFUSED.
//
// `handover` (shared/src/site-handover.ts: checklist, start page, structure
// lock) is replaced whole, and null removes it; it needs design rights (an
// administrator or builder). An app installation writes it only with the
// `site:handover` scope, which reads the settings and writes that key alone.

import type { APIRoute } from 'astro';
import { apiCanDesign, apiError, apiResponse, requireApiKey } from '../../../../../lib/api-auth';
import { DESIGN_SETTINGS_KEYS } from '../../../../../lib/site-settings-sections';
import { vstore } from '../../../../../lib/version-store';
import { publicUrlsFor } from '../../../../../lib/site-public-urls';
import { libraryProblems, libraryWarnings, readStyles } from '../../../../../lib/site-styles-store';
import { customCssWarnings, customCssWriteError } from '../../../../../lib/custom-css-write';
import { getStore } from '../../../../../lib/datastore';
import { setSubmissionRetention, siteSubmissionRetentionDays, submissionRetentionError } from '../../../../../lib/form-submissions';
import { normalizeStagingUrl, normalizeTwitterHandle, parseOrganizationInput } from '../../../../../lib/site-settings-fields';
import { fontSettingsWarnings, listSiteFonts } from '../../../../../lib/fonts/font-library';
import { handoverWriteErrors, normalizedHandover } from '../../../../../lib/site-handover-write';
import { dateFormatError, siteTimeZone, timeZoneError, contentWidthsError, typographyError, designScalesError, responsiveBreakpointsError, seoReviewError, externalRoutesError, normalizeIframeAllowedHosts, renderVersionStatus, isRenderVersion, isFontSmoothing, FONT_SMOOTHING_VALUES, LATEST_RENDER_VERSION, paths, isOnColorValue, onColorContrasts, onColorWarnings, ON_COLOR_TOKENS, normalizeCookieConsentLabels, cookieConsentManageButtonError, cookieReopenLinkWarning, normalizeLanguageSections, isAiCrawlerPolicy, isHeaderBehavior, HEADER_BEHAVIORS, AI_CRAWLER_POLICIES, siteFontsErrors, type SiteSettings } from '@typeroll/shared';

const TOP_LEVEL = new Set([
  'typography', 'design_scales', 'agent_instructions', 'responsive_breakpoints', 'site_name', 'tagline', 'logo', 'favicon', 'apple_touch_icon', 'icon_192', 'trailing_slash', 'iframe_allowed_hosts', 'default_seo_suffix',
  'default_meta_description', 'language', 'robots_txt', 'ai_crawler_policy', 'header_behavior', 'date_format', 'time_zone', 'content_widths', 'motion', 'image_sizes_default',
  'sitewide_noindex', 'sitewide_nofollow', 'seo_review', 'external_routes', 'render_version',
  // Social sharing + Organization JSON-LD, as in the portal Settings form.
  'default_og_image', 'twitter_handle', 'organization',
  // Scriptable surfaces. Trusted because the caller has an API key.
  'scripts_head', 'scripts_body_end', 'custom_css',
  // Per-language home paths and wording for a one-site multilingual setup.
  'language_sections',
]);
/** Fields stored on the Site document rather than in versioned settings. */
const SITE_LEVEL = new Set(['staging_url', 'form_submission_retention_days']);
/** Optional string fields where an empty string clears the value. */
const CLEARABLE_STRINGS = ['default_og_image', 'twitter_handle'] as const;
const NESTED = new Set(['colors', 'fonts', 'contact', 'social', 'cookie_consent']);
/**
 * Settings an Extension installation credential may not change, whatever
 * scopes it holds. Scripts and CSS run on every published page; robots and
 * noindex decide whether the site is indexed; `staging_url` is an origin other
 * installations' tokens are bound to; iframe hosts and agent instructions
 * widen what the site embeds and what agents are told. These stay with the
 * site administrator.
 */
const INSTALLATION_REFUSED = new Set([
  'scripts_head', 'scripts_body_end', 'custom_css', 'robots_txt', 'ai_crawler_policy', 'sitewide_noindex', 'sitewide_nofollow',
  'staging_url', 'iframe_allowed_hosts', 'external_routes', 'render_version', 'agent_instructions',
  // Deletes visitors' submissions; a data-retention decision for the site's administrators.
  'form_submission_retention_days',
]);
const INSTALLATION_REFUSED_CONSENT = new Set(['scripts_necessary', 'scripts_optional']);
/** Font services load a stylesheet from another company's CDN on every page. */
const INSTALLATION_REFUSED_FONTS = new Set(['services']);

function installationRefusedFields(body: Record<string, unknown>): string[] {
  const refused = Object.keys(body).filter((key) => INSTALLATION_REFUSED.has(key));
  const consent = body.cookie_consent;
  if (consent && typeof consent === 'object' && !Array.isArray(consent)) {
    for (const key of Object.keys(consent)) if (INSTALLATION_REFUSED_CONSENT.has(key)) refused.push(`cookie_consent.${key}`);
  }
  const fonts = body.fonts;
  if (fonts && typeof fonts === 'object' && !Array.isArray(fonts)) {
    for (const key of Object.keys(fonts)) if (INSTALLATION_REFUSED_FONTS.has(key)) refused.push(`fonts.${key}`);
  }
  return refused;
}

const COOKIE_CONSENT_FIELDS = new Set([
  'enabled', 'text', 'privacy_policy_url', 'scripts_necessary',
  'scripts_optional', 'reload_after_consent', 'labels', 'manage_button',
]);

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const s = (await vstore.settings(ctx.orgId, ctx.siteId, ctx.versionId)) ?? {};
  // Return all fields, including scripts_* and custom_css. An authenticated
  // API caller authoring CSS/JS needs to read back what they wrote.
  return apiResponse(ctx, {
    settings: { ...s, form_submission_retention_days: siteSubmissionRetentionDays(ctx.site) },
    urls: publicUrlsFor(ctx.site),
    render: renderVersionStatus((s as SiteSettings).render_version),
  });
};

export const PATCH: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  // Same role as the portal Settings form, render-version and custom-CSS routes.
  // An installation credential reaches this route only with `content:write`
  // and is limited to the presentational fields below.
  // A builder (design without admin) changes the design keys only: colours,
  // fonts, typography, scales, widths, logo and icons, the Site CSS and the
  // render version (lib/site-settings-sections → DESIGN_SETTINGS_KEYS).
  if (ctx.permission !== 'admin' && !ctx.extensionIdentity && !apiCanDesign(ctx)) return apiError('Insufficient permission (admin required)', 403, ctx);
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return apiError('Invalid JSON body');
  if (ctx.extensionIdentity?.scope === 'site:handover') {
    // An app that hands sites over: the handover key and nothing else.
    const other = Object.keys(body).filter((key) => key !== 'handover');
    if (other.length || body.handover === undefined) return apiError(`The site:handover scope writes only the handover key${other.length ? `; refused: ${other.join(', ')}` : ''}`, 403, ctx);
  } else if (ctx.extensionIdentity && body.handover !== undefined && !ctx.extensionIdentity.scopes.includes('site:handover')) {
    return apiError('handover needs the site:handover scope', 403, ctx);
  }
  if (ctx.permission !== 'admin' && !ctx.extensionIdentity) {
    const notDesign = Object.keys(body).filter((key) => !DESIGN_SETTINGS_KEYS.has(key) && key !== 'handover');
    if (notDesign.length) return apiError(`These settings need admin permission on the site; a builder changes the design settings only: ${notDesign.join(', ')}`, 403, ctx);
  }
  if (ctx.extensionIdentity) {
    const refused = installationRefusedFields(body);
    if (refused.length > 0) {
      return apiError(`These settings require a site administrator and cannot be changed with an Extension credential: ${refused.join(', ')}`, 403, ctx);
    }
  }
  // The font plan is derived when a publication is frozen; a site never stores one.
  if (body.font_plan !== undefined) return apiError('font_plan is computed when a publication is frozen and cannot be set. Choose families with fonts.heading, fonts.body, fonts.mono, fonts.display and fonts.accent, and extra weights with fonts.load.', 400, ctx);
  if (body.agent_instructions !== undefined && (typeof body.agent_instructions !== 'string' || body.agent_instructions.length > 12000)) return apiError('agent_instructions must be text up to 12000 characters', 400);
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
  const retentionDays = body.form_submission_retention_days as number | null | undefined;
  if (retentionDays !== undefined) { const error = submissionRetentionError(retentionDays); if (error) return apiError(error, 400); }
  if (body.responsive_breakpoints !== undefined) { const error = responsiveBreakpointsError(body.responsive_breakpoints); if (error) return apiError(error, 400); }
  if (body.trailing_slash !== undefined && !['always', 'never', 'ignore'].includes(String(body.trailing_slash))) {
    return apiError('trailing_slash must be one of: always, never, ignore', 400);
  }
  if (body.ai_crawler_policy !== undefined && body.ai_crawler_policy !== null && !isAiCrawlerPolicy(body.ai_crawler_policy)) {
    return apiError(`ai_crawler_policy must be one of: ${AI_CRAWLER_POLICIES.join(', ')} (or null for the default, allow_all)`, 400);
  }
  if (body.header_behavior !== undefined && body.header_behavior !== null && !isHeaderBehavior(body.header_behavior)) {
    return apiError(`header_behavior must be one of: ${HEADER_BEHAVIORS.join(', ')} (or null for the default, static)`, 400);
  }
  if (body.date_format !== undefined && body.date_format !== null) { const error = dateFormatError(body.date_format); if (error) return apiError(error, 400); }
  if (body.time_zone !== undefined && body.time_zone !== null) { const error = timeZoneError(body.time_zone); if (error) return apiError(error, 400); }
  if (body.motion !== undefined && body.motion !== null && body.motion !== 'full' && body.motion !== 'reduced') return apiError('motion must be "full" or "reduced"', 400);
  if (body.content_widths !== undefined && body.content_widths !== null) { const error = contentWidthsError(body.content_widths); if (error) return apiError(error, 400); }
  if (body.sitewide_noindex !== undefined && typeof body.sitewide_noindex !== 'boolean') {
    return apiError('sitewide_noindex must be boolean', 400);
  }
  if (body.sitewide_nofollow !== undefined && typeof body.sitewide_nofollow !== 'boolean') return apiError('sitewide_nofollow must be boolean', 400);
  if (body.external_routes !== undefined) { const error = externalRoutesError(body.external_routes); if (error) return apiError(error, 400); }
  if (body.seo_review !== undefined) { const error = seoReviewError(body.seo_review); if (error) return apiError(error, 400); }
  if (body.render_version !== undefined && !isRenderVersion(body.render_version)) {
    return apiError(`render_version must be an integer from 1 to ${LATEST_RENDER_VERSION}`, 400);
  }
  if (body.typography !== undefined) { const error = typographyError(body.typography); if (error) return apiError(error, 400); }
  if (body.design_scales !== undefined) { const error = designScalesError(body.design_scales); if (error) return apiError(error, 400); }
  if (body.fonts !== undefined) {
    if (!body.fonts || typeof body.fonts !== 'object' || Array.isArray(body.fonts)) return apiError('fonts must be an object', 400);
    const fonts = body.fonts as Record<string, unknown>;
    if (fonts.size_base !== undefined && (typeof fonts.size_base !== 'number' || !Number.isFinite(fonts.size_base) || fonts.size_base < 12 || fonts.size_base > 24)) return apiError('fonts.size_base must be a number from 12 to 24', 400);
    // null clears the choice back to the render version's default.
    if (fonts.smoothing !== undefined && fonts.smoothing !== null && !isFontSmoothing(fonts.smoothing)) {
      return apiError(`fonts.smoothing must be one of: ${FONT_SMOOTHING_VALUES.join(', ')} (or null to use the default)`, 400);
    }
    if (fonts.delivery !== undefined && fonts.delivery !== null && fonts.delivery !== 'self_hosted' && fonts.delivery !== 'google') {
      return apiError('fonts.delivery must be "self_hosted" (font files copied to the site, the default) or "google" (Google Fonts CDN), or null for the default', 400);
    }
    // Roles, fonts.load and fonts.services. The patch replaces each key it
    // names (null clears mono, display, accent, load and services), so the
    // merged fonts are valid exactly when the keys sent are.
    const fontErrors = siteFontsErrors(fonts);
    if (fontErrors.length) return apiError(fontErrors.join('; '), 400, ctx, { details: { errors: fontErrors } });
  }
  if (body.colors !== undefined) {
    if (!body.colors || typeof body.colors !== 'object' || Array.isArray(body.colors)) return apiError('colors must be an object', 400);
    for (const [key, value] of Object.entries(body.colors as Record<string, unknown>)) {
      if ((ON_COLOR_TOKENS as readonly string[]).includes(key)) {
        // null clears the choice back to the automatic black or white.
        if (value !== null && !isOnColorValue(value)) return apiError(`colors.${key} must be a hex colour such as "#ffffff" (#rgb or #rrggbb), or null for the automatic choice`, 400);
      } else if (key === 'surface_hover') {
        if (value !== null && !isOnColorValue(value)) return apiError('colors.surface_hover must be a hex colour, or null for the derived shade', 400);
      } else if (value === null) {
        return apiError(`colors.${key} cannot be cleared; only on_primary, on_secondary and on_accent are optional`, 400);
      }
    }
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
    { const error = cookieConsentManageButtonError(consent.manage_button); if (error) return apiError(error, 400); }
    if (consent.labels !== undefined) {
      const checked = normalizeCookieConsentLabels(consent.labels);
      if (checked.error) return apiError(checked.error, 400);
      consent.labels = checked.labels;
    }
  }

  if (body.handover !== undefined) {
    const errors = await handoverWriteErrors(ctx, body.handover);
    if (errors.length) return apiError(errors.join('; '), 400, ctx, { details: { errors } });
  }

  const existing = ((await vstore.settings(ctx.orgId, ctx.siteId, ctx.versionId)) ?? {}) as Record<string, unknown>;
  if (body.language_sections !== undefined) {
    const siteLanguage = typeof body.language === 'string' ? body.language : existing.language as string | undefined;
    const checked = normalizeLanguageSections(body.language_sections, siteLanguage);
    if (checked.error) return apiError(checked.error, 400);
    body.language_sections = checked.sections?.length ? checked.sections : null;
  }
  const update: Record<string, unknown> = {};
  const unknown_keys: string[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined) continue;
    // Replaced whole (not merged like fonts); null removes it.
    if (k === 'handover') { update.handover = normalizedHandover(v); continue; }
    if (NESTED.has(k) && v && typeof v === 'object') {
      // For contact specifically, the `address` field accepts either a
      // string (legacy) or a PostalAddress object. We pass whatever the
      // caller sent — the renderer + JSON-LD generator branch on the type.
      const before = (existing[k] as Record<string, unknown> | undefined) ?? {};
      update[k] = { ...before, ...(v as Record<string, unknown>) };
      // null removes an optional nested value (fonts.smoothing, colors.on_*) instead of storing null.
      // So does cookie_consent.manage_button, which then shows the floating button again.
      for (const [field, value] of Object.entries(update[k] as Record<string, unknown>)) if (value === null && (k === 'fonts' || k === 'colors' || (k === 'cookie_consent' && field === 'manage_button'))) delete (update[k] as Record<string, unknown>)[field];
    } else if (TOP_LEVEL.has(k)) {
      // null clears an optional field; the store drops undefined values.
      // A site always has a time zone: null resets it to the usual one for its language.
      if (k === 'time_zone' && v === null) { update[k] = siteTimeZone({ language: body.language ?? existing.language }); continue; }
      update[k] = v === null && (CLEARABLE_STRINGS as readonly string[]).concat('organization', 'language_sections', 'ai_crawler_policy', 'header_behavior', 'date_format', 'content_widths', 'motion').includes(k) || (k === 'motion' && v === 'full') ? undefined : v;
    } else if (SITE_LEVEL.has(k)) {
      continue;
    } else {
      unknown_keys.push(k);
    }
  }
  if (unknown_keys.length > 0 && Object.keys(update).length === 0 && stagingUrl === undefined && retentionDays === undefined) {
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
  const retention = retentionDays === undefined ? undefined : await setSubmissionRetention(ctx.orgId, ctx.siteId, retentionDays);
  const resp: Record<string, unknown> = {
    ok: true,
    updated_fields: [
      ...Object.keys(update),
      ...(stagingUrl !== undefined ? ['staging_url'] : []),
      ...(retention ? ['form_submission_retention_days'] : []),
    ],
  };
  if (retention) resp.form_submission_retention = retention;
  const warnings: string[] = [];
  if (unknown_keys.length > 0) warnings.push(`Unrecognized keys were ignored: ${unknown_keys.join(', ')}`);
  // A palette or render version change can make existing styles unreadable
  // (the render version picks the automatic on_* colours); say so instead of
  // failing the write. An explicit on_* colour is kept even when it is hard to
  // read: it is the site's choice, reported with both measures.
  if (update.colors || update.render_version !== undefined) {
    const { styles, colors, renderVersion, registry } = await readStyles(ctx);
    warnings.push(...onColorWarnings(colors, renderVersion));
    warnings.push(...libraryProblems(styles, colors, renderVersion, registry).map(problem => `Style contrast with the new colours: ${problem}`));
    warnings.push(...libraryWarnings(styles, colors, renderVersion, registry).map(note => `Style readability: ${note}`));
    resp.on_colors = onColorContrasts(colors, renderVersion).map(item => ({
      token: item.token, color: item.text, background: item.background, explicit: item.explicit,
      apca_lc: Math.round(item.lc * 10) / 10, wcag_ratio: Math.round(item.wcag * 100) / 100,
      button_text_ok: item.apca_pass,
    }));
  }
  if (update.fonts) warnings.push(...fontSettingsWarnings(update.fonts as SiteSettings['fonts'], await listSiteFonts(ctx.orgId, ctx.siteId)));
  warnings.push(...customCssWarnings(update.custom_css).map(problem => `Custom CSS line ${problem.line}: ${problem.message}`));
  // A banner without the floating button needs a reopen link somewhere visitors find it.
  if (update.cookie_consent) {
    const reopen = await cookieReopenLinkWarningFor(ctx, update.cookie_consent as SiteSettings['cookie_consent']);
    if (reopen) warnings.push(reopen);
  }
  if (warnings.length) resp.warnings = warnings;
  return apiResponse(ctx, resp, 200, body);
};

/** The cookie_reopen_link_missing warning, checked against the version's partials and menus. */
async function cookieReopenLinkWarningFor(ctx: { orgId: string; siteId: string; versionId: string }, consent: SiteSettings['cookie_consent']): Promise<string | null> {
  if (!cookieReopenLinkWarning(consent, [])) return null;
  try {
    const [partials, menus] = await Promise.all([
      vstore.partials(ctx.orgId, ctx.siteId, ctx.versionId),
      vstore.menus(ctx.orgId, ctx.siteId, ctx.versionId),
    ]);
    return cookieReopenLinkWarning(consent, [...partials, ...menus]);
  } catch {
    // Unknown partials or menus: no warning rather than a false one.
    return null;
  }
}
